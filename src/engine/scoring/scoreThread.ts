// src/engine/scoring/scoreThread.ts
import type { CallChecks, SignalSummary, StageId } from "../../types/analysis";
import { KEYWORD_RULES } from "../rules/keywords";
import { PATTERN_RULES } from "../rules/patterns";
import { WEIGHTS } from "../rules/weights";
import { scoreMessage, type Hit } from "./scoreMessage";
import { toRiskLevel } from "./escalation";

type ActorHint = "demand" | "comply" | "neutral";
type RiskLevel = ReturnType<typeof toRiskLevel>;

export type ScoreThreadContextMode = "auto" | "rolling" | "sticky";

/**
 * - auto:
 *   - 강한 행동요구가 있으면: 해당 지점 이전 backtrack + 이후 유지 (단, maxStickyMessages 캡)
 *   - 강한 행동요구가 없으면: 최근 maxMessages + (타임스탬프 있으면 maxDays 내만)
 * - rolling: 최근 maxMessages만
 * - sticky: 입력 messages 그대로 쓰되 maxStickyMessages 캡(안전장치)
 */
export type ScoreThreadContextOptions = {
  mode?: ScoreThreadContextMode;
  maxMessages?: number; // auto/rolling 기본 20
  maxStickyMessages?: number; // sticky/auto-강행동 기본 160
  backtrack?: number; // 강행동 발견 시 이전 문맥 포함 수 (기본 4)
  maxDays?: number; // 타임스탬프 있는 경우 auto에서만 적용 (기본 3)
};

export type ScoreThreadOptions = {
  weights?: Partial<typeof WEIGHTS>;
  context?: ScoreThreadContextOptions;
};

export type ScoreThreadResult = {
  scoreTotal: number;
  riskLevel: RiskLevel;
  stagePeak: StageId;
  stageTriggers: string[];

  hits: Hit[];
  signals: SignalSummary[];

  messageSummaries: Array<{
    index: number; // 원본 index(1-based)
    text: string;
    header?: string;
    speakerLabel?: string;
    content?: string;
    actorHint?: ActorHint;
    role?: "S" | "R" | "U";

    preview: string;
    score: number;
    urls: string[];
    stage: StageId;
    stageTriggers: string[];
    topRules: { label: string; stage: StageId; weight: number }[];
    includeInThreat: boolean;
  }>;

  context: {
    mode: ScoreThreadContextMode;
    kept: number;
    dropped: number;
    reason: string;
  };
};

const STAGE_RANK: Record<StageId, number> = {
  info: 0,
  verify: 1,
  install: 2,
  payment: 3,
};

function maxStage(a: StageId, b: StageId): StageId {
  return STAGE_RANK[a] >= STAGE_RANK[b] ? a : b;
}

