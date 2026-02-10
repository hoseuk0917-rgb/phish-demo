import fs from "node:fs";
import path from "node:path";
import { analyzeThread } from "../src/engine/index";

type StageId = "info" | "verify" | "install" | "payment";
type RiskLevel = "low" | "medium" | "high";

type AnyObj = Record<string, any>;

const STAGE_RANK: Record<StageId, number> = { info: 0, verify: 1, install: 2, payment: 3 };

function stagePeakFromResult(r: any): StageId {
  const norm = (v: any): StageId | null => {
    const s0 = String(v ?? "").trim().toLowerCase();
    if (!s0) return null;
    if (s0 === "info" || s0 === "inform") return "info";
    if (s0 === "verify" || s0 === "verification") return "verify";
    if (s0 === "install" || s0 === "setup" || s0 === "remote") return "install";
    if (s0 === "payment" || s0 === "pay" || s0 === "transfer") return "payment";
    return null;
  };

  let best: StageId = "info";

  const bump = (v: any) => {
    const s = norm(v);
    if (!s) return;
    if (STAGE_RANK[s] > STAGE_RANK[best]) best = s;
  };

  // 엔진이 stagePeak 같은 요약 필드를 주는 경우 우선 반영
  bump(r?.stagePeak);
  bump(r?.stage_peak);
  bump(r?.stagePeakByHitsTop);
  bump(r?.stagePeakByTimeline);
  bump(r?.stagePeakByMessageSummaries);

  const ms = Array.isArray(r?.messageSummaries) ? r.messageSummaries : [];
  for (const m of ms) bump(m?.stage);

  const tl = Array.isArray(r?.stageTimeline) ? r.stageTimeline : [];
  for (const e of tl) bump(e?.stage);

  const ht = Array.isArray(r?.hitsTop) ? r.hitsTop : [];
  for (const h of ht) bump(h?.stage);

  return best;
}

function triggeredFromResult(r: any): boolean {
  const pf: any = r?.prefilter;
  if (!pf) return false;

  if (typeof pf.triggered === "boolean") return pf.triggered;
  if (typeof pf.isTriggered === "boolean") return pf.isTriggered;
  if (typeof pf.gatePass === "boolean") return pf.gatePass;

  if (Array.isArray(pf.triggers) && pf.triggers.length) return true;
  if (Array.isArray(pf.hitRules) && pf.hitRules.length) return true;

  return false;
}

function senderTextFromThread(thread: string) {
  const lines = String(thread || "").split(/\r?\n/);
  const sLines = lines.filter((l) => /^S:\s*/.test(l.trim()));
  return sLines.join("\n").trim();
}

function parseArgs(argv: string[]) {
  const a: AnyObj = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith("--")) continue;
    const key = k.slice(2);
    const v = argv[i + 1];
    if (v && !v.startsWith("--")) {
      a[key] = v;
      i++;
    } else {
      a[key] = true;
    }
  }
  return a;
}

function abs(p: string) {
  if (!p) return p;
  if (path.isAbsolute(p)) return p;
  return path.join(process.cwd(), p);
}

function compactHits(hits: any[], n: number) {
  return (hits || []).slice(0, n).map((h) => ({
    ruleId: h.ruleId,
    stage: h.stage,
    weight: h.weight,
    label: h.label,
    matched0: Array.isArray(h.matched) ? h.matched[0] : undefined,
  }));
}

function compactSignals(sigs: any[], n: number) {
  return (sigs || []).slice(0, n).map((s) => ({
    id: s.id,
    stage: s.stage,
    weightSum: s.weightSum,
    count: s.count,
    ex0: Array.isArray(s.examples) ? s.examples[0] : undefined,
  }));
}

function main() {
  const args = parseArgs(process.argv);

  const datasetPath = String(args.path ?? args.in ?? args.dataset ?? "");
  if (!datasetPath) {
    console.error("Usage: npx tsx tools/probeFails.ts --path <dataset.jsonl> [--out <json>] [--topHits N] [--topSignals N]");
    process.exit(1);
  }

  const topHitsN = Number(args.topHits ?? 12);
  const topSignalsN = Number(args.topSignals ?? 10);
  const outPath = args.out ? String(args.out) : "";

  const raw = fs.readFileSync(abs(datasetPath), "utf8");
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  const fails: AnyObj[] = [];

  for (const line of lines) {
    const row = JSON.parse(line) as AnyObj;
    const thread = String(row.thread ?? row.threadText ?? row.rawThread ?? "");

    const input = {
      threadText: thread,
      callChecks: { otpAsked: false, remoteAsked: false, urgentPressured: false, firstContact: false, ...(row.callChecks ?? row.call ?? {}) },
    };

    const res: any = analyzeThread(input);

    const gotRisk = res.riskLevel as RiskLevel;
    const gotScore = Number(res.scoreTotal ?? 0);
    const gotStage = stagePeakFromResult(res);
    const gotTrig = triggeredFromResult(res);

    const exp = row.expected ?? {};
    const why: string[] = [];

    if (exp?.riskLevel && gotRisk !== exp.riskLevel) why.push(`risk mismatch: expected=${exp.riskLevel} got=${gotRisk}`);
    if (typeof exp?.score_min === "number" && gotScore < exp.score_min) why.push(`score below min: expected>=${exp.score_min} got=${gotScore}`);
    if (exp?.stagePeak && gotStage !== exp.stagePeak) why.push(`stagePeak mismatch: expected=${exp.stagePeak} got=${gotStage}`);
    if (typeof exp?.triggered === "boolean" && gotTrig !== exp.triggered) why.push(`triggered mismatch: expected=${exp.triggered} got=${gotTrig}`);

    if (why.length) {
      fails.push({
        id: row.id,
        category: row.category,
        label: row.label,
        expected: exp,
        got: { riskLevel: gotRisk, scoreTotal: gotScore, stagePeak: gotStage, triggered: gotTrig },
        why,
        senderText: senderTextFromThread(thread),
        topHits: compactHits(res.hitsTop ?? [], topHitsN),
        topSignals: compactSignals(res.signalsTop ?? [], topSignalsN),
        meta: row.meta,
      });
    }
  }

  console.log(`fails: ${fails.length}/${lines.length}`);
  for (const f of fails) {
    console.log(
      `- ${f.id} | risk ${f.expected?.riskLevel ?? "?"}->${f.got.riskLevel} | stage ${f.expected?.stagePeak ?? "?"}->${f.got.stagePeak} | scoreMin ${f.expected?.score_min ?? "-"} | gotScore ${f.got.scoreTotal}`
    );
    if (Array.isArray(f.why) && f.why.length) console.log(`  why: ${f.why.join(" ; ")}`);
    if (Array.isArray(f.topHits) && f.topHits.length) console.log(`  hits: ${f.topHits.map((h: any) => `${h.ruleId}:${h.weight}:${h.stage}`).join(", ")}`);
  }

  if (outPath) {
    const outAbs = abs(outPath);
    fs.mkdirSync(path.dirname(outAbs), { recursive: true });
    fs.writeFileSync(outAbs, JSON.stringify({ dataset: datasetPath, total: lines.length, fails }, null, 2), "utf8");
    console.log(`\nwritten: ${outAbs}`);
  }
}

main();
