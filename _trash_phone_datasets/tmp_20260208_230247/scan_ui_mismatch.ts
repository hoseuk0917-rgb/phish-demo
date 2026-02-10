import fs from "node:fs";
import { analyzeThread } from "../src/engine";

const ds = process.argv[2];
if (!ds) { console.error("Usage: npx tsx .\\tmp\\scan_ui_mismatch.ts <dataset.jsonl>"); process.exit(2); }

const rows = fs.readFileSync(ds, "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));

const pickId = (r:any) => String(r.id ?? r.case_id ?? r.caseId ?? r.name ?? "");
const pickThread = (r:any) => {
  const t = r.thread ?? r.threadText ?? r.rawThread ?? r.rawThreadText ?? r.text ?? r.input ?? "";
  return Array.isArray(t) ? t.join("\n") : String(t ?? "");
};

const derived = (score:number) => (score >= 65 ? "high" : score >= 35 ? "medium" : "low");

let n = 0;
let mismatchScoreVsRisk = 0;
let mismatchScoreVsUi = 0;
let examples: any[] = [];

for (const r of rows) {
  const id = pickId(r);
  const threadText = pickThread(r);
  const callChecks = (r.callChecks ?? false);

  const res:any = await analyzeThread({ threadText, callChecks } as any);

  const score = Number(res.scoreTotal ?? 0);
  const risk = String(res.riskLevel ?? "");
  const uiRisk = String(res.uiRiskLevel ?? "");
  const uiScore = Number(res.uiScoreTotal ?? NaN);

  const d = derived(score);
  const dUi = Number.isFinite(uiScore) ? derived(uiScore) : "";

  const simHint = Array.isArray(res.signalsTop)
    ? res.signalsTop.find((s:any)=> String(s?.id||"") === "sim_hint")
    : null;
  const simBoost = simHint ? Number(simHint.weightSum ?? 0) : 0;

  n++;

  if (risk && d && risk !== d) {
    mismatchScoreVsRisk++;
    if (examples.length < 12) examples.push({ id, riskLevel: risk, scoreTotal: score, derivedFromScore: d, uiRiskLevel: uiRisk || null, uiScoreTotal: Number.isFinite(uiScore)? uiScore : null, simBoost });
  }

  if (uiRisk && d && uiRisk !== d) mismatchScoreVsUi++;
}

console.log("cases=", n);
console.log("mismatch(scoreTotal vs riskLevel)=", mismatchScoreVsRisk);
console.log("mismatch(score/uiScore vs uiRiskLevel)=", mismatchScoreVsUi);
console.log("examples (up to 12):");
for (const ex of examples) console.log(ex);