/** URL 추출: 뒤쪽 구두점/괄호/따옴표/… 제거 + www/bare-domain도 수집(점수는 URL 특성에만 반영) */
function extractUrls(text: string): string[] {
  const t = String(text || "").replace(/\r\n/g, "\n");

  // 1) scheme 포함 URL
  const urlHits = t.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) || [];

  // 2) www.* (scheme 없는 케이스)
  const wwwHits = t.match(/\bwww\.[^\s<>"')\]]+/gi) || [];

  // 3) bare domain(+ optional path)
  const domHits =
    t.match(/\b[a-zA-Z0-9][a-zA-Z0-9-]{0,61}(?:\.[a-zA-Z0-9-]{1,63})+\b(?:\/[^\s<>"')\]]*)?/g) || [];

  const cleanup = (raw: string): string => {
    let s = String(raw || "").trim();

    // 뒤에 붙는 닫는 괄호/따옴표/구두점/… 제거
    s = s.replace(/[)\]}>"'`]+$/g, "");
    s = s.replace(/[.,!?;:]+$/g, "");
    s = s.replace(/…+$/g, "");

    // 앞에 붙는 괄호/따옴표 제거
    s = s.replace(/^[("'[\s]+/g, "");

    return s.trim();
  };

  const withScheme = (raw: string): string => {
    const s = cleanup(raw);
    if (!s) return "";
    if (/^https?:\/\//i.test(s)) return s;
    if (/^www\./i.test(s)) return `https://${s}`;
    return `https://${s}`;
  };

  const all = [...urlHits, ...wwwHits, ...domHits].map(withScheme).filter(Boolean);
  const uniq = Array.from(new Set(all));
  return uniq.slice(0, 20);
}

function safeParseUrl(u: string): URL | null {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

function getHostsFromText(text: string): string[] {
  const urls = extractUrls(text);
  const hosts: string[] = [];
  for (const u of urls) {
    const p = safeParseUrl(u);
    if (!p) continue;
    const h = (p.hostname || "").toLowerCase();
    if (h) hosts.push(h);
  }
  return Array.from(new Set(hosts)).slice(0, 20);
}

const SUSPICIOUS_TLDS = new Set([
  "xyz",
  "top",
  "shop",
  "click",
  "icu",
  "info",
  "work",
  "live",
  "loan",
  "support",
  "monster",
  "buzz",
  "cyou",
  "cfd",
  "sbs",
]);

const DOWNLOAD_EXTS = [".apk", ".exe", ".msi", ".dmg", ".pkg", ".scr", ".bat", ".cmd", ".ps1", ".zip", ".rar", ".7z"];

const BRAND_DOMAIN_ALLOW: Array<{ label: string; tokens: string[]; domains: string[] }> = [
  { label: "은행/결제사칭-도메인불일치", tokens: ["국민은행", "KB국민", "kbstar"], domains: ["kbstar.com", "kbfg.com", "kbcard.com"] },
  { label: "은행/결제사칭-도메인불일치", tokens: ["신한", "신한은행"], domains: ["shinhan.com", "shinhanbank.com"] },
  { label: "은행/결제사칭-도메인불일치", tokens: ["우리은행", "woori"], domains: ["wooribank.com"] },
  { label: "은행/결제사칭-도메인불일치", tokens: ["하나은행", "hana"], domains: ["hanafn.com", "hanabank.com"] },
  { label: "은행/결제사칭-도메인불일치", tokens: ["농협", "NH농협"], domains: ["nonghyup.com", "nhbank.com"] },
  { label: "은행/결제사칭-도메인불일치", tokens: ["기업은행", "IBK"], domains: ["ibk.co.kr"] },
  { label: "은행/결제사칭-도메인불일치", tokens: ["카카오뱅크"], domains: ["kakaobank.com"] },
  { label: "은행/결제사칭-도메인불일치", tokens: ["토스", "토스뱅크"], domains: ["toss.im", "tossbank.com"] },
  { label: "은행/결제사칭-도메인불일치", tokens: ["케이뱅크", "K뱅크"], domains: ["kbanknow.com"] },
];

function hostMatchesAllowed(host: string, allowed: string) {
  const h = (host || "").toLowerCase();
  const d = (allowed || "").toLowerCase();
  return h === d || h.endsWith("." + d);
}

function scoreUrls(messageText: string, urls: string[], weights: typeof WEIGHTS): Hit[] {
  const msg = messageText || "";
  const msgLower = msg.toLowerCase();
  const sample = msg.length > 140 ? msg.slice(0, 140) + "..." : msg;

  const agg = new Map<string, { ruleId: string; label: string; stage: StageId; baseWeight: number; matched: string[] }>();

  const add = (ruleId: string, label: string, stage: StageId, baseWeight: number, match: string) => {
    const m = String(match || "").trim();
    if (!m) return;
    const prev = agg.get(ruleId);
    if (!prev) agg.set(ruleId, { ruleId, label, stage, baseWeight, matched: [m] });
    else if (prev.matched.length < 6) prev.matched.push(m);
  };

  const list = Array.isArray(urls) ? urls.slice(0, 10) : [];
  for (const raw0 of list) {
    const raw = String(raw0 || "").trim();
    const u = safeParseUrl(raw);
    if (!u) continue;

    const proto = (u.protocol || "").toLowerCase();
    const host = (u.hostname || "").toLowerCase();
    const path = ((u.pathname || "") + (u.search || "")).toLowerCase();

    if (proto === "http:") add("url_http", "URL: HTTP(비TLS)", "verify", weights.urlHttp, raw);
    if (raw.includes("@")) add("url_at_sign", "URL: '@' 포함(우회/위장 가능)", "verify", weights.urlAtSign, raw);

    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) add("url_ip_host", "URL: IP 호스트(의심)", "verify", weights.urlIpHost, host);
    if (host.includes("xn--")) add("url_punycode", "URL: Punycode(xn--) 의심", "verify", weights.urlPunycode, host);

    const hostParts = host.split(".").filter(Boolean);
    if (hostParts.length >= 5) add("url_deep_subdomain", "URL: 서브도메인 과다(위장 가능)", "verify", weights.urlDeepSubdomain, host);

    const tld = hostParts.length ? hostParts[hostParts.length - 1] : "";
    if (tld && SUSPICIOUS_TLDS.has(tld)) add("url_suspicious_tld", "URL: 의심 TLD", "verify", weights.urlSuspiciousTld, host);

    for (const ext of DOWNLOAD_EXTS) {
      if (path.endsWith(ext) || path.includes(ext + "?") || path.includes(ext + "&")) {
        add("url_download_ext", "URL: 설치/압축 파일 확장자", "install", weights.urlDownloadExt, raw);
        break;
      }
    }

    for (const b of BRAND_DOMAIN_ALLOW) {
      const tokenHit = b.tokens.some((t) => t && msgLower.includes(String(t).toLowerCase()));
      if (!tokenHit) continue;
      const ok = b.domains.some((d) => hostMatchesAllowed(host, d));
      if (!ok) add("url_brand_mismatch", b.label, "verify", weights.urlBrandMismatch, `${b.tokens[0]} → ${host}`);
    }
  }

  const out: Hit[] = [];
  for (const v of agg.values()) {
    const uniq = Array.from(new Set(v.matched.map((x) => String(x).trim()).filter(Boolean))).slice(0, 6);
    const mult = Math.min(2, uniq.length || 1);
    out.push({ ruleId: v.ruleId, label: v.label, stage: v.stage, weight: v.baseWeight * mult, matched: uniq, sample });
  }
  return out;
}

function parseHeaderAndContent(blockText: string): { header: string | null; speakerLabel: string | null; content: string } {
  const raw = String(blockText || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return { header: null, speakerLabel: null, content: "" };

  const lines = raw.split("\n");
  const first = (lines[0] || "").trim();
  const rest = lines.slice(1);

  const sp1 = first.match(/^(S|R)\s*:\s*(.*)$/i);
  if (sp1) {
    const who = String(sp1[1] || "").toUpperCase() === "R" ? "R" : "S";
    const after = String(sp1[2] || "").trim();
    const body = [after, ...rest].filter(Boolean).join("\n").trim();
    return { header: null, speakerLabel: who, content: body || after || "" };
  }

  const sp2 = first.match(/^(sender|receiver|발신|수신)\s*:\s*(.*)$/i);
  if (sp2) {
    const head = String(sp2[1] || "").toLowerCase();
    const who = head === "receiver" || head === "수신" ? "R" : "S";
    const after = String(sp2[2] || "").trim();
    const body = [after, ...rest].filter(Boolean).join("\n").trim();
    return { header: null, speakerLabel: who, content: body || after || "" };
  }

  const tryKakao = /^\[\s*(오전|오후)?\s*\d{1,2}:\d{2}\s*\]\s*(.{1,40}?)(?::\s*)?(.*)$/;
  const tryDateTimeName1 =
    /^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\s+(오전|오후)?\s*\d{1,2}:\d{2}\s+(.{1,40}?)(?::\s*)?(.*)$/;
  const tryDateTimeName2 = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}\s+(.{1,40}?)(?::\s*)?(.*)$/;
  const tryTimeName1 = /^(오전|오후)?\s*\d{1,2}:\d{2}\s+(.{1,40}?)(?::\s*)?(.*)$/;
  const tryTimeName2 = /^\d{1,2}:\d{2}\s+(.{1,40}?)(?::\s*)?(.*)$/;

  const m1 = first.match(tryKakao);
  if (m1) {
    const speaker = String(m1[2] || "").trim();
    const after = String(m1[3] || "").trim();
    const body = [after, ...rest].filter(Boolean).join("\n").trim();
    return { header: first, speakerLabel: speaker || null, content: body || after || "" };
  }

  const m2 = first.match(tryDateTimeName1);
  if (m2) {
    const speaker = String(m2[2] || "").trim();
    const after = String(m2[3] || "").trim();
    const body = [after, ...rest].filter(Boolean).join("\n").trim();
    return { header: first, speakerLabel: speaker || null, content: body || after || "" };
  }

  const m3 = first.match(tryDateTimeName2);
  if (m3) {
    const speaker = String(m3[1] || "").trim();
    const after = String(m3[2] || "").trim();
    const body = [after, ...rest].filter(Boolean).join("\n").trim();
    return { header: first, speakerLabel: speaker || null, content: body || after || "" };
  }

  const m4 = first.match(tryTimeName1);
  if (m4) {
    const speaker = String(m4[2] || "").trim();
    const after = String(m4[3] || "").trim();
    const body = [after, ...rest].filter(Boolean).join("\n").trim();
    return { header: first, speakerLabel: speaker || null, content: body || after || "" };
  }

  const m5 = first.match(tryTimeName2);
  if (m5) {
    const speaker = String(m5[1] || "").trim();
    const after = String(m5[2] || "").trim();
    const body = [after, ...rest].filter(Boolean).join("\n").trim();
    return { header: first, speakerLabel: speaker || null, content: body || after || "" };
  }

  return { header: null, speakerLabel: null, content: raw };
}

function classifyActorHint(content: string): ActorHint {
  const t = String(content || "").trim();
  if (!t) return "neutral";
  const s = t.toLowerCase();

  const otpRelayDemand =
    /(인증번호|otp|오티피|승인\s*번호|승인번호|보안\s*코드|보안코드|확인\s*코드|확인코드|ars|2\s*단계\s*인증|6\s*자리|6자리).*(보내|알려|전달|말해|읽어|불러|캡처|말씀)/.test(
      s
    ) ||
    /(보내|알려|전달|말해|읽어|불러|캡처|말씀).*(인증번호|otp|오티피|승인\s*번호|승인번호|보안\s*코드|보안코드|확인\s*코드|확인코드|ars|2\s*단계\s*인증|6\s*자리|6자리)/.test(
      s
    );

  if (otpRelayDemand) return "demand";

  const demandPatterns: RegExp[] = [
    /입금해|송금해|이체해|결제해|납부해|지불해|충전해/,
    /설치해|다운받아|다운로드해|원격|팀뷰어|anydesk|quicksupport/,
    /(링크|url).*(클릭|눌러)|클릭.*(해|하세요)/,
    /지금\s*(바로|즉시)|긴급|오늘\s*안에|기한\s*내/,
  ];

  const complyPatterns: RegExp[] = [
    /^\s*(네|예)\b/,
    /알겠|알겠습니다|확인했|확인했습니다|확인했어요/,
    /보냈|전송했|전송했습니다|보냈어요/,
    /입금했|송금했|이체했|결제했|납부했|충전했/,
    /설치했|다운받았|다운로드했|클릭했|눌렀/,
    /(인증번호|otp|오티피|승인\s*번호|보안\s*코드|비밀번호|계좌번호|카드번호|주민번호)/i,
  ];

  let d = 0;
  let c = 0;

  for (const r of demandPatterns) if (r.test(s)) d += 1;
  for (const r of complyPatterns) if (r.test(s)) c += 1;

  const shortYes = /^\s*(네|예|알겠|알겠습니다)\b/i.test(t) && t.length <= 32;
  if (shortYes && c >= 1) return "comply";
  if (d >= 2 && d > c) return "demand";
  if (c >= 2 && c >= d) return "comply";
  return "neutral";
}

function isPaymentAlertOnlyText(t: string) {
  const s = String(t || "");

  // 결제/이체/입금 "요구"가 섞이면 alert-only로 보지 않음
  const hasDirective =
    /(해\s*주|해줘|해\s*주세요|해주시|부탁|요청|바라|진행|처리\s*해|입금\s*하|송금\s*하|이체\s*하|결제\s*하|납부\s*하|지불\s*하|충전\s*하|보내\s*(줘|주|주세요|바랍니다|바라|주시))/i.test(
      s
    );

  const hasPayWord = /(입금|송금|이체|결제|납부|지불|충전)/i.test(s);
  if (!hasPayWord) return false;
  if (hasDirective) return false;

  // 통지/내역/승인/거래/SMS 류는 alert-only로 취급
  return /(알림|안내|내역|확인|승인|거절|취소|환불|시도|차단|보류|접수|완료|처리\s*결과|거래|가맹점|잔액|문자|sms|정기\s*결제|자동\s*이체|자동이체|자동\s*납부|자동납부|해외\s*결제|이상\s*거래|부정\s*사용|승인\s*대기|대기\s*중|대기중)/i.test(
    s
  );
}

function hasAmountKRW(t: string) {
  return /(\d{1,3}(?:,\d{3})+|\d+)\s*(원|만원)/i.test(t);
}

function hasStrongPayCueText(t: string) {
  // "금액 존재"만으로 strong cue로 보지 않음 (은행 알림/거래내역 문자 오탐 방지)
  // 금액은 stageFromHitsV2 쪽에서 다른 단서(요구/계좌/압박/룰 hit)와 결합될 때만 쓰이도록 둔다.
  return (
    /(납부|지불|결제\s*진행|결제\s*해\s*주|결제\s*해주|결제\s*해주세요|납부\s*하세요|송금\s*하세요|이체\s*하세요|입금\s*하세요|충전\s*하세요|수수료\s*입금|선납|보증보험료|보험료)/i.test(
      t
    ) || /(미납|체납|과태료|벌금|고지|가산금|압류|추심|연체)/i.test(t)
  );
}

function normalizeHitStage(content: string, h: Hit): StageId {
  const t = String(content || "");
  const sample = String((h as any).sample || "");
  const matchedText = Array.isArray((h as any).matched) ? ((h as any).matched as any[]).join("\n") : "";
  const scope = (t + "\n" + sample + "\n" + matchedText).trim();
  const id = String(h.ruleId || "");

  if (id === "shortener") return "verify";

  if (id === "link") {
    const intranetLike =
      /(사내|내부|회사|intranet|인트라넷|내부\s*공지|사내\s*공지|공지\s*페이지|회사\s*it|it\s*팀|helpdesk|헬프데스크|정보보안)/i.test(
        t
      ) && /https?:\/\/[^\s)]+/i.test(t);

    const intranetSafe =
      intranetLike &&
      !/(otp|인증\s*번호|인증번호|보안\s*코드|보안코드|확인\s*코드|확인코드|ars|2\s*단계\s*인증|2fa|송금|이체|입금|납부|결제|안내\s*계좌|보호\s*계좌|안전\s*계좌|원격|anydesk|quicksupport|teamviewer|apk|설치|다운로드|뷰어|viewer|shortener|bit\.ly|t\.co)/i.test(
        t
      );

    if (intranetSafe) return "info";

    const isDeliveryContextText = (x: string) =>
      /(택배|배송|배송지|운송장|운송장번호|송장|물류|집화|집하|출고|입고|도착|지연|보관중|보관\s*중|배송중|배달중|통관|세관|반품|교환|수취|수령|부재중|문앞|문\s*앞)/i.test(
        String(x || "")
      );

    const strongActionContext = /(인증|본인|로그인|계정|비밀번호|otp|오티피|ars|2\s*단계\s*인증|확인\s*번호|확인번호|보안\s*코드|보안코드|확인\s*코드|확인코드|결제|납부|송금|이체|입금|선납|보험료|설치|다운로드|원격|팀뷰어|anydesk|quicksupport|차단|해제|분실|압류|과태료|벌금|미납|체납)/i.test(
      scope
    );

    const promoContext = /(쿠폰|기프티콘|설문|프로모션|이벤트|경품|당첨|무료\s*(쿠폰|기프티콘)?)/i.test(scope);

    const orderOrDeliveryOnly =
      (/(주문번호|거래\s*내역|상품\s*확인|정상\s*상품)/i.test(scope) || isDeliveryContextText(scope)) &&
      !strongActionContext &&
      !promoContext;

    if (orderOrDeliveryOnly) return "info";

    const suspiciousLinkContext = strongActionContext || promoContext;
    return suspiciousLinkContext ? "verify" : "info";
  }

  if (id === "otp" || id === "ctx_otp_proxy" || id === "ctx_otp_finance" || id === "ctx_otp_relay") return "verify";

  if (id === "personalinfo" || id === "pii_request" || id === "account_verify") {
    const intranetLike =
      /(사내|내부|회사|intranet|인트라넷|내부\s*공지|사내\s*공지|공지\s*페이지|회사\s*it|it\s*팀|helpdesk|헬프데스크|정보보안)/i.test(
        t
      );

    const intranetSafe =
      intranetLike &&
      !/(otp|인증\s*번호|인증번호|보안\s*코드|보안코드|확인\s*코드|확인코드|ars|2\s*단계\s*인증|2fa|송금|이체|입금|납부|결제|안내\s*계좌|보호\s*계좌|안전\s*계좌|원격|anydesk|quicksupport|teamviewer|apk|설치|다운로드|뷰어|viewer|shortener|bit\.ly|t\.co)/i.test(
        t
      );

    return intranetSafe ? "info" : "verify";
  }

  if (id === "txn_alert" || id === "social") return "info";

  if (id === "authority" || id === "threat" || id === "urgent") return "info";
  if (id === "remote" || id === "install_app" || id === "apk") return "install";

  if (id === "safe_account" || id === "ctx_transfer_phrase") return "payment";

  if (id === "ctx_pay_with_link") {
    if (isPaymentAlertOnlyText(t)) return "verify";
    if (/(납부|미납|체납|과태료|벌금|고지|압류|선납|보험료)/i.test(t)) return "payment";
    if (hasStrongPayCueText(t)) return "payment";
    return "verify";
  }

  if (id.startsWith("url_")) {
    if (id === "url_download_ext") return "install";
    return "verify";
  }

  const hasInstallCue =
    /(설치|다운로드|앱|어플|프로그램|원격|팀뷰어|anydesk|quicksupport|apk|exe|msi|dmg|pkg|뷰어|viewer|플러그인|plugin)/i.test(
      t
    );

  const paymentAlertOnly = isPaymentAlertOnlyText(t);

  const isTransferRequest =
    /(보내\s*줘|보내줘|부쳐\s*줘|부쳐줘|입금\s*해|입금해|송금\s*해|송금해|이체\s*해|이체해|납부\s*해|납부해|지불\s*해|지불해|충전\s*해|충전해)/i.test(
      t
    ) ||
    /(보내|부쳐|송금|이체|입금|납부|지불|충전).{0,14}(해\s*줘|해줘|해\s*주|해주|해주세요|부탁|요청|진행|하셔야|바랍니다|주시)/i.test(
      t
    ) ||
    /(링크|페이지).{0,14}(에서|로).{0,12}(납부|결제|지불|송금|이체|입금)/i.test(t) ||
    /(납부|결제|지불|송금|이체|입금).{0,12}(하세요|바랍니다|필요|진행)/i.test(t);

  const hasStrongTransferCue = hasStrongPayCueText(t);
  const isEscrowLike = /(안전\s*결제|안전\s*거래|에스크로|escrow|거래)/i.test(t);
  const hasPayWord = /(납부|송금|이체|입금|지불|충전|선납|보험료)/i.test(t);
  const hasAmt = hasAmountKRW(t);

  if (h.stage === "payment") {
    if (id === "transfer") {
      if (paymentAlertOnly) return "verify";
      if (!isTransferRequest && !hasStrongTransferCue) return "verify";
      return "payment";
    }

    if (id === "ctx_payment_request") {
      if (paymentAlertOnly) return "verify";
      if (isEscrowLike && !hasStrongTransferCue && !hasPayWord && !hasAmt) return "verify";
      if (!isTransferRequest && !hasStrongTransferCue && !/(납부|미납|체납|과태료|벌금|고지|압류|선납|보험료)/i.test(t))
        return "verify";
      return "payment";
    }

    if (id === "ctx_pay_with_link") {
      if (paymentAlertOnly) return "verify";
      if (!hasStrongTransferCue && !/(납부|미납|체납|과태료|벌금|고지|압류|선납|보험료)/i.test(t)) return "verify";
      return "payment";
    }

    const installBeforePay =
      /(설치).{0,10}(후|해야|필요).{0,24}(결제|납부|송금|이체|입금|진행)/i.test(t) ||
      /(결제|납부|송금|이체|입금).{0,18}(하려면|위해).{0,18}(설치)/i.test(t);

    if (isEscrowLike && hasInstallCue && installBeforePay) return "install";
    if (isEscrowLike && hasInstallCue && !hasStrongTransferCue) return "install";
  }

  return h.stage;
}

function expandStageAliases(hits: Hit[]): Hit[] {
  const ids = new Set<string>(
    hits.map((h: any) => String(h?.ruleId ?? "").trim()).filter(Boolean)
  );

  const out = hits.slice();

  const addAlias = (from: string, to: string) => {
    if (!ids.has(from) || ids.has(to)) return;
    const h = hits.find((x: any) => String(x?.ruleId ?? "") === from);
    if (!h) return;
    out.push({ ...(h as any), ruleId: to } as any);
    ids.add(to);
  };

  // link naming
  addAlias("link", "link_mention");
  addAlias("link_mention", "link");

  // gov benefit naming
  addAlias("government_benefit", "ctx_government_benefit");
  addAlias("ctx_government_benefit", "government_benefit");

  // optional: pii naming
  addAlias("personalinfo", "pii_request");

  return out;
}

function stageFromHitsV2(content: string, hits: Hit[]): { stage: StageId; triggers: string[]; normalized: Hit[] } {
  const text = String(content || "");

  const normalizedAll0 = hits.map((h) => ({ ...h, stage: normalizeHitStage(text, h) }));
  const normalizedAll = expandStageAliases(normalizedAll0);

  const idOf = (h: Hit) => String((h as any)?.ruleId ?? "").trim();

  // matched 기반 필터는 유지하되, ctx_/url_ 류는 placeholder matched 때문에 항상 보존
  const normalized = normalizedAll.filter((h) => {
    const id = idOf(h);
    if (id.startsWith("ctx_") || id.startsWith("url_")) return true;

    const ms = (h as any)?.matched as string[] | undefined;
    if (!ms || ms.length === 0) return true;
    return ms.some((m) => m && text.includes(m));
  });

  const pick = (pred: (h: Hit) => boolean) =>
    normalized
      .filter(pred)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 2)
      .map((h) => h.label);

  const t = text;
  const escrowLike = /(안전\s*결제|안전\s*거래|에스크로|escrow|거래)/i.test(t);

  const strongPayCue = hasStrongPayCueText(t);
  const hasAmt = hasAmountKRW(t);

  const payNoun = /(납부|송금|이체|입금|결제|지불|충전|선납|보험료|수수료|보증금|예치금|가입비|등록비|예약금|계약금|핀\s*번호|상품권|기프트|코인|지갑|qr)/i.test(t);
  const payImperative =
    /(해\s*줘|해줘|해\s*주|해주|해주세요|하세요|하셔야|바랍니다|요청|부탁|필수|반드시|진행|처리|완료)/i.test(t) ||
    /(지금\s*(바로|즉시)|긴급|오늘\s*안에|기한\s*내)/i.test(t);

  // “지시/요구” 문맥으로 payment 승격(강한 키워드/금액/명령어)
  const payDemandText = strongPayCue || hasAmt || (payNoun && payImperative);

  const hasPressure =
    normalized.some((h) => ["urgent", "threat", "authority", "ctx_demand", "ctx_secrecy"].includes(idOf(h))) ||
    /(긴급|즉시|바로|오늘\s*안에|기한\s*내|반드시|필수)/i.test(t);

  // install
  const INSTALL_HARD = new Set(["apk", "remote", "call_remote", "url_download_ext"]);
  const INSTALL_SOFT = new Set(["install_app", "ctx_install_mention"]);

  const installBeforePay =
    /(설치).{0,10}(후|해야|필요).{0,24}(결제|납부|송금|이체|입금|진행)/i.test(t) ||
    /(결제|납부|송금|이체|입금).{0,18}(하려면|위해).{0,18}(설치)/i.test(t);

  const hasHardInstall = normalized.some((h) => h.stage === "install" && INSTALL_HARD.has(idOf(h)));
  const hasAnyInstall = hasHardInstall || normalized.some((h) => h.stage === "install" && INSTALL_SOFT.has(idOf(h)));

  if (hasHardInstall) {
    return { stage: "install", triggers: pick((h) => h.stage === "install" && INSTALL_HARD.has(idOf(h))), normalized };
  }
  if (hasAnyInstall && escrowLike && !strongPayCue) {
    return {
      stage: "install",
      triggers: pick((h) => h.stage === "install" && (INSTALL_HARD.has(idOf(h)) || INSTALL_SOFT.has(idOf(h)))),
      normalized,
    };
  }
  if (hasAnyInstall && installBeforePay) {
    return {
      stage: "install",
      triggers: pick((h) => h.stage === "install" && (INSTALL_HARD.has(idOf(h)) || INSTALL_SOFT.has(idOf(h)))),
      normalized,
    };
  }

  // payment (기존보다 “무조건 payment”를 줄임)
  // - ALWAYS: 이 자체로 payment로 봐도 되는 것
  const PAYMENT_ALWAYS = new Set(["ctx_cash_pickup", "ctx_giftcard", "ctx_crypto_wallet", "ctx_account_rental", "ctx_qr_pay"]);

  // - CONDITIONAL: 문맥(요구/금액/압박)이 있어야 payment
  const PAYMENT_COND = new Set(["safe_account", "go_bank_atm", "ctx_transfer_demand", "ctx_payment_request"]);

  // - SOFT: 기본 verify(단, 요구/금액이면 payment)
  const PAYMENT_SOFT = new Set(["transfer", "ctx_transfer_phrase", "ctx_pay_with_link"]);

  const hasPayAlways = normalized.some((h) => h.stage === "payment" && PAYMENT_ALWAYS.has(idOf(h)));
  const hasPayCond = normalized.some((h) => h.stage === "payment" && PAYMENT_COND.has(idOf(h)));
  const hasPaySoft = normalized.some((h) => h.stage === "payment" && PAYMENT_SOFT.has(idOf(h)));

  if (hasPayAlways) {
    return { stage: "payment", triggers: pick((h) => h.stage === "payment" && PAYMENT_ALWAYS.has(idOf(h))), normalized };
  }

  if (hasPayCond) {
    if (payDemandText || hasPressure) {
      return { stage: "payment", triggers: pick((h) => h.stage === "payment" && PAYMENT_COND.has(idOf(h))), normalized };
    }
    return {
      stage: "verify",
      triggers: pick((h) => h.stage === "payment" && PAYMENT_COND.has(idOf(h))),
      normalized,
    };
  }

  if (hasPaySoft) {
    if (payDemandText || (hasPressure && strongPayCue)) {
      return { stage: "payment", triggers: pick((h) => h.stage === "payment" && PAYMENT_SOFT.has(idOf(h))), normalized };
    }
    return { stage: "verify", triggers: pick((h) => h.stage === "payment" && PAYMENT_SOFT.has(idOf(h))), normalized };
  }

  // verify
  const VERIFY_STRONG = new Set([
    "otp",
    "ctx_otp_finance",
    "ctx_otp_relay",
    "ctx_otp_proxy",
    "account_verify",
    "link",
    "link_mention",
    "shortener",
    "personalinfo",
    "pii_request",
  ]);

  const VERIFY_WEAK = new Set([
    "messenger_phishing",
    "ctx_contact_move",
    "ctx_profile_link_mention",
    "government_benefit",
    "ctx_government_benefit",
    "ctx_visit_place",
    "ctx_refund_lure",
    "ctx_loan_hook",
    "ctx_benefit_link",
    "ctx_benefit_link_mention",
  ]);

  const hasStrongVerify = normalized.some((h) => h.stage === "verify" && VERIFY_STRONG.has(idOf(h)));
  if (hasStrongVerify) {
    return { stage: "verify", triggers: pick((h) => h.stage === "verify" && VERIFY_STRONG.has(idOf(h))), normalized };
  }

  const verifyCueText = /(인증|로그인|확인|접속|클릭|눌러|링크|url|주소|입력|작성|제출|전송|보내|캡처|사진)/i.test(t);
  const hasWeakVerify = normalized.some((h) => h.stage === "verify" && VERIFY_WEAK.has(idOf(h)));
  if (hasWeakVerify && verifyCueText) {
    return { stage: "verify", triggers: pick((h) => h.stage === "verify" && VERIFY_WEAK.has(idOf(h))), normalized };
  }

  const triggers = normalized
    .filter((h) => h.stage === "info")
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 2)
    .map((h) => h.label);

  return { stage: "info", triggers, normalized };
}

function addCtxHit(
  ctxHits: Hit[],
  ruleId: string,
  label: string,
  stage: StageId,
  weight: number,
  content: string,
  matched: string[]
) {
  ctxHits.push({
    ruleId,
    label,
    stage,
    weight,
    matched,
    sample: content.length > 140 ? content.slice(0, 140) + "..." : content,
  });
}

function isSelfAckText(t: string) {
  return /(제가\s*한\s*건데|제가\s*한\s*거|제가\s*했|내가\s*했|내가\s*한|제가\s*바꿨|내가\s*바꿨|제가\s*변경|내가\s*변경|제가\s*설정\s*바꿨|제가\s*설정했|응\s*내가|맞아\s*내가|내가\s*결제했)/i.test(
    t
  );
}

function isAdviceOnlyThread(raw: string) {
  const hasAdvice =
    /(좋대|추천|권장|제일\s*안전|가장\s*안전|공식\s*고객센터|고객센터\s*번호|문의하는\s*게|문의가\s*안전|안전하게)/i.test(raw) &&
    !/(압류|출석|수사|검찰|경찰|기소|체포|고지|미납|체납|과태료|벌금|환급금|대출|선납|보험료)/i.test(raw);

  const hasAction =
    /(링크|https?:\/\/|otp|인증번호|송금|이체|입금|납부|설치|원격|팀뷰어|anydesk|quicksupport)/i.test(raw);

  return hasAdvice && !hasAction;
}

/**
 * 강한 행동요구:
 * - 프리필터/컨텍스트 윈도우 확장(풀필터 호출 근거) 용도
 * - High 판정의 필요조건이 아님(High는 hardHigh 구조로만 허용)
 */
function hasStrongActionDemandText(t: string) {
  const s = String(t || "");

  const hasOtpRelay =
    /(인증번호|otp|오티피|승인\s*번호|승인번호|보안\s*코드|보안코드|확인\s*코드|확인코드|ars|2\s*단계\s*인증|2fa|6\s*자리|6자리)/i.test(s) &&
    /(보내|알려|전달|말해|읽어|불러|캡처|말씀)/i.test(s);

  const hasPayDemand =
    /(보내\s*줘|보내줘|부쳐\s*줘|부쳐줘|입금\s*해|입금해|송금\s*해|송금해|이체\s*해|이체해|납부\s*해|납부해|지불\s*해|지불해|충전\s*해|충전해)/i.test(s) ||
    (/(납부|송금|이체|입금|지불|충전|선납|보험료|수수료)/i.test(s) &&
      /(해주세요|하세요|하셔야|부탁|요청|바랍니다|주시|진행|처리|완료|필수|반드시)/i.test(s)) ||
    hasAmountKRW(s);

  const hasInstallDemand =
    /(설치|다운로드|받아|깔아|실행|연결|접속|등록|인증)/i.test(s) &&
    /(앱|어플|프로그램|원격|팀뷰어|teamviewer|anydesk|애니데스크|퀵서포트|quicksupport|뷰어|viewer|플러그인|plugin|apk|exe|msi|dmg|pkg)/i.test(
      s
    );

  const safeAccountDemand =
    /(안내\s*계좌|보호\s*계좌|안전\s*계좌|지정\s*계좌)/i.test(s) &&
    /(이체|송금|입금|옮기|이전)/i.test(s);

  return hasOtpRelay || hasPayDemand || hasInstallDemand || safeAccountDemand;
}

/** 타임스탬프가 있으면 Date로 파싱(있을 때만 윈도우 제한에 사용) */
function parseTimestampMaybe(rawLine: string): Date | null {
  const x = String(rawLine || "").trim();
  if (!x) return null;

  // 2026-02-03 09:12
  let m = x.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) {
    const yy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    const hh = Number(m[4]);
    const mi = Number(m[5]);
    const ss = Number(m[6] || "0");
    const d = new Date(yy, mm - 1, dd, hh, mi, ss);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  // 2026.02.03 오전 9:12
  m = x.match(/^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})\s+(오전|오후)?\s*(\d{1,2}):(\d{2})/);
  if (m) {
    const yy = Number(m[1]);
    const mm = Number(m[2]);
    const dd = Number(m[3]);
    const ap = String(m[4] || "");
    let hh = Number(m[5]);
    const mi = Number(m[6]);
    if (ap === "오후" && hh < 12) hh += 12;
    if (ap === "오전" && hh === 12) hh = 0;
    const d = new Date(yy, mm - 1, dd, hh, mi, 0);
    return Number.isFinite(d.getTime()) ? d : null;
  }

  return null;
}

function selectContextWindow(
  messages: string[],
  call: CallChecks,
  ctx?: ScoreThreadContextOptions
): { selected: Array<{ originalIndex: number; text: string }>; meta: ScoreThreadResult["context"] } {
  const mode: ScoreThreadContextMode = ctx?.mode || "auto";
  const maxMessages = Math.max(5, Math.min(80, ctx?.maxMessages ?? 20));
  const maxSticky = Math.max(40, Math.min(300, ctx?.maxStickyMessages ?? 160));
  const backtrack = Math.max(0, Math.min(12, ctx?.backtrack ?? 4));
  const maxDays = Math.max(1, Math.min(14, ctx?.maxDays ?? 3));

  const all = messages.map((text, i) => ({ originalIndex: i, text: String(text ?? "") }));

  const clampTail = (arr: typeof all, cap: number) => (arr.length <= cap ? arr : arr.slice(arr.length - cap));

  if (mode === "sticky") {
    const kept = clampTail(all, maxSticky);
    return {
      selected: kept,
      meta: { mode, kept: kept.length, dropped: all.length - kept.length, reason: "sticky" },
    };
  }

  if (mode === "rolling") {
    const kept = clampTail(all, maxMessages);
    return {
      selected: kept,
      meta: { mode, kept: kept.length, dropped: all.length - kept.length, reason: `rolling:${maxMessages}` },
    };
  }

  // auto
  // 1) 강한 행동요구 or 콜체크가 있으면 sticky 성격(단, 캡)
  const strongByCall = !!(call?.otpAsked || call?.remoteAsked);
  let firstStrongIdx = -1;

  for (let i = 0; i < all.length; i++) {
    const parsed = parseHeaderAndContent(all[i].text);
    const content = parsed.content || all[i].text;
    if (hasStrongActionDemandText(content)) {
      firstStrongIdx = i;
      break;
    }
  }

  if (strongByCall || firstStrongIdx >= 0) {
    const start = Math.max(0, (firstStrongIdx >= 0 ? firstStrongIdx : all.length - maxSticky) - backtrack);
    const kept0 = all.slice(start);

    // strong 모드에서는 “강행동 시점부터 이후”를 유지해야 하므로 tail-clamp가 아니라 head-clamp
    const kept = kept0.length <= maxSticky ? kept0 : kept0.slice(0, maxSticky);

    return {
      selected: kept,
      meta: {
        mode,
        kept: kept.length,
        dropped: all.length - kept.length,
        reason: firstStrongIdx >= 0 ? `auto:strong@${firstStrongIdx + 1}` : "auto:strong(call)",
      },
    };
  }

  // 2) 강한 행동요구가 없으면: 최근 maxMessages + (타임스탬프 있으면 maxDays)
  let kept = clampTail(all, maxMessages);

  // 타임스탬프 기반 제한(가능할 때만)
  const stamps: Array<{ i: number; ts: Date }> = [];
  for (const it of kept) {
    const firstLine = String(it.text || "").split("\n")[0] || "";
    const ts = parseTimestampMaybe(firstLine);
    if (ts) stamps.push({ i: it.originalIndex, ts });
  }

  if (stamps.length >= 2) {
    const latest = stamps.map((x) => x.ts.getTime()).reduce((a, b) => Math.max(a, b), 0);
    const cutoff = latest - maxDays * 24 * 60 * 60 * 1000;
    const minIdx = stamps
      .filter((x) => x.ts.getTime() >= cutoff)
      .map((x) => x.i)
      .reduce((a, b) => Math.min(a, b), Number.POSITIVE_INFINITY);

    if (Number.isFinite(minIdx)) {
      const kept2 = kept.filter((x) => x.originalIndex >= minIdx);
      kept = kept2.length ? kept2 : kept;
      return {
        selected: kept,
        meta: {
          mode,
          kept: kept.length,
          dropped: all.length - kept.length,
          reason: `auto:weak(maxMessages=${maxMessages},maxDays=${maxDays})`,
        },
      };
    }
  }

  return {
    selected: kept,
    meta: { mode, kept: kept.length, dropped: all.length - kept.length, reason: `auto:weak(maxMessages=${maxMessages})` },
  };
}

/**
 * 스레드 합산 누진(같은 ruleId 반복이 “단순 누적”으로 폭주하지 않게):
 * - 같은 ruleId의 k번째 발생은 weight * factor(k)
 * - factor: 1.00, 0.85, 0.70, 0.55, 0.45, 이후 0.35 고정
 */
function applyDiminishingByRuleId(hits: Hit[]): Hit[] {
  const countById = new Map<string, number>();
  const factor = (k: number) => {
    if (k <= 1) return 1.0;
    if (k === 2) return 0.85;
    if (k === 3) return 0.7;
    if (k === 4) return 0.55;
    if (k === 5) return 0.45;
    return 0.35;
  };

  return hits.map((h) => {
    const id = String(h.ruleId || "");
    const k = (countById.get(id) || 0) + 1;
    countById.set(id, k);
    const f = factor(k);
    return { ...h, weight: Math.round(h.weight * f * 100) / 100 };
  });
}

function buildSignalsFromHits(sortedHits: Hit[], maxSignals = 12): SignalSummary[] {
  type Agg = {
    id: string;
    label: string;
    stage?: StageId;
    weightSum: number;
    count: number;
    examples: Set<string>;
    bestWeight: number;
  };

  const byId = new Map<string, Agg>();

  for (const h of sortedHits) {
    const id = String(h?.ruleId || "").trim();
    if (!id) continue;

    const w0 = Number(h?.weight ?? 0);
    const w = Number.isFinite(w0) ? w0 : 0;

    let a = byId.get(id);
    if (!a) {
      a = {
        id,
        label: String(h?.label || "").trim(),
        stage: h?.stage,
        weightSum: 0,
        count: 0,
        examples: new Set<string>(),
        bestWeight: Number.NEGATIVE_INFINITY,
      };
      byId.set(id, a);
    }

    a.count += 1;
    a.weightSum += w;

    // 가장 강한 히트 기준으로 label/stage 유지
    if (w > a.bestWeight) {
      a.bestWeight = w;
      const lab = String(h?.label || "").trim();
      if (lab) a.label = lab;
      a.stage = h?.stage;
    }

    // examples: matched 토큰(최대 12개까지 수집 후 최종 6개로 자름)
    const ms: any[] = Array.isArray((h as any)?.matched) ? (h as any).matched : [];
    for (const m of ms) {
      const s = String(m ?? "").trim();
      if (!s) continue;
      a.examples.add(s);
      if (a.examples.size >= 12) break;
    }
  }

  const clamp2 = (x: number) => Math.round(x * 100) / 100;

  const arr = Array.from(byId.values())
    .map((a) => ({
      id: a.id,
      label: a.label,
      stage: a.stage,
      weightSum: clamp2(a.weightSum),
      count: a.count,
      examples: Array.from(a.examples).slice(0, 6),
    }))
    .sort((a, b) => (b.weightSum - a.weightSum) || (b.count - a.count))
    .slice(0, maxSignals);

  return arr;
}

export function scoreThread(
  messages: string[],
  call: CallChecks,
  opts?: ScoreThreadOptions
): ScoreThreadResult & { hits: Hit[]; signals: ReturnType<typeof buildSignalsFromHits> } {
  const weights = { ...WEIGHTS, ...(opts?.weights || {}) };
  const rules = [...PATTERN_RULES, ...KEYWORD_RULES];

  const windowed = selectContextWindow(messages, call, opts?.context);
  const selected = windowed.selected;

  const hits: Hit[] = [];
  const messageSummaries: ScoreThreadResult["messageSummaries"] = [];

  let seenOtpCueInThread = false;

  const hasExplicitRole = selected.some((m) => {
    const s = String(m.text || "");
    return (
      /^\s*\[?\s*s\s*\]?\s*[:：]/i.test(s) ||
      /^\s*\[?\s*r\s*\]?\s*[:：]/i.test(s) ||
      /^\s*s\s*[:：]/i.test(s) ||
      /^\s*r\s*[:：]/i.test(s) ||
      /^\s*(발신|가해자|sender)\s*[:：]/i.test(s) ||
      /^\s*(수신|사용자|receiver)\s*[:：]/i.test(s)
    );
  });

  for (let k = 0; k < selected.length; k++) {
    const originalIndex = selected[k].originalIndex; // 0-based
    const rawBlock = selected[k].text || "";
    const parsed = parseHeaderAndContent(rawBlock);
    const content = parsed.content || rawBlock || "";
    const urls = extractUrls(content);

    const actorHint = classifyActorHint(content);

    const speaker = String(parsed.speakerLabel || "").trim();
    const role: "S" | "R" | "U" =
      /^(s|발신|가해자|sender)\b/i.test(speaker) ? "S" : /^(r|수신|사용자|receiver)\b/i.test(speaker) ? "R" : "U";

    // Threat 반영 여부:
    // - S/R 라벨 있으면 S만 (+ 라벨 없는 줄은 demand일 때만)
    // - 라벨 없으면 comply는 기본 R로 보고 제외
    const includeInThreat = hasExplicitRole ? role === "S" || (role === "U" && actorHint === "demand") : actorHint !== "comply";

    const baseHits = includeInThreat ? scoreMessage(content, rules).sort((a, b) => b.weight - a.weight) : [];
    const urlHits = includeInThreat ? scoreUrls(content, urls, weights) : [];
    const ctxHits: Hit[] = [];

    if (includeInThreat) {
      if (actorHint === "demand")
        addCtxHit(ctxHits, "ctx_demand", "맥락: 요구/지시 표현(발신 요구 가능)", "verify", 3, content, ["demand"]);

      const hasOtpCueLocal =
        /(인증번호|otp|오티피|승인\s*번호|승인번호|보안\s*코드|보안코드|확인\s*코드|확인코드|ars|2\s*단계\s*인증|6\s*자리|6자리)/i.test(
          content
        );

      if (hasOtpCueLocal) seenOtpCueInThread = true;

      const otpRelayDemand =
        (hasOtpCueLocal || seenOtpCueInThread) &&
        /(보내|알려|전달|말해|읽어|불러|캡처|말씀)/i.test(content) &&
        /(번호|코드|인증|6\s*자리|6자리)/i.test(content);

      if (otpRelayDemand) addCtxHit(ctxHits, "ctx_otp_relay", "맥락: 인증번호/코드 전달 요구", "verify", 20, content, ["otp-relay"]);

      const hasAppInstallPhrase =
        /(보안\s*앱|인증\s*앱|전용\s*앱|앱|어플|프로그램|문서\s*뷰어|뷰어|viewer|플러그인|plugin).{0,22}(설치|다운로드|받아|깔아|설치해|설치\s*권고|권고\s*드립니다)/i.test(
          content
        );

      const hasNamedRemoteApp = /(팀뷰어|teamviewer|anydesk|애니데스크|퀵서포트|quicksupport)/i.test(content);
      const hasGenericRemotePhrase = /(원격\s*(지원|제어|접속|앱)|화면\s*공유|화면공유)/i.test(content);
      const hasInstallVerb = /(설치|다운로드|받아|깔아|실행|연결|접속|등록)/i.test(content);
      const hasInstallButtonPhrase = /(설치).{0,10}(버튼|button|눌러|누르|클릭)/i.test(content);

      const installMention =
        hasAppInstallPhrase || hasNamedRemoteApp || (hasGenericRemotePhrase && hasInstallVerb) || hasInstallButtonPhrase;

      if (installMention) addCtxHit(ctxHits, "ctx_install_mention", "맥락: 앱/원격/뷰어 설치 언급", "install", 18, content, ["install"]);

      const otpProxy =
        /(대신).{0,10}(입력|처리|인증)/i.test(content) &&
        /(인증번호|otp|오티피|확인\s*코드|확인코드|보안\s*코드|보안코드|6\s*자리|6자리|ars|2\s*단계\s*인증)/i.test(content);
      if (otpProxy) addCtxHit(ctxHits, "ctx_otp_proxy", "맥락: 인증번호를 대신 입력/처리(가로채기)", "verify", 30, content, ["otp-proxy"]);

      const piiRequest =
        /(이름|성함|연락처|전화번호|휴대폰|생년월일|주민등록번호|주민번호|주소|우편번호|계좌번호|카드번호|비밀번호|패스워드|암호|신분증|여권)/i.test(
          content
        ) &&
        /(알려|말해|남겨|적어|입력|작성|보내|제출|올려|전송|사진|캡처)/i.test(content);

      if (piiRequest) addCtxHit(ctxHits, "pii_request", "개인정보 요청", "verify", 18, content, ["pii-request"]);

      const financeContext = /(카드|카드사|은행|금융|보안센터|차단센터|분실|해제|승인|결제|해외\s*결제|자동이체|계좌|로그인)/i.test(content);
      if (otpRelayDemand && financeContext)
        addCtxHit(ctxHits, "ctx_otp_finance", "맥락: 금융/카드 문맥에서 인증번호 요구", "verify", 28, content, ["otp+finance"]);

      const hasStrongTransferCueLocal = /(입금|송금|이체|납부|지불|충전|선납|보험료)/i.test(content) || hasAmountKRW(content);
      const escrowLikeLocal = /(안전\s*결제|안전\s*거래|에스크로|escrow|거래)/i.test(content);

      const payWithLink =
        urls.length > 0 &&
        !/(결제\s*알림|알림\s*설정|계좌\s*알림|설정\s*변경|설정이\s*변경|설정\s*확인|자동이체\s*등록|자동\s*이체\s*등록|다른\s*기기\s*로그인\s*시도\s*감지|로그인\s*시도\s*감지|접속\s*시도\s*감지)/i.test(
          content
        ) &&
        (/(링크|페이지|사이트).{0,18}(에서|로).{0,12}(납부|결제|지불|송금|이체|입금)/i.test(content) ||
          /(납부|결제|지불|송금|이체|입금).{0,18}(링크|페이지|사이트)/i.test(content)) &&
        (/(해\s*줘|해줘|해\s*주|해주|해주세요|하세요|하셔야|진행|처리|완료|부탁|요청|바랍니다)/i.test(content) || hasStrongTransferCueLocal);

      if (payWithLink) addCtxHit(ctxHits, "ctx_pay_with_link", "맥락: 링크에서 납부/결제 유도", "payment", 22, content, ["pay+link"]);

      const safeAccountPhrase =
        /(안내\s*계좌|보호\s*계좌|안전\s*계좌|지정\s*계좌).{0,24}(이체|송금|입금|옮기|이전)/i.test(content) ||
        /(피해자\s*로\s*분류|자산\s*분리|자산\s*이동|보호\s*조치).{0,24}(계좌|이체|송금|입금|옮기|이전)/i.test(content) ||
        /(자금세탁|범죄자금|수사\s*협조|검찰|경찰|보호센터|수사관|수사팀).{0,40}(계좌|이체|송금|입금|옮기|이전|보호)/i.test(
          content
        );

      if (safeAccountPhrase) {
        addCtxHit(ctxHits, "ctx_transfer_phrase", "맥락: 안내계좌/보호조치/자산이전 유도", "payment", 28, content, ["transfer-phrase"]);
        addCtxHit(ctxHits, "transfer", "맥락: 안내 계좌로 이체/송금 유도", "payment", 18, content, ["transfer"]);
      }

      const paymentVerb =
        /(보내\s*줘|보내줘|부쳐\s*줘|부쳐줘|입금\s*해|입금해|송금\s*해|송금해|이체\s*해|이체해|납부\s*해|납부해|지불\s*해|지불해|충전\s*해|충전해)/i.test(
          content
        ) ||
        /(입금|송금|이체|납부|지불|충전|선납|보험료).{0,14}(해\s*줘|해줘|해\s*주|해주|해주세요|부탁|요청|하셔야|바랍니다|주시)/i.test(
          content
        ) ||
        /(납부|지불|결제).{0,14}(하세요|바랍니다|필요|진행|처리|해주세요)/i.test(content) ||
        /(링크|페이지).{0,14}(에서|로).{0,12}(납부|결제|지불)/i.test(content);

      const paymentAlertOnly = isPaymentAlertOnlyText(content);
      const payBlockedByInstall =
        installMention && !hasStrongTransferCueLocal && (escrowLikeLocal || /결제.{0,10}(하려면|위해|하려고)/i.test(content));

      if (paymentVerb && !paymentAlertOnly && !payBlockedByInstall)
        addCtxHit(ctxHits, "ctx_payment_request", "맥락: 입금/송금/충전/납부 요청", "payment", 20, content, ["pay"]);

      const familyHook = /(엄마|아빠|어머니|아버지|누나|언니|형|오빠|딸|아들|친구|지인)/i.test(content);
      const deviceExcuse =
        /(폰|휴대폰|핸드폰|전화).*(고장|분실|바꿨|바꿔|새\s*번호|이\s*번호|번호야)/i.test(content) ||
        /(번호야|새\s*번호|이\s*번호로)/i.test(content);
      const moneyAsk =
        /(보내\s*줘|보내줘|이체|송금|입금)/i.test(content) && /(\d{1,3}(?:,\d{3})+|\d+)\s*(원|만원)/i.test(content);

      if (familyHook && deviceExcuse && moneyAsk)
        addCtxHit(ctxHits, "ctx_family_scam", "맥락: 가족/지인 사칭 + 새 번호/폰 고장 + 송금 요구", "payment", 30, content, ["family+pay"]);

      const jobHook =
        /(고액\s*알바|알바|재택|해외|현지|동남아|출국|파견|해외\s*근무|해외\s*업무|해외\s*단기|단기\s*고수익|고수익\s*업무|프로젝트\s*인력|인력\s*모집|채용|숙식\s*제공|항공권\s*지원)/i.test(
          content
        );

      // (신규) 고수익/단기/당일지급류 훅(취업사기 프리필터/본분석 트리거용)
      const jobHookWide =
        /(고수익|고액\s*알바|단기\s*알바|단기\s*고수익|당일\s*지급|당일지급|재택\s*알바|초보\s*가능|간단한\s*업무|리뷰\s*알바|댓글\s*알바)/i.test(
          content
        );

      // (신규) 연락처/플랫폼 이동 유도(오픈채팅/텔레그램 등)
      const contactMove =
        /(오픈\s*채팅|오픈채팅|open\s*chat|openchat|텔레그램|telegram|카카오\s*오픈|오픈\s*카톡|라인|line|디스코드|discord|dm|쪽지|1:1|개인\s*톡)/i.test(
          content
        ) && /(이동|입장|초대|링크|추가|문의|연락|대화|채팅|안내)/i.test(content);

      // (신규) 특정 장소 방문/이동 유도(교육장/면접장/사무실/공항/역 출구/주소/지도)
      const visitPlace =
        /(방문|내방|출석|출두|집결|모여|오세요|오셔|오시면|오라|와라|와\s*주세요|이동해\s*주세요|지금\s*이동|현장|교육장|면접장|사무실|지점|센터|공항|터미널|역\s*\d*\s*번?\s*출구|출구|주소|오시는\s*길|지도|로비|주차장|층|호)/i.test(
          content
        ) && /(오|오셔|오시면|방문|출석|출두|집결|이동|모여)/i.test(content);

      const personalAskStrong =
        /(여권|신분증|주민등록증|주민번호|계좌|계좌번호|연락처|전화번호).{0,22}(사진|등록|보내|제출|올려|필요|요청)/i.test(content);

      const personalMention = /(여권|신분증|주민등록증|주민번호|계좌|계좌번호|연락처|전화번호)/i.test(content);
      const personalAsk = personalAskStrong || (personalMention && /(필요|요청|등록|제출|선\s*등록|먼저\s*보내)/i.test(content));

      // (신규) 선입금/보증금/수수료 요구 → ctx_payment_request로 통합(기존 hasPayRequest가 잡아먹게)
      const feeRequest =
        /(보증금|예치금|가입비|등록비|교육비|수수료|선입금|입회비|예약금|계약금|보안\s*예치)/i.test(content) &&
        /(송금|이체|입금|결제|납부|먼저|필요|부탁|내)/i.test(content);

      // (신규) 이체/송금 “지시” (transfer 단독보다 강하게)
      const transferDemand =
        /(이체|송금|입금|결제|납부).{0,20}(해\s*주세요|해주세요|바랍니다|하라|해라|하시|지금|바로)/i.test(content) ||
        /(해\s*주세요|해주세요|바랍니다|하라|해라|지금|바로).{0,20}(이체|송금|입금|결제|납부)/i.test(content);

      // (신규) 현금 수거/퀵 전달(대면전달)
      const cashPickup =
        /(현금\s*봉투|현금\s*수거|현금\s*전달|퀵|퀵서비스|대면\s*전달|직접\s*전달|수거|회수)/i.test(content) &&
        /(전달|수거|회수|가져오|가져와|보내|받)/i.test(content);

      // (신규) 상품권/기프트카드/핀번호 요구
      const giftcardDemand =
        /(상품권|문화\s*상품권|문상|해피머니|해피\s*머니|구글\s*기프트|google\s*gift|기프트\s*카드|gift\s*card|틴\s*캐시|tincash|핀\s*번호|pin\s*(번호|code)|바코드)/i.test(
          content
        ) && /(보내|전달|구매|충전|등록|입력|코드|핀|pin|번호)/i.test(content);

      // (신규) 코인/가상자산 지갑주소/체인/거래소 송금
      const cryptoWalletDemand =
        /(가상\s*자산|가상자산|암호\s*화폐|암호화폐|crypto|코인|지갑|wallet|지갑\s*주소|주소|usdt|btc|eth|trc20|erc20|바이낸스|binance|업비트|upbit|빗썸|bithumb)/i.test(
          content
        ) && /(송금|전송|보내|입금|충전|이체|전달)/i.test(content);

      // (신규) 통장/계좌 대여·명의대여·수령대행
      const accountRental =
        /(대포\s*통장|자금\s*세탁|범죄\s*자금|수령\s*대행|수령대행)/i.test(content) ||
        (/(통장|계좌).{0,18}(대여|임대|빌려|양도|사용)/i.test(content) && /(수수료|알바|대행|모집|구인)/i.test(content));

      // (신규) QR/간편결제 스캔/찍고 결제 유도
      const qrPayDemand =
        /(qr\s*코드|qr코드|큐알\s*코드|큐알코드|간편\s*결제|간편결제|페이|토스|카카오\s*페이|kakao\s*pay|네이버\s*페이|naver\s*pay)/i.test(
          content
        ) && /(찍|스캔|scan|결제|송금|이체|입금|진행|처리)/i.test(content);

      // (신규) 환불/취소/해지/구독결제 미끼(단독은 verify, 다른 액션과 결합 시 상승)
      const refundLure =
        /(환불|환급|취소|해지|구독|정기\s*결제|정기결제|자동\s*결제|자동결제|결제\s*취소)/i.test(content) &&
        /(상담|고객센터|문의|링크|url|주소|접속|클릭|안내)/i.test(content);

      // (신규) 대출/대환/저금리/한도 훅(단독은 verify, 수수료/선입금 결합 시 상승)
      const loanHook =
        /(대출|대환|저금리|한도|승인|연체|상환)/i.test(content) &&
        /(가능|진행|신청|조회|상담|조건|수수료|보증금|선입금|예치금)/i.test(content);

      // ── ctx hits (가중치: jobHookWide + contactMove + visitPlace 조합만으로도 65↑ 가능)
      if (jobHookWide) addCtxHit(ctxHits, "ctx_job_hook", "맥락: 고수익/단기 구인 미끼", "verify", 22, content, ["job-hook"]);

      if (contactMove) addCtxHit(ctxHits, "ctx_contact_move", "맥락: 오픈채팅/텔레그램 이동 유도", "verify", 22, content, ["contact-move"]);

      if (visitPlace) addCtxHit(ctxHits, "ctx_visit_place", "맥락: 특정 장소 방문/이동 유도", "verify", 14, content, ["visit"]);

      if (feeRequest) addCtxHit(ctxHits, "ctx_payment_request", "맥락: 보증금/수수료/선입금 요구", "payment", 28, content, ["fee"]);

      if (transferDemand) addCtxHit(ctxHits, "ctx_transfer_demand", "맥락: 이체/송금 지시", "payment", 26, content, ["transfer-demand"]);

      if (cashPickup) addCtxHit(ctxHits, "ctx_cash_pickup", "맥락: 현금 수거/퀵 전달 유도", "payment", 32, content, ["cash-pickup"]);

      if (giftcardDemand) addCtxHit(ctxHits, "ctx_giftcard", "맥락: 상품권/기프트카드/핀번호 요구", "payment", 34, content, ["giftcard"]);

      if (cryptoWalletDemand) addCtxHit(ctxHits, "ctx_crypto_wallet", "맥락: 코인/지갑주소 송금 요구", "payment", 34, content, ["crypto-wallet"]);

      if (accountRental) addCtxHit(ctxHits, "ctx_account_rental", "맥락: 통장/계좌 대여·수령대행 유도", "payment", 32, content, ["account-rental"]);

      if (qrPayDemand) addCtxHit(ctxHits, "ctx_qr_pay", "맥락: QR/간편결제 스캔·결제 유도", "payment", 28, content, ["qr-pay"]);

      if (refundLure) addCtxHit(ctxHits, "ctx_refund_lure", "맥락: 환불/취소/해지 미끼", "verify", 14, content, ["refund-lure"]);

      if (loanHook) addCtxHit(ctxHits, "ctx_loan_hook", "맥락: 대출/대환/한도 미끼", "verify", 12, content, ["loan-hook"]);

      // 기존(유지): jobHook + 신분/계좌 요구는 강하게
      if (jobHook && personalAsk) addCtxHit(ctxHits, "ctx_job_scam", "맥락: 고액/해외 구인 + 신분/계좌 요구", "verify", 30, content, ["job+id"]);

      const investHook = /(투자|리딩방|수익|자동\s*투자|코인|주식|단타|vip|체험|정보방|오픈채팅)/i.test(content);
      if (investHook && urls.length) addCtxHit(ctxHits, "ctx_investment_link", "맥락: 투자/리딩방 + 링크", "verify", 12, content, ["invest+link"]);

      // 지원금/환급/보조금: "URL 실제 포함"은 강하게, "링크/신청 언급만"은 약하게(verify 후보 표시)
      const benefitKw = /(지원금|환급|보조금|대상자|대상\s*조회|조회|신청|지급|정부\s*지원|복지)/i.test(content);
      const benefitLink = urls.length > 0 && benefitKw;
      if (benefitLink) addCtxHit(ctxHits, "ctx_benefit_link", "맥락: 지원/환급/대상자 조회 + 링크", "verify", 18, content, ["benefit+link"]);

      const benefitMention =
        urls.length === 0 &&
        benefitKw &&
        /(링크|url|주소|신청|조회|확인|접속|클릭|눌러|입력|등록)/i.test(content);
      if (benefitMention)
        addCtxHit(ctxHits, "ctx_benefit_link_mention", "맥락: 지원/환급/대상자 조회 + 링크 언급", "verify", 8, content, [
          "benefit+link-mention",
        ]);

      // 메신저/프로필 확인 + 링크 언급: URL이 없어도 약하게(verify 후보), URL이 있으면 urlHits가 추가로 올려준다
      const profileLinkMention =
        urls.length === 0 &&
        /(카톡|카카오톡|프로필|사진|영상|문서)/i.test(content) &&
        /(링크|url|주소)/i.test(content) &&
        /(확인|클릭|접속|눌러|열어|들어가)/i.test(content);
      if (profileLinkMention)
        addCtxHit(ctxHits, "ctx_profile_link_mention", "맥락: 메신저/프로필 확인 + 링크 언급", "verify", 10, content, [
          "profile+link-mention",
        ]);

      const bizDocLink =
        urls.length > 0 &&
        /(거래처|세금계산서|계산서|견적서|발주서|계약서|회계|정산|invoice|tax\s*invoice|bill|청구서)/i.test(content);
      if (bizDocLink) addCtxHit(ctxHits, "ctx_biz_doc_link", "맥락: 업무/회계 문서 + 링크", "verify", 14, content, ["bizdoc+link"]);

      const bizViewerInstall =
        bizDocLink && /(뷰어|viewer|문서\s*뷰어|플러그인|plugin)/i.test(content) && /(설치|다운로드|받아|깔아)/i.test(content);
      if (bizViewerInstall) addCtxHit(ctxHits, "ctx_biz_doc_install", "맥락: 업무 문서 열람을 위한 뷰어 설치 유도", "install", 12, content, ["bizdoc+install"]);
    }

    const msgHitsRaw = includeInThreat ? [...baseHits, ...urlHits, ...ctxHits].sort((a, b) => b.weight - a.weight) : [];
    const msgScore = includeInThreat ? Math.min(100, msgHitsRaw.reduce((s, h) => s + h.weight, 0)) : 0;

    const { stage, triggers, normalized } = stageFromHitsV2(content, msgHitsRaw);

    messageSummaries.push({
      index: originalIndex + 1,
      text: rawBlock,
      header: parsed.header || undefined,
      speakerLabel: parsed.speakerLabel || undefined,
      content,
      actorHint,
      role,
      preview: content.length > 220 ? content.slice(0, 220) + "…" : content,
      score: msgScore,
      urls,
      stage,
      stageTriggers: triggers,
      topRules: normalized.slice(0, 3).map((h) => ({ label: h.label, stage: h.stage, weight: h.weight })),
      includeInThreat,
    });

    if (includeInThreat) hits.push(...normalized);
  }

  // (라벨 없을 때만) demand→comply 연쇄 등의 맥락 히트 유지
  if (!hasExplicitRole) {
    for (let i = 0; i < messageSummaries.length; i++) {
      const a = messageSummaries[i];
      if (a.actorHint !== "demand") continue;

      for (let j = i + 1; j <= Math.min(i + 2, messageSummaries.length - 1); j++) {
        const b = messageSummaries[j];
        if (b.actorHint !== "comply") continue;

        const speakerDiff = a.speakerLabel && b.speakerLabel ? String(a.speakerLabel) !== String(b.speakerLabel) : false;
        const stage = maxStage(a.stage, b.stage);
        const w = speakerDiff ? 12 : 8;

        hits.push({
          ruleId: "ctx_comply_after_demand",
          label: "맥락: 요구 직후 동의/수락(연쇄 위험)",
          stage: stage === "info" ? "verify" : stage,
          weight: w,
          matched: [`BLK ${a.index} → BLK ${b.index}`],
          sample: `${a.preview} / ${b.preview}`.slice(0, 180),
        });

        break;
      }
    }

    for (let i = 0; i < messageSummaries.length; i++) {
      const a = messageSummaries[i];
      if (!a.urls || a.urls.length === 0) continue;

      for (let j = i + 1; j <= Math.min(i + 2, messageSummaries.length - 1); j++) {
        const b = messageSummaries[j];
        const denial =
          /(신청\s*안\s*했|신청\s*한\s*적\s*없|한\s*적\s*없|누른\s*적\s*없|기억\s*없|모르겠|아닌데요|제가\s*아닌데|저\s*아닌데|왜\s*오죠)/i.test(
            String(b.content || b.preview || "")
          );
        if (!denial) continue;

        const speakerDiff = a.speakerLabel && b.speakerLabel ? String(a.speakerLabel) !== String(b.speakerLabel) : false;
        const w = speakerDiff ? 14 : 10;

        hits.push({
          ruleId: "ctx_denial_after_link",
          label: "맥락: 링크 제시 직후 본인 부인/미신청",
          stage: "verify",
          weight: w,
          matched: [`BLK ${a.index} → BLK ${b.index}`],
          sample: `${a.preview} / ${b.preview}`.slice(0, 180),
        });

        break;
      }
    }

    for (let i = 0; i < messageSummaries.length; i++) {
      const a = messageSummaries[i];
      const aText = String(a.content || "");
      const aOtpDemand =
        /(인증번호|otp|오티피|확인\s*코드|보안\s*코드|6\s*자리|6자리|ars|2\s*단계\s*인증)/i.test(aText) &&
        /(보내|알려|전달|말해|읽어|불러|캡처|말씀)/i.test(aText);

      if (!aOtpDemand) continue;

      for (let j = i + 1; j <= Math.min(i + 2, messageSummaries.length - 1); j++) {
        const b = messageSummaries[j];
        const denial =
          /(신청\s*안\s*했|신청\s*한\s*적\s*없|한\s*적\s*없|누른\s*적\s*없|기억\s*없|모르겠|아닌데요|제가\s*아닌데|저\s*아닌데|왜\s*오죠|분실\s*신고\s*안|분실\s*접수\s*안|내가\s*아닌|제가\s*아닌)/i.test(
            String(b.content || b.preview || "")
          );
        if (!denial) continue;

        hits.push({
          ruleId: "ctx_denial_after_otp",
          label: "맥락: 인증번호 요구 직후 본인 부인/미신청",
          stage: "verify",
          weight: 14,
          matched: [`BLK ${a.index} → BLK ${b.index}`],
          sample: `${a.preview} / ${b.preview}`.slice(0, 180),
        });

        break;
      }
    }
  }

  const W_FIRST_CONTACT = 10;

  if (call?.otpAsked) {
    hits.push({
      ruleId: "call_otp",
      label: "통화: 인증번호/OTP 요구",
      stage: "verify",
      weight: weights.callOtp,
      matched: ["(call) otp asked"],
      sample: "통화 맥락 체크박스",
    });
  }
  if (call?.remoteAsked) {
    hits.push({
      ruleId: "call_remote",
      label: "통화: 원격/앱 설치 유도",
      stage: "install",
      weight: weights.callRemote,
      matched: ["(call) remote asked"],
      sample: "통화 맥락 체크박스",
    });
  }
  if (call?.urgentPressured) {
    hits.push({
      ruleId: "call_urgent",
      label: "통화: 긴급/압박",
      stage: "info",
      weight: weights.callUrgent,
      matched: ["(call) urgent pressured"],
      sample: "통화 맥락 체크박스",
    });
  }
  if (call?.firstContact) {
    hits.push({
      ruleId: "call_first_contact",
      label: "통화: 처음 연락(미등록 발신)",
      stage: "info",
      weight: W_FIRST_CONTACT,
      matched: ["(call) first contact"],
      sample: "번호 기반 자동 판정",
    });
  }

  // ✅ 스레드 합산: 누진(반복 ruleId 폭주 방지)
  const diminishedHits: Hit[] = applyDiminishingByRuleId(hits);
  const sortedHits: Hit[] = [...diminishedHits].sort((a: Hit, b: Hit) => b.weight - a.weight);
  const scoreTotal = Math.min(100, sortedHits.reduce((sum: number, h: Hit) => sum + h.weight, 0));

  // stagePeak은 “Threat에 포함된 메시지들” 기준으로 한번 더 산정 (R/comply 영향 제거)
  const rawThread = selected.map((x) => x.text).join("\n");

  const threatThread = messageSummaries
    .filter((m) => m.includeInThreat)
    .map((m) => String(m.content || m.text || ""))
    .filter(Boolean)
    .join("\n");

  const stageText = threatThread || rawThread;
  const { stage: stagePeak, triggers: stageTriggers } = stageFromHitsV2(stageText, sortedHits);

  const riskHits = hits; // risk 판단은 '전체 hits' 기준(가중치 0 hit 포함)

  const hasRemote = riskHits.some((h) => h.ruleId === "remote" || h.ruleId === "call_remote");
  const hasOtp = riskHits.some((h) => h.ruleId === "otp" || h.ruleId === "call_otp" || h.ruleId === "ctx_otp_relay");
  const hasFirst = riskHits.some((h) => h.ruleId === "call_first_contact");
  const hasApk = riskHits.some((h) => h.ruleId === "apk" || h.ruleId === "url_download_ext" || h.ruleId === "install_app");
  const hasLink = riskHits.some(
    (h) =>
      h.ruleId === "link" ||
      h.ruleId === "shortener" ||
      h.ruleId === "link_mention" ||
      h.ruleId === "ctx_profile_link_mention"
  );
  const hasThreat = riskHits.some((h) => h.ruleId === "threat");
  const hasAuthority = riskHits.some((h) => h.ruleId === "authority");
  const hasTxnAlert = riskHits.some((h) => h.ruleId === "txn_alert");
  const hasUrgentHit = riskHits.some((h) => h.ruleId === "urgent" || h.ruleId === "call_urgent");

  const hasJobScam = riskHits.some((h) => h.ruleId === "ctx_job_scam");
  const hasInvest = riskHits.some((h) => h.ruleId === "ctx_investment_link");
  const hasInstallMention = riskHits.some((h) => h.ruleId === "ctx_install_mention");

  // ✅ 설치/원격/다운로드 계열을 “단일 boolean”로 묶어서 구조판정/코어액션에 일관 반영
  const hasInstallAny = riskHits.some((h) =>
    ["ctx_install_mention", "install_app", "apk", "remote", "url_download_ext"].includes(String(h?.ruleId ?? ""))
  );

  const hasFamily = riskHits.some((h) => h.ruleId === "ctx_family_scam");

  const hasDemand = riskHits.some(
    (h) => h.ruleId === "ctx_demand" || h.ruleId === "ctx_comply_after_demand" || h.ruleId === "ctx_otp_relay"
  );

  const hasOtpFinance = riskHits.some(
    (h) => h.ruleId === "ctx_otp_finance" || h.ruleId === "ctx_otp_proxy" || h.ruleId === "ctx_denial_after_otp"
  );

  const hasPiiRequest = riskHits.some((h) => h.ruleId === "pii_request" || h.ruleId === "personalinfo");

  const hasGoBankAtm = riskHits.some((h) => h.ruleId === "go_bank_atm");
  const hasTransfer =
    hasGoBankAtm || riskHits.some((h) => h.ruleId === "transfer" || h.ruleId === "safe_account" || h.ruleId === "ctx_transfer_phrase");
  const hasPayRequest = hasTransfer || riskHits.some((h) => h.ruleId === "ctx_payment_request" || h.ruleId === "ctx_pay_with_link");

  const hasContactMove = riskHits.some((h) => h.ruleId === "ctx_contact_move");
  const hasVisitPlace = riskHits.some((h) => h.ruleId === "ctx_visit_place");
  const hasTransferDemand = riskHits.some((h) => h.ruleId === "ctx_transfer_demand");
  const hasCashPickup = riskHits.some((h) => h.ruleId === "ctx_cash_pickup");
  const hasJobLure = riskHits.some((h) => h.ruleId === "job_lure");
  const hasJobHook = hasJobLure || riskHits.some((h) => h.ruleId === "ctx_job_hook");

  const hosts = getHostsFromText(rawThread);
  const hasUrl = hosts.length > 0;
  const hasLinkAny = hasLink || hasUrl;

  // ✅ (확정 신호) URL 검증/피싱 링크 판정이 들어오면 High 직행 가능하도록 훅 제공
  const hasMaliciousUrlHit = riskHits.some(
    (h) => h.ruleId === "url_malicious" || h.ruleId === "ctx_url_malicious" || h.ruleId === "messenger_phishing"
  );

  const itSupportCue = /회사\s*it|it\s*지원|공식\s*원격|helpdesk|헬프데스크|사내\s*공지|공지/i.test(rawThread);

  // 내부 포털/인프라로 '명확히' 보이는 호스트만 benign 후보로 취급
  const internalHost =
    hosts.some((h) => /(^|\.)intranet(\.|$)/i.test(h)) ||
    hosts.some((h) => /(^|\.)internal(\.|$)/i.test(h)) ||
    hosts.some((h) => /(^|\.)corp(\.|$)/i.test(h)) ||
    hosts.some((h) => /(^|\.)portal(\.|$)/i.test(h)) ||
    hosts.some((h) => /(^|\.)servicenow(\.|$)/i.test(h)) ||
    hosts.some((h) => /(^|\.)jira(\.|$)/i.test(h)) ||
    hosts.some((h) => /(^|\.)confluence(\.|$)/i.test(h));

  // itSupportCue + internalHost가 동시에 성립하고, "강한 액션"이 없을 때만 benignSupport로 완화
  const benignSupport =
    itSupportCue &&
    internalHost &&
    !(
      hasInstallAny ||
      hasOtp ||
      hasOtpFinance ||
      hasPayRequest ||
      hasTransfer ||
      hasTransferDemand ||
      hasCashPickup ||
      hasVisitPlace ||
      hasPiiRequest ||
      hasJobHook ||
      !!(call?.otpAsked || call?.remoteAsked)
    );

  // ✅ 코어 액션(진행 단계의 핵): 이 중 하나라도 있어야 High 후보가 됨
  const hasCoreAction =
    hasOtp ||
    hasOtpFinance ||
    hasInstallAny ||
    hasPayRequest ||
    hasTransfer ||
    hasTransferDemand ||
    hasCashPickup ||
    hasVisitPlace ||
    hasPiiRequest ||
    hasJobHook ||
    !!(call?.otpAsked || call?.remoteAsked);

  // ✅ 단서 카운트(앵커(linkAny)는 단서로 치지 않음)
  //    - 앵커 + 귀결행동만: Medium
  //    - 단서(권위/협박/압박/요구/알림/첫연락/연락처이동/OTP-금융 + anti-verify/secrecy/송금지시) 1개 이상: High 후보
  const hasSecrecy = riskHits.some((h) => h.ruleId === "ctx_secrecy");

  // “공식 채널로 확인하지 마/끊지 마/다른 경로 금지/이 링크로만” 류 = 차단/고립(anti-verify)
  const antiVerifyCue =
    /(대표번호|고객센터|공식\s*번호).{0,20}(확인|전화).{0,20}(하지\s*마|말라)|끊지\s*마|끊으면\s*안\s*돼|다른\s*(채널|경로).{0,20}(쓰지\s*마|금지)|이\s*(링크|앱).{0,20}(로만|에서만|만).{0,10}(진행|처리)/i.test(
      rawThread
    );

  // OTP가 “안내(입력)”가 아니라 “공유 요구(알려/보내/전달/불러/읽어)” 형태일 때만 강한 요구로 취급
  const otpRequestCue =
    /(인증번호|otp).{0,24}(알려\s*줘|알려|말해|보내\s*줘|보내|전달|불러\s*줘|불러|읽어\s*줘|읽어|인증번호\s*줘|코드\s*줘)/i.test(
      rawThread
    );

  // 승인번호/보안코드/접속코드/6자리 등 “코드 탈취” 요구(캡처/전달/공유 포함)
  const codeRequestCue =
    /(승인번호|보안\s*(코드|번호)|보안코드|접속코드|확인코드|인증코드|approval\s*code|verification\s*code|6\s*자리\s*(코드|번호)).{0,40}(알려\s*줘|알려|말해|보내\s*줘|보내|전달|공유|캡처|캡쳐|찍어|스크린샷|화면\s*캡처)/i.test(
      rawThread
    );

  // “인증번호/OTP 입력” 흐름(링크+긴급/압박 결합 시 위험) — hardHigh에서만 사용
  const otpEntryCue = /(인증번호|otp).{0,30}(입력|인증|확인|진행|완료)/i.test(rawThread);

  const hasDemandLike = hasDemand || otpRequestCue || codeRequestCue;

  // 송금/ATM/보호계좌/“이체 문구” 같은 구체 지시(확증 단서)
  const moneyInstrCue = hasGoBankAtm || riskHits.some((h) => h.ruleId === "safe_account" || h.ruleId === "ctx_transfer_phrase");

  // B2B 문서/세금계산서/청구서류 + 링크/설치 조합용 단서(설치 FP 최소화)
  const docBusinessCue = /(세금계산서|청구서|invoice|인보이스|거래처|견적서|발주서|정산|대금)/i.test(rawThread);

  // URL 판정이 있어도 "행동"이 없으면 High 직행 금지(계정 리셋/2FA 안내 FP 완화)
  const maliciousUrlHardHigh =
    hasMaliciousUrlHit &&
    !benignSupport &&
    (hasInstallAny ||
      hasRemote ||
      hasPayRequest ||
      hasTransferDemand ||
      hasTransfer ||
      hasCashPickup ||
      hasOtpFinance ||
      otpRequestCue);

  const clueCount = [
    hasAuthority,
    hasThreat,
    hasUrgentHit,
    hasTxnAlert,
    hasDemandLike,
    hasFirst,
    hasContactMove,
    hasOtpFinance,
    hasRemote, // 원격/원격앱 유도는 매우 강한 단서로 카운트
    hasSecrecy,
    antiVerifyCue,
    moneyInstrCue,
  ].filter((x) => !!x).length;

  // 구조적 High 후보들(여기서 authority/threat/urgent는 “증폭기”)
  // ✅ 링크(앵커) + 설치/원격(귀결행동)만으로는 High 금지 → 단서 추가 필요
  const installHigh = hasLinkAny && hasInstallAny && clueCount >= 1 && !benignSupport;
  const apkHigh = hasLinkAny && hasApk && !benignSupport;

  const investHigh =
    hasInvest &&
    (hasLinkAny || hasContactMove) &&
    (hasInstallMention || hasApk || hasPayRequest || hasTransferDemand || hasUrgentHit || hasThreat || hasAuthority) &&
    !benignSupport;

  const otpAuthorityHigh = hasOtp && otpRequestCue && (hasThreat || hasAuthority || hasTxnAlert || hasOtpFinance) && !benignSupport;
  const otpLinkDemandHigh = hasOtp && hasLinkAny && otpRequestCue && !benignSupport;
  const otpDirectHigh = hasOtp && otpRequestCue && !benignSupport;

  const familyHigh = hasFamily && (hasPayRequest || hasUrgentHit || hasTransferDemand) && !benignSupport;

  const jobPiiHigh = hasLinkAny && hasJobScam && hasPiiRequest && !benignSupport;

  // 장소 방문/이동은 단독/느슨한 결합으로 High 승격 금지
  // - 취업/투자 훅 + 연락처 이동/링크 + 금전 액션(현금/이체/선입금 등)까지 붙을 때만 High 구조로 취급
  const visitHigh =
    hasVisitPlace &&
    (hasJobHook || hasJobScam || hasInvest) &&
    (hasContactMove || hasLinkAny) &&
    (hasCashPickup || hasTransferDemand || hasPayRequest || hasTransfer) &&
    !benignSupport;

  // (신규) 이체/송금 지시: 앵커+귀결행동만이면 Medium, 단서 추가 시 High
  const transferDemandHigh = (hasTransferDemand || hasTransfer) && clueCount >= 1 && !benignSupport;

  // (신규) 현금 수거/퀵 전달은 매우 강함
  const cashPickupHigh =
    hasCashPickup && (hasAuthority || hasThreat || hasUrgentHit || hasDemand || hasLinkAny || hasContactMove) && !benignSupport;

  // 결제/이체: 앵커+귀결행동만이면 Medium, 단서 추가 시 High
  const payHigh = hasPayRequest && clueCount >= 1 && !benignSupport;

  // (신규) 취업사기: 고수익/알바 + (연락처 이동) + (방문/이동 or 이체/선입금/현금) 조합
  const jobHigh =
    (hasJobHook || hasJobScam) &&
    (hasContactMove || hasLinkAny) &&
    (hasVisitPlace || hasPayRequest || hasTransferDemand || hasTransfer || hasCashPickup) &&
    !benignSupport;

  // ✅ Gate B(확증 단서) 보조 신호
  // NOTE: hasSecrecy / antiVerifyCue / moneyInstrCue 는 위에서 이미 선언됨(중복 선언 방지)

  // ✅ Gate A(강한 귀결행동 ‘요구’ 형태)
  // - ctx_demand 기반 + 콜체크(otpAsked/remoteAsked) + (이체/현금수거는 자체가 요구성 강함)
  const hasDemandForm =
    hasDemandLike ||
    hasTransferDemand ||
    hasCashPickup ||
    hasTransfer ||
    hasPayRequest ||
    hasInstallAny ||
    hasPiiRequest ||
    !!(call?.otpAsked || call?.remoteAsked);

  const gateA =
    !benignSupport &&
    hasDemandForm &&
    (hasOtp ||
      hasOtpFinance ||
      hasInstallAny ||
      hasPayRequest ||
      hasTransferDemand ||
      hasTransfer ||
      hasCashPickup ||
      hasVisitPlace ||
      hasPiiRequest ||
      hasJobHook);

  // ✅ Gate B: 확증 단서 ≥ 1 (요구형태 자체는 GateA에서 처리)
  const gateBCount = [
    hasAuthority,
    hasThreat,
    hasUrgentHit,
    hasTxnAlert,
    hasFirst,
    hasContactMove,
    hasOtpFinance,
    hasSecrecy,
    antiVerifyCue,
    moneyInstrCue,
    otpRequestCue, // OTP '공유 요구'는 확증 단서로 취급
  ].filter((x) => !!x).length;

  // ✅ hardHigh = (확정 신호) OR (GateA AND GateB>=1 AND 구조 매칭)
  const hardHigh =
    // hasMaliciousUrlHit 단독 High 금지: “행동/요구” 결합일 때만
    (!benignSupport &&
      hasMaliciousUrlHit &&
      (hasInstallAny ||
        hasRemote ||
        hasPayRequest ||
        hasTransferDemand ||
        hasTransfer ||
        hasCashPickup ||
        hasOtpFinance ||
        otpRequestCue ||
        codeRequestCue)) ||
    // 코드/승인번호/접속코드/6자리 등을 “보내/알려/캡처” 요구 + 링크 = 하드하이
    (!benignSupport && hasLinkAny && codeRequestCue) ||
    // “인증번호/OTP 입력” + 링크 + 긴급/압박/요구 신호 결합 = 하드하이
    // - txn_alert 단독은 제외(계정 보호/로그인 시도 안내 FP 완화)
    // - demand는 "계정 재설정/보안 경고/2FA 안내"류면 제외
    (!benignSupport &&
      hasLinkAny &&
      otpEntryCue &&
      (hasUrgentHit ||
        /(지금|즉시|바로|긴급|마감|서둘)/i.test(rawThread) ||
        hasThreat ||
        (hasAuthority && (hasUrgentHit || hasThreat)) ||
        (hasTxnAlert && (hasUrgentHit || hasThreat)) ||
        (hasDemand &&
          !/(비밀번호\s*재설정|계정\s*(보호|잠김|잠김\s*해제)|로그인\s*시도|다른\s*기기.{0,12}로그인|2\s*단계\s*인증|2fa|보안\s*경고)/i.test(
            rawThread
          )))) ||
    // B2B 문서/인보이스 미끼 + 링크 + 설치/원격/다운로드 계열 = 하드하이
    (!benignSupport && docBusinessCue && hasLinkAny && hasInstallAny) ||
    // 고액/고수익 알바/급구 + (링크/연락처이동/신분증요구) = 하드하이
    (!benignSupport &&
      (hasJobHook || hasJobScam || /(고액|고수익|일당|당일\s*지급|건당|재택|부업|급구)/i.test(rawThread)) &&
      (hasLinkAny || hasContactMove || hasPiiRequest)) ||
    (gateA &&
      gateBCount >= 1 &&
      hasCoreAction &&
      ((hasRemote && hasOtp) ||
        installHigh ||
        apkHigh ||
        otpAuthorityHigh ||
        otpLinkDemandHigh ||
        otpDirectHigh ||
        familyHigh ||
        jobPiiHigh ||
        payHigh ||
        investHigh ||
        visitHigh ||
        transferDemandHigh ||
        cashPickupHigh ||
        jobHigh ||
        (hasJobScam && !benignSupport)));

  let riskLevel: RiskLevel = toRiskLevel(scoreTotal, hardHigh);

  // ✅ High는 hardHigh 구조로만 허용(점수 누적/약한 단어 반복만으로 High 금지)
  // (기존 가드 유지: 코어 액션도 없으면 우선 Medium)
  if (riskLevel === ("high" as RiskLevel) && !hardHigh && !hasCoreAction) {
    riskLevel = "medium" as RiskLevel;
  }

  // hardHigh가 아니면 High 금지(코어 액션이 있어도 Medium으로 내림)
  if (riskLevel === ("high" as RiskLevel) && !hardHigh) {
    riskLevel = "medium" as RiskLevel;
  }

  // 조언 대화는 low
  if (isAdviceOnlyThread(rawThread)) riskLevel = "low" as RiskLevel;

  // 알림/설정/확인 링크 + “내가 했다/아니다”류는 high 금지 (실제 납부/이체 텍스트가 있으면 제외)
  const alertSettingThread =
    /(알림\s*설정|설정\s*변경|설정이\s*변경|설정\s*확인|결제\s*알림\s*설정|계좌\s*알림\s*설정|자동이체\s*등록|자동\s*이체\s*등록|다른\s*기기\s*로그인\s*시도\s*감지|로그인\s*시도\s*감지|접속\s*시도\s*감지)/i.test(
      rawThread
    );
  const selfAckThread = isSelfAckText(rawThread);
  const ackOrBenign =
    selfAckThread ||
    /(확인\s*만|확인만|문제\s*없|정상|제가\s*아닌데|제가\s*한\s*적\s*없|한\s*적\s*없|접수\s*안\s*했|모르겠|아닌데요)/i.test(
      rawThread
    );
  const hasExplicitPayWord =
    /(납부|송금|이체|입금|지불|충전|선납|보험료|안내\s*계좌|보호\s*계좌|안전\s*계좌|지정\s*계좌|상품권|문화\s*상품권|문상|핀\s*번호|pin|기프트\s*카드|gift\s*card|usdt|btc|eth|wallet|지갑\s*주소|trc20|erc20|바이낸스|업비트|빗썸)/i.test(
      rawThread
    );

  // ✅ OTP "입력 안내"만 있는 계정보호/리셋류는 high 금지(공유요구/코드탈취/금융OTP는 제외)
  const otpEntryOnly =
    otpEntryCue &&
    !otpRequestCue &&
    !codeRequestCue &&
    !hasOtpFinance;

  const alertSettingOnly =
    riskLevel === ("high" as RiskLevel) &&
    hasLink &&
    (alertSettingThread || hasTxnAlert) &&
    ackOrBenign &&
    !hasExplicitPayWord &&
    (!hasOtp || otpEntryOnly) &&
    !hasThreat &&
    !hasUrgentHit &&
    !hasRemote &&
    !hasApk &&
    !hasInstallMention &&
    !hasJobScam &&
    !hasInvest &&
    !hasFamily &&
    !benignSupport;

  if (alertSettingOnly) riskLevel = "medium" as RiskLevel;

  // 원격/설치만(금융/OTP/협박 없이) high 금지 (문서/세금계산서/인보이스 뷰어 유도는 예외)
  const bizDocLure =
    /(세금계산서|거래처|회계팀|인보이스|invoice|견적서|발주서|계약서|정산|반려|수정본|문서\s*(뷰어|viewer)|열람)/i.test(rawThread);

  const remoteOnly =
    riskLevel === ("high" as RiskLevel) &&
    hasInstallAny &&
    !bizDocLure &&
    !hasExplicitPayWord &&
    !hasOtp &&
    !hasThreat &&
    !hasAuthority &&
    !hasUrgentHit &&
    !hasJobScam &&
    !hasInvest &&
    !hasFamily &&
    !benignSupport;

  if (remoteOnly) riskLevel = "medium" as RiskLevel;

  // signals/hits 제공(엔진 index.ts에서 바로 사용)
  const signals = buildSignalsFromHits(sortedHits, 12);

  return {
    scoreTotal,
    riskLevel,
    stagePeak,
    stageTriggers,

    hits: sortedHits,
    signals,

    messageSummaries,
    context: windowed.meta,
  };
}