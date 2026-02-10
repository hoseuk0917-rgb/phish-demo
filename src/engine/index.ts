/// src/engine/index.ts — FULL UPDATED (SWAP-IN)
import type {
  AnalysisInput,
  AnalysisResult,
  EvidenceItem,
  HitItem,
  RiskLevel,
  SignalSummary,
  StageEvent,
  StageId,
} from "../types/analysis";
import { normalizeText } from "./extract/normalize";
import { splitThread, splitThreadWithRanges, type SplitThreadOptions } from "./extract/splitThread";
import { scoreThread } from "./scoring/scoreThread";
import { buildEvidenceTop3 } from "./report/buildEvidence";
import { buildPackageText } from "./report/buildPackage";
import { buildDefaultActions } from "../data/actions";
import type { SimIndexItem } from "./similarity/simIndex";
import { applySimilarityFromSignals } from "./similarity/applySimilarity";

// ✅ semantic embedding (sentence embedding 후보)
import type { SemIndexItem } from "./semantic/semIndex";
import { applySemanticFromVec } from "./semantic/applySemanticSimilarity";

// ✅ add (prefilter)
import { prefilterThread, type PrefilterOptions } from "./prefilter/prefilter";

const STAGE_RANK: Record<StageId, number> = {
  info: 0,
  verify: 1,
  install: 2,
  payment: 3,
};

