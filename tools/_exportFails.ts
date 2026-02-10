// tools/_exportFails.ts
import fs from "node:fs";
import path from "node:path";
import { analyzeThread } from "../src/engine/index";

function argValue(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0) return "";
  return String(process.argv[i + 1] ?? "");
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

const inPath = argValue("--in");
const outPath = argValue("--out");

if (!inPath || !outPath) {
  console.error(
    "Usage: npx tsx tools/_exportFails.ts --in <in.jsonl> --out <out.jsonl> [--prefer-ui|--prefer-threat]"
  );
  process.exit(2);
}

// 전역 강제 옵션(있으면 자동판정 무시)
const forcePreferUi = hasFlag("--prefer-ui") || hasFlag("--ui");
const forcePreferThreat = hasFlag("--prefer-threat") || hasFlag("--threat");

const STAGE_RANK: Record<string, number> = {
  none: 0,
  info: 1,
  verify: 2,
  payment: 3,
  install: 4,
};

function norm(s: any) {
  return String(s ?? "").trim().toLowerCase();
}

function pickRisk(x: any): "low" | "medium" | "high" | "" {
  const s = norm(x);
  if (s === "low" || s === "medium" || s === "high") return s;
  return "";
}

function preferUiForRow(row: any): boolean {
  if (forcePreferUi) return true;
  if (forcePreferThreat) return false;

  const exp = row?.expected ?? {};
  // expected에 uiRiskLevel/threatRiskLevel이 있으면 그걸 힌트로 자동 판정
  if (Object.prototype.hasOwnProperty.call(exp, "uiRiskLevel")) return true;
  if (Object.prototype.hasOwnProperty.call(exp, "threatRiskLevel")) return false;

  // 기본은 Threat(엔진 riskLevel) 기준
  return false;
}

function expectedRiskForRow(row: any, preferUi: boolean): "low" | "medium" | "high" | "" {
  const exp = row?.expected ?? {};
  if (preferUi) {
    return (
      pickRisk(exp?.uiRiskLevel) ||
      pickRisk(exp?.riskLevel) ||
      pickRisk(exp?.risk) ||
      ""
    );
  }
  return (
    pickRisk(exp?.threatRiskLevel) ||
    pickRisk(exp?.riskLevel) ||
    pickRisk(exp?.risk) ||
    ""
  );
}

function inferRisk(res: any, scoreThreat: number, preferUi: boolean): "low" | "medium" | "high" {
  // 1) preferUi면 uiRiskLevel 우선
  if (preferUi) {
    const u0 = pickRisk(res?.uiRiskLevel);
    if (u0) return u0;
  }

  // 2) threat riskLevel
  const r0 = pickRisk(res?.riskLevel ?? res?.risk ?? res?.riskLevelId);
  if (r0) return r0;

  // 3) fallback: 점수 기반(Threat score 기준)
  if (scoreThreat >= 65) return "high";
  if (scoreThreat >= 35) return "medium";
  return "low";
}

function inferTriggered(res: any, scoreForTrig: number) {
  // res.triggered는 일부 경로(callChecks:[] 등)에서 false로 고정될 수 있으니
  // 점수 기반을 기본으로 하고, res.triggered가 true일 때만 보강한다.
  const t0 = res?.triggered;
  if (t0 === true) return true;
  return scoreForTrig >= 35;
}

// ✅ stagePeak 없으면 timeline/hitsTop에서 최고 stage 추출
function inferStageFromRes(res: any) {
  const candidates: string[] = [];

  const tl = res?.stageTimeline;
  if (Array.isArray(tl) && tl.length) {
    for (const it of tl) {
      const s = norm(it?.stage ?? it?.stageId ?? it?.stagePeak ?? it?.peakStage);
      if (s) candidates.push(s);
    }
  }

  const hits = Array.isArray(res?.hitsTop) ? res.hitsTop : [];
  for (const h of hits) {
    let s = norm(h?.stage);
    if (!s) continue;

    // 방어적 매핑(혹시 다른 토큰으로 오는 경우)
    if (s === "transfer") s = "payment";
    if (s === "pay") s = "payment";

    candidates.push(s);
  }

  // (선택) 정말 마지막 fallback: stagePeak도 후보로만 추가
  const sp = norm(res?.stagePeak);
  if (sp) candidates.push(sp);

  let best = "none";
  let bestR = STAGE_RANK.none ?? 0;

  for (const s of candidates) {
    const r = STAGE_RANK[s];
    if (r == null) continue;
    if (r > bestR) {
      bestR = r;
      best = s;
    }
  }

  return best;
}

const raw = fs.readFileSync(inPath, "utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

const fails: string[] = [];
let i = 0;

for (const line of lines) {
  i++;
  const row = JSON.parse(line);

  const thread = String(row?.thread ?? row?.threadText ?? "");

  const preferUi = preferUiForRow(row);

  const expRisk = expectedRiskForRow(row, preferUi);
  const expScoreMin = Number(row?.expected?.score_min ?? 0);
  const expStage = norm(row?.expected?.stagePeak ?? row?.expected?.stage_peak ?? "");
  const expTrig = row?.expected?.triggered;

  const input = {
    threadText: thread,
    callChecks: {
      otpAsked: false,
      remoteAsked: false,
      urgentPressured: false,
      firstContact: false,
      ...(row.callChecks ?? {}),
    },
  };

  const res = await analyzeThread(input as any);

  const scoreThreat = Number(res?.scoreTotal ?? 0);
  const scoreUi = Number((res as any)?.uiScoreTotal ?? scoreThreat);

  // score_min / triggered 기준은 preferUi에 맞춰 선택
  const scoreForMin = preferUi ? scoreUi : scoreThreat;

  const gotRisk = inferRisk(res, scoreThreat, preferUi);
  const gotStage = inferStageFromRes(res);
  const gotTrig = inferTriggered(res, scoreForMin);

  const why: string[] = [];
  if (expRisk && expRisk !== gotRisk) why.push(`risk ${expRisk} -> ${gotRisk}`);
  if (expScoreMin > 0 && scoreForMin < expScoreMin) why.push(`score ${scoreForMin} < ${expScoreMin}`);
  if (expStage && expStage !== gotStage) why.push(`stage ${expStage} -> ${gotStage}`);
  if (typeof expTrig === "boolean" && expTrig !== gotTrig) why.push(`triggered ${expTrig} -> ${gotTrig}`);

  if (why.length) {
    row.meta_fail = {
      preferUi,
      why,
      got: {
        scoreTotal: scoreThreat,
        uiScoreTotal: scoreUi,
        riskLevel: gotRisk,
        threatRiskLevel: pickRisk((res as any)?.riskLevel) || "",
        uiRiskLevel: pickRisk((res as any)?.uiRiskLevel) || "",
        rGateTag: String((res as any)?.rGateTag ?? "").trim() || undefined,
        stagePeak: gotStage,
        triggered: gotTrig,
      },
      exp: {
        riskLevel: expRisk || "",
        score_min: expScoreMin || 0,
        stagePeak: expStage || "",
        triggered: typeof expTrig === "boolean" ? expTrig : undefined,
      },
    };
    fails.push(JSON.stringify(row));
  }

  if (i % 50 === 0) console.log("scan", i, "/", lines.length, "fails", fails.length);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, fails.join("\n") + (fails.length ? "\n" : ""), "utf8");
console.log("OK: fails", fails.length, "->", outPath);
