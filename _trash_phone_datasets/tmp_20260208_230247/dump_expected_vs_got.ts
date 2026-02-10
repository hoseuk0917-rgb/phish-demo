import fs from "node:fs";
import { analyzeThread } from "../src/engine";

const ds = process.argv[2];
const idWanted = process.argv[3];
if (!ds || !idWanted) {
  console.error("Usage: npx tsx .\\tmp\\dump_expected_vs_got.ts <dataset.jsonl> <caseId>");
  process.exit(2);
}

const rows = fs.readFileSync(ds, "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));

const pickId = (r:any) => String(r.id ?? r.case_id ?? r.caseId ?? r.name ?? "");
const pickThread = (r:any) => {
  const t = r.thread ?? r.threadText ?? r.rawThread ?? r.rawThreadText ?? r.text ?? r.input ?? "";
  return Array.isArray(t) ? t.join("\n") : String(t ?? "");
};

const row:any = rows.find((r:any) => pickId(r) === idWanted);
if (!row) {
  console.error("Case not found:", idWanted);
  process.exit(1);
}

const expectedRisk =
  String(row?.expected?.riskLevel ?? row?.expected?.risk ?? row?.expectedRisk ?? row?.riskLevel ?? row?.risk ?? "");

const res:any = await analyzeThread({ threadText: pickThread(row), callChecks: !!row.callChecks } as any);

const gotRisk = String(res.riskLevel ?? "");
const gotUiRisk = String(res.uiRiskLevel ?? "");
const gotStage = String(res.stagePeak ?? res.stage ?? "");
const gotScore = Number(res.uiScoreTotal ?? res.scoreTotal ?? 0);

console.log("id =", idWanted);
console.log("expectedRisk =", expectedRisk);
console.log("got: riskLevel =", gotRisk, "uiRiskLevel =", gotUiRisk, "stagePeak =", gotStage, "scoreTotal =", gotScore);

const sigs:any[] = Array.isArray(res.signalsTop) ? res.signalsTop : [];
console.log("\nTOP signals (labels):");
for (const s of sigs.slice(0, 10)) console.log("-", String(s.label ?? s.id ?? ""));