function extractUrls(text: string): string[] {
  const t = String(text || "").replace(/\r\n/g, "\n");

  // 1) scheme 포함 URL
  const urlHits = t.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) || [];

  // 2) www.* (scheme 없는 케이스)
  const wwwHits = t.match(/\bwww\.[^\s<>"')\]]+/gi) || [];

  // 3) bare domain (example.com)
  const domHits =
    t.match(/\b[a-zA-Z][a-zA-Z0-9-]{0,61}(?:\.[a-zA-Z0-9-]{1,63})+\b/g) || [];

  const cleanup = (raw: string): string => {
    let s = String(raw || "").trim();
    // 뒤에 붙는 닫는 괄호/구두점 제거
    s = s.replace(/[),.;:'"\]]+$/g, "");
    // 앞에 붙는 괄호/따옴표 제거
    s = s.replace(/^[("'[\s]+/g, "");
    return s.trim();
  };

  const all = [...urlHits, ...wwwHits, ...domHits].map(cleanup).filter(Boolean);

  const uniq = Array.from(new Set(all));
  return uniq.slice(0, 30);
}

function extractSenderOnlyText(thread: string): string {
  const t = String(thread || "").replace(/\r\n/g, "\n");
  const lines = t.split("\n");

  const sLines = lines
    .map((l) => {
      const m = l.match(/^\s*S\s*:\s*(.*)$/i);
      return m ? String(m[1] || "").trim() : "";
    })
    .filter(Boolean);

  // S: 라인이 있으면 S만, 없으면 전체(레거시/무라벨 케이스)
  return sLines.length > 0 ? sLines.join("\n") : t;
}

function buildStageTimeline(messageSummaries: AnalysisResult["messageSummaries"]): StageEvent[] {
  if (!messageSummaries || messageSummaries.length === 0) return [];

  const events: StageEvent[] = [];
  let current: StageId = "info";

  const first = messageSummaries[0];
  current = first.stage;
  events.push({
    blockIndex: first.index,
    stage: first.stage,
    score: first.score,
    triggers: first.stageTriggers,
    preview: first.preview,
  });

  for (const m of messageSummaries.slice(1)) {
    const next = m.stage;
    if (STAGE_RANK[next] > STAGE_RANK[current]) {
      events.push({
        blockIndex: m.index,
        stage: next,
        score: m.score,
        triggers: m.stageTriggers,
        preview: m.preview,
      });
      current = next;
    }
  }

  return events.slice(0, 8);
}

export type AnalyzeThreadOptions = {
  weights?: Partial<Record<string, number>>;
  thresholds?: Partial<{ medium: number; high: number }>;

  // ✅ optional: prefilter options (demo/debug)
  prefilter?: Partial<PrefilterOptions> & { enabled?: boolean };

  // ✅ optional: turn split options (raw 유지 + split에만 반영)
  turnSplit?: Partial<SplitThreadOptions> & { enabled?: boolean };

  // ✅ similarity (simindex)
  simIndexItems?: SimIndexItem[];
  simTopK?: number;
  simMinSim?: number; // ✅ gate (boost만)

  // ✅ semantic embedding (sentence embedding index) — 후보용(점수/리스크 반영 X)
  semIndexItems?: SemIndexItem[];
  semQueryVec?: number[]; // 호출자가 미리 만든 임베딩 벡터
  semTopK?: number;
  semMinSim?: number;
};

export function analyzeThread(input: AnalysisInput, opts?: AnalyzeThreadOptions): AnalysisResult {
  const anyIn: any = input as any;

  // ✅ 입력 호환: threadText(정식) + thread(레거시/CLI) + threadBlocks(배열)
  const rawInput =
    typeof anyIn?.threadText === "string"
      ? String(anyIn.threadText)
      : typeof anyIn?.thread === "string"
        ? String(anyIn.thread)
        : Array.isArray(anyIn?.threadBlocks)
          ? (anyIn.threadBlocks as any[]).map((x) => String(x ?? "")).join("\n")
          : "";

  // ✅ (1) 줄바꿈 정규화는 여기서 1번만
  const rawText = String(rawInput || "").replace(/\r\n/g, "\n");

  // ✅ prefilter: 가볍게 먼저(디버그/데모용으로 결과에 붙임)
  const pfEnabled = opts?.prefilter?.enabled ?? true;

  // ✅ Threat 정책과 동일하게: prefilter도 S 텍스트 기준으로만
  const prefilterInputText = extractSenderOnlyText(rawText);

  // ✅ S(발신) 기준 URL 존재는 “검증/개입 표시” 보장용(점수 가산 X)
  const senderUrlsAll = extractUrls(prefilterInputText);
  const hasSenderUrl = senderUrlsAll.length > 0;

  const prefilter = pfEnabled ? prefilterThread(prefilterInputText, opts?.prefilter) : undefined;

  // ✅ (2) trigIds/regex 매치 원인 추적용: prefilter에 debugLines/debugText 부착
  if (prefilter && typeof prefilter === "object") {
    const pfAny: any = prefilter as any;
    if (!Array.isArray(pfAny.debugLines)) {
      const sigs: any[] = Array.isArray(pfAny.signals) ? pfAny.signals : [];
      const lines = sigs.slice(0, 24).map((s) => {
        const id = String(s?.id ?? s?.ruleId ?? "").trim();
        const label = String(s?.label ?? "").trim();
        const pts = Number(s?.points ?? s?.score ?? s?.weight ?? 0);

        const ev = s?.evidence;
        let snippet = "";
        if (typeof s?.sample === "string") snippet = s.sample;
        else if (typeof ev === "string") snippet = ev;
        else if (typeof ev?.text === "string") snippet = ev.text;
        else if (Array.isArray(ev) && ev.length) snippet = String(ev[0]?.text ?? ev[0] ?? "");
        else if (Array.isArray(s?.matched) && s.matched.length) snippet = String(s.matched[0] ?? "");

        snippet = String(snippet || "").replace(/\s+/g, " ").trim();
        if (snippet.length > 90) snippet = snippet.slice(0, 90) + "…";

        const ptsPart = Number.isFinite(pts) && pts !== 0 ? ` pts=${pts}` : "";
        const head = `${id}${label ? ` · ${label}` : ""}${ptsPart}`;
        return snippet ? `${head} · "${snippet}"` : head;
      });

      pfAny.debugLines = lines;
      pfAny.debugText = lines.join("\n");
    }
  }

  const turnSplitEnabled = opts?.turnSplit ? (opts.turnSplit.enabled ?? true) : false;

  let messages: string[] = [];

  if (turnSplitEnabled) {
    // ✅ rawText는 이미 \r\n 정규화됨
    const thread = rawText;
    const turnSplit: SplitThreadOptions = {
      turnPrefixMode: opts?.turnSplit?.turnPrefixMode,
      autoPrefixMode: opts?.turnSplit?.autoPrefixMode,
      defaultWho: opts?.turnSplit?.defaultWho,
    };

    const blocks = splitThreadWithRanges(thread, turnSplit);
    messages = blocks.map((b) => normalizeText(b.text));
  } else {
    const normThread = normalizeText(rawText);
    messages = splitThread(normThread);
  }

  const scored = scoreThread(messages, input.callChecks, opts);

  const evidenceTop3: EvidenceItem[] = buildEvidenceTop3(scored.hits);

  // ⚠️ scored.signals를 in-place sort 하지 않도록 복사
  let signalsTop: SignalSummary[] = [...scored.signals]
    .sort((a: any, b: any) => {
      const aw = Number(a?.weightSum ?? a?.weight ?? 0);
      const bw = Number(b?.weightSum ?? b?.weight ?? 0);
      return bw - aw;
    })
    .slice(0, 8);

  // ✅ URL 존재는 “점수/리스크”가 아니라 “검증 필요” 컨텍스트로만 노출
  if (hasSenderUrl) {
    const urlHint: SignalSummary = {
      id: "ctx_url_present_sender",
      label: "S: URL/도메인 포함",
      weightSum: 0,
      count: 1,
      examples: senderUrlsAll.slice(0, 3),
      stage: "verify",
    };
    signalsTop = [urlHint, ...signalsTop].slice(0, 8);
  }

  let riskLevel: RiskLevel = scored.riskLevel;
  let scoreTotal = scored.scoreTotal;

  // R(수신자) 텍스트는 Threat 점수(=S 기반)에는 섞지 않고,
  // "개입 타이밍(UI)"만 강화한다. (게이트: canUiBump)
  const rGate = (() => {
    const anyIn2: any = input as any;

    const rawForRGate =
      typeof anyIn2?.threadText === "string"
        ? String(anyIn2.threadText)
        : typeof anyIn2?.thread === "string"
          ? String(anyIn2.thread)
          : Array.isArray(anyIn2?.threadBlocks)
            ? (anyIn2.threadBlocks as any[]).map((x: any) => String(x ?? "")).join("\n")
            : "";

    const thread = String(rawForRGate || "").replace(/\r\n/g, "\n");
    if (!thread.trim()) return { tag: "", incidentFloor: 0 };

    const rText = thread
      .split("\n")
      .map((l) => {
        const m = l.match(/^\s*R\s*:\s*(.*)$/i);
        return m ? String(m[1] || "").trim() : "";
      })
      .filter(Boolean)
      .join(" ")
      .trim();

    if (!rText) return { tag: "", incidentFloor: 0 };

    // 공통 토큰(완전 일반형 의지)
    const willIntent = /(할게|할게요|할께|할께요|하겠|하겠습니다|하겠어요|하려|할\s*거|할거|할\s*겁|할겁|해\s*둘게|해둘게)/i;

    // ✅ 방문/이동 의지(“갈게요/가겠습니다/가볼게요” 류)
    const willGoIntent =
      /(갈게|갈게요|갈께|갈께요|가겠|가겠습니다|가겠어요|가\s*볼게|가볼게|가\s*볼게요|가볼게요|가\s*보겠|가보겠|갈\s*거|갈거|갈\s*겁|갈겁)/i;

    const placeToken = /(은행|atm|현금\s*인출기|편의점|매장|지점|지사|센터|창구|카운터|현장|대리점)/i;

    // 상품권/핀(=비가역 자산 전송 취급)
    const giftPinToken = /(상품권|기프트\s*카드|기프티콘|쿠폰|핀\s*번호|pin\s*code|pincode)/i;

    // "이미 실행" (Incident)
    const didPayCore = /(송금했|이체했|입금했|결제했|지불했|충전했)/i.test(rText);

    const didGiftPin = giftPinToken.test(rText) && /(보냈|전달|말했|알려|줬|보내드렸|전송했)/i.test(rText);

    const didInstall =
      /(설치했|다운받|다운로드했|깔았|원격(으로)?\s*해줬|팀뷰어|teamviewer|anydesk|애니데스크|퀵서포트|quicksupport)/i.test(rText);

    const didOtpShare =
      /(인증번호|otp|오티피|보안\s*코드|확인\s*코드|ars)/i.test(rText) &&
      /(보냈|전달|말했|알려|불러|읽어|입력했)/i.test(rText);

    // 저항/중단(우선)
    const resist = /(안\s*할게|거절|차단했|신고했|무시했|끊었|삭제했|거래\s*중단|취소했)/i.test(rText);

    // 의도(Will) — r:will:*
    const payVerb = /(송금|이체|입금|결제|지불|충전)/i;
    const moneyCtx = /(돈|원|계좌|입금|송금|이체|결제|지불|충전|카드|상품권|기프트|기프티콘|쿠폰|핀\s*번호|pin)/i;

    // ✅ “보낼게요/보내겠습니다” 자체가 의지 표현이라 willIntent를 요구하지 않는다
    const sendVerb =
      /(보내겠|보낼|보내겠습니다|보낼게|보낼게요|보내\s*드릴|보내줄|전달(하겠|할)|전달하겠습니다|전송(하겠|할)|전송하겠습니다)/i;

    const willPay =
      (payVerb.test(rText) && willIntent.test(rText)) ||
      (sendVerb.test(rText) && moneyCtx.test(rText)) ||
      (sendVerb.test(rText) && giftPinToken.test(rText));

    const installToken =
      /(설치|다운\s*받|다운받|다운로드|깔|원격|팀뷰어|teamviewer|anydesk|애니데스크|퀵서포트|quicksupport)/i;

    // ✅ “다운받을게요/깔게요/설치할게요”도 포착
    const willInstallIntent =
      willIntent.test(rText) ||
      /(받을게|받을게요|깔게|깔게요|설치할게|설치할게요|다운받을게|다운받을게요|다운로드할게|다운로드할게요|해볼게|해볼게요|해보겠|해보겠습니다)/i.test(
        rText
      );

    const willInstall =
      installToken.test(rText) &&
      willInstallIntent &&
      (/(설치|다운\s*받|다운받|다운로드|깔)/i.test(rText) ||
        /(원격(으로)?\s*(해|해드|해줄)|연결(할|해줄)|접속(할|해볼))/i.test(rText) ||
        /(팀뷰어|teamviewer|anydesk|애니데스크|퀵서포트|quicksupport)/i.test(rText));

    const willOtp =
      /(인증번호|otp|오티피|보안\s*코드|확인\s*코드|ars)/i.test(rText) &&
      /(보낼게|보내겠|보내겠습니다|전달(할게|하겠)|말해(줄게|드릴게)|알려(줄게|드릴게)|불러(줄게|드릴게)|읽어(줄게|드릴게)|입력(할게|하겠))/i.test(
        rText
      );

    // ✅ 방문/이동: (장소 토큰) + (갈게요 류 OR 방문/이동 하겠류)
    const willVisit =
      placeToken.test(rText) &&
      (willGoIntent.test(rText) || (willIntent.test(rText) && /(방문|이동)/i.test(rText)));

    // 상담/확인/의심
    const ask = /(맞나|사기|스캠|피싱|도와(줘|주세요)|확인(해줘|해주세요)|이거\s*뭐야|진짜야)/i.test(rText);

    // "이미 실행"은 incident floor로 강제 상향
    if (didPayCore || didGiftPin) return { tag: "r:done:pay", incidentFloor: 80 };
    if (didInstall) return { tag: "r:done:install", incidentFloor: 70 };
    if (didOtpShare) return { tag: "r:done:otp", incidentFloor: 65 };

    if (resist) return { tag: "r:resist", incidentFloor: 0 };

    if (willPay) return { tag: "r:will:pay", incidentFloor: 0 };
    if (willInstall) return { tag: "r:will:install", incidentFloor: 0 };
    if (willOtp) return { tag: "r:will:otp", incidentFloor: 0 };
    if (willVisit) return { tag: "r:will:visit", incidentFloor: 0 };

    if (ask) return { tag: "r:ask", incidentFloor: 0 };

    // 기타 '이미 했다' 느낌(클릭/열람 등)은 incident로 올리지 않음
    const already = /(눌렀|열었|접속했|들어갔|연결했|입력했|보냈)/i.test(rText);
    if (already) return { tag: "r:already", incidentFloor: 0 };

    return { tag: "", incidentFloor: 0 };
  })();

  const rGateTag = rGate.tag;

  const thrMed = opts?.thresholds?.medium ?? 35;
  const thrHigh = opts?.thresholds?.high ?? 65;

  // ✅ 행동앵커 셋: canUiBump / SIM boost가 같은 리스트를 공유
  const hasActionAnchorByHits = (hasHit: (id: string) => boolean) => {
    return (
      hasHit("link") ||
      hasHit("shortener") ||
      hasHit("otp") ||
      hasHit("call_otp") ||
      hasHit("ctx_otp_relay") ||
      hasHit("ctx_otp_finance") ||
      hasHit("ctx_otp_finance_relay") ||
      hasHit("transfer") ||
      hasHit("safe_account") ||
      hasHit("ctx_payment_request") ||
      hasHit("ctx_transfer_phrase") ||
      hasHit("giftcard") ||
      hasHit("ctx_giftcard") ||
      hasHit("go_bank_atm") ||
      hasHit("visit_place") ||
      hasHit("ctx_visit_place") ||
      hasHit("remote") ||
      hasHit("call_remote") ||
      hasHit("install_app") ||
      hasHit("apk") ||
      hasHit("url_download_ext") ||
      hasHit("ctx_install_mention") ||
      hasHit("threat")
    );
  };

  // ✅ prefilter triggered 판정(중복 방지: canUiBump / triggered 둘 다 동일 로직 사용)
  const isPrefilterTriggered = (pf: any): boolean => {
    if (!pf) return false;

    // 1) 명시 플래그 최우선
    if (typeof pf.triggered === "boolean") return pf.triggered;
    if (typeof pf.isTriggered === "boolean") return pf.isTriggered;

    // 2) should_trigger(신/구)
    const shouldA = Array.isArray(pf.should_trigger) ? pf.should_trigger : null;
    const shouldB = Array.isArray(pf.shouldTrigger) ? pf.shouldTrigger : null;
    if ((shouldA && shouldA.length) || (shouldB && shouldB.length)) return true;

    // 3) action
    const action = String(pf.action ?? "").toLowerCase().trim();
    if (action && action !== "none") return true;

    // 4) score/threshold
    const score = Number(pf.score);
    const soft = Number(pf.thresholdSoft);
    const auto = Number(pf.thresholdAuto);

    if (Number.isFinite(score) && Number.isFinite(soft)) return score >= soft;
    if (Number.isFinite(score) && !Number.isFinite(soft) && Number.isFinite(auto)) return score >= auto;

    // score가 있는데 threshold가 없거나 비교 불가면 false(보수)
    if (Number.isFinite(score)) return false;

    // 5) score가 없는 형태에서만 보조 판정
    if (Array.isArray(pf.triggers) && pf.triggers.length) return true;
    if (Array.isArray(pf.hitRules) && pf.hitRules.length) return true;

    if (typeof pf.gatePass === "boolean") return pf.gatePass;

    return false;
  };

  const pfTriggered = isPrefilterTriggered(prefilter as any);

  const hasHit = (id: string) => scored.hits.some((h) => String(h?.ruleId || "") === id);
  const hasActionAnchor = hasActionAnchorByHits(hasHit);

  // ✅ 1) 개입(표시) 게이트: R쪽 신호(rGateTag) 있으면 “빨리 뜨게”
  //    - r:already 는 굳이 강한 개입으로 보지 않으면 제외
  const hasInterventionTag = !!(rGateTag && rGateTag !== "r:already");

  const canShowIntervention =
    Number(rGate.incidentFloor || 0) > 0 ||
    hasInterventionTag ||
    pfTriggered ||
    hasSenderUrl ||
    scoreTotal >= thrMed ||
    hasActionAnchor;

  // ✅ 2) 점수(막대) 게이트: Threat가 실제 위험할 때만
  //    - pfTriggered만으로는 절대 uiScoreTotal 올리지 않음
  const canUiScoreBump = Number(rGate.incidentFloor || 0) > 0 || scoreTotal >= thrMed || hasActionAnchor;

  // ✅ rSoftBoost: “개입 강도” 신호를 점수에 섞는 건 canUiScoreBump일 때만
  const rSoftBoost = (() => {
    if (!canUiScoreBump) return 0;
    if (rGateTag === "r:will:pay") return 16;
    if (rGateTag === "r:will:install") return 12;
    if (rGateTag === "r:will:otp") return 10;
    if (rGateTag === "r:will:visit") return 8;
    if (rGateTag === "r:ask") return 1;
    return 0;
  })();

  // ✅ incidentFloor: “이미 실행”은 항상 강제 상향(표시/점수 둘 다)
  const incidentFloor = Number(rGate.incidentFloor || 0);

  // ✅ UI 점수(막대): Threat 점수는 유지, incident만 강제 floor + (조건부 rSoftBoost)
  const uiScoreTotal = Math.max(0, Math.min(100, Math.max(scoreTotal + rSoftBoost, incidentFloor)));

  // ✅ UI 라벨: Threat 라벨 유지, incident만 high로
  const uiRiskLevel: RiskLevel = incidentFloor >= thrHigh ? "high" : riskLevel;

  const actions = buildDefaultActions();

  const hitsTop: HitItem[] = scored.hits.slice(0, 30).map((h) => ({
    ruleId: h.ruleId,
    label: h.label,
    stage: h.stage,
    weight: h.weight,
    matched: h.matched,
    sample: h.sample,
  }));

  // ✅ URL은 S(발신) 텍스트에서만 뽑기 (R 인용/복붙/클릭으로 동작하지 않게)
  const urls = senderUrlsAll;

  const stageTimeline = buildStageTimeline(scored.messageSummaries);

  // =========================
  // ✅ SIM: 후보는 항상(0) 뽑고, gate(simMinSim)는 boost에만 적용
  // =========================
  const simGate = opts?.simMinSim ?? 0.9;

  const simIndexItems: SimIndexItem[] = Array.isArray(opts?.simIndexItems) ? (opts!.simIndexItems as SimIndexItem[]) : [];

  const similarityTopRaw =
    simIndexItems.length > 0
      ? applySimilarityFromSignals(scored.signals, simIndexItems, {
        topK: opts?.simTopK ?? 10,
        minSim: 0, // ✅ 후보는 항상 뽑기(설명/디버그)
      })
      : [];

  // ✅ 반환 필드는 “후보(원본)”을 유지: 이유 확인(0.899 vs gate 0.9) 가능
  const similarityTop = similarityTopRaw;

  // ✅ 본분석 “소프트 부스트” (SIM은 점수만 소폭, 리스크는 여기서 올리지 않음)
  if (similarityTopRaw && (similarityTopRaw as any[]).length) {
    const top: any = (similarityTopRaw as any[])[0];
    const sim = Number(top?.similarity ?? 0);

    // anchors: SIM은 "행동 유도"가 있을 때만 점수에 반영 (권위/알림만으론 반영 금지)
    const hasHit = (id: string) => scored.hits.some((h) => String(h?.ruleId || "") === id);

    const hasActionAnchor = hasActionAnchorByHits(hasHit);

    // score-only boost (cap). sim 스케일(0~1)에 맞춰 동작
    let boost = 0;
    if (sim >= 0.96) boost = 10;
    else if (sim >= 0.93) boost = 8;
    else if (sim >= 0.9) boost = 6;
    else if (sim >= 0.87) boost = 4;

    const gatePass = sim >= simGate;
    const appliedBoost = boost > 0 && gatePass && hasActionAnchor ? boost : 0;
    if (appliedBoost > 0) scoreTotal = Math.min(100, scoreTotal + appliedBoost);

    // ✅ signalsTop에 “유사도 힌트” (타입 필수필드 포함)
    const ex: string[] = [
      `sim=${sim.toFixed(3)}`,
      `gate=${Number(simGate).toFixed(3)}`,
      `gatePass=${gatePass ? "yes" : "no"}`,
      `match=${String(top?.id || "").trim() || "n/a"}`,
      `cat=${String(top?.category || "").trim() || "n/a"}`,
      `boost=${appliedBoost > 0 ? `+${appliedBoost}` : "0"}`,
      `anchor=${hasActionAnchor ? "yes" : "no"}`,
    ];

    if (Array.isArray(top?.sharedSignals) && top.sharedSignals.length) {
      for (const s of top.sharedSignals.slice(0, 3)) ex.push(`shared:${String(s)}`);
    }

    const hint: SignalSummary = {
      id: "sim_hint",
      label: appliedBoost > 0 ? "SIM hint (soft boost)" : "SIM hint (no boost)",
      weightSum: appliedBoost,
      count: 1,
      examples: ex,
      stage: "verify",
    };

    signalsTop = [hint, ...signalsTop].slice(0, 8);
  }

  // =========================
  // ✅ SEMANTIC: 문장 임베딩 후보 top-k (점수/리스크 반영 X)
  // - 엔진은 "벡터 기반 랭킹"만 한다 (임베딩 생성은 UI/호출자)
  // =========================
  const semIndexItems: SemIndexItem[] = Array.isArray(opts?.semIndexItems) ? (opts!.semIndexItems as SemIndexItem[]) : [];
  const semQueryVec = (opts as any)?.semQueryVec;

  const semanticTopRaw =
    semIndexItems.length > 0 && Array.isArray(semQueryVec) && (semQueryVec as any[]).length > 0
      ? applySemanticFromVec(semQueryVec, semIndexItems, {
        topK: opts?.semTopK ?? 8,
        minSim: opts?.semMinSim ?? 0,
      })
      : [];

  const semanticTop = semanticTopRaw;

  const packageText = buildPackageText({
    riskLevel,
    scoreTotal,
    messageCount: messages.length,
    evidenceTop3,
    signalsTop,
    actions,
  });

  return {
    riskLevel,
    scoreTotal, // [OK] 부스트 반영값 반환

    // UI용(개입 타이밍/긴급도) 표시 — Threat 결과는 유지, 표시만 약하게 상향
    uiRiskLevel,
    uiScoreTotal,
    rGateTag: canShowIntervention && rGateTag ? rGateTag : undefined,

    // stage
    stagePeak: scored.stagePeak,
    stageTriggers: scored.stageTriggers,

    messageCount: messages.length,
    evidenceTop3,
    signalsTop,
    actions,
    packageText,
    hitsTop,
    urls,
    messageSummaries: scored.messageSummaries,
    stageTimeline,
    prefilter,
    similarityTop, // [OK] 후보(원본) 반환

    // ✅ semantic embedding 후보(점수/리스크 반영 X)
    semanticTop: semanticTop && (semanticTop as any[]).length ? semanticTop : undefined,

    // [OK] triggered: prefilter 기준 + URL(S) 보장
    triggered: prefilter
      ? (pfTriggered || hasSenderUrl)
      : ((scored.hits?.length ?? 0) > 0 || hasSenderUrl),
  };
}
