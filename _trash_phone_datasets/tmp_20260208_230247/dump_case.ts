import fs from "node:fs";
import { analyzeThread } from "../src/engine";

const ds = process.argv[2];
const idWanted = process.argv[3] || "";
if (!ds) {
  console.error("Usage: npx tsx .\\tmp\\dump_case.ts <dataset.jsonl> [caseId]");
  process.exit(2);
}

const rows = fs.readFileSync(ds, "utf8").split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));

const pickId = (r:any) => String(r.id ?? r.case_id ?? r.caseId ?? r.name ?? "");
const pickThread = (r:any) => {
  const t = r.thread ?? r.threadText ?? r.rawThread ?? r.rawThreadText ?? r.text ?? r.input ?? "";
  return Array.isArray(t) ? t.join("\n") : String(t ?? "");
};

const row = idWanted
  ? rows.find((r:any) => pickId(r) === idWanted)
  : rows[0];

if (!row) {
  console.error("Case not found:", idWanted);
  process.exit(1);
}

const id = pickId(row);
const threadText = pickThread(row);
const callChecks = !!row.callChecks;

const res:any = await analyzeThread({ threadText, callChecks } as any);

const scoreTotal = Number(res.uiScoreTotal ?? res.scoreTotal ?? 0);
const riskLevel = String(res.riskLevel ?? "");
const uiRiskLevel = String(res.uiRiskLevel ?? "");
const stagePeak = String(res.stagePeak ?? res.stage ?? "");

console.log("id =", id);
console.log("riskLevel =", riskLevel, "uiRiskLevel =", uiRiskLevel, "stagePeak =", stagePeak);
console.log("scoreTotal =", scoreTotal);

const topSignals:any[] = Array.isArray(res.signalsTop) ? res.signalsTop : [];
console.log("\nTOP signals:");
for (const s of topSignals.slice(0, 8)) {
  console.log("-", String(s.label ?? s.id ?? ""), "w=", Number(s.weightSum ?? s.weight ?? 0), "c=", Number(s.count ?? 0));
}

const ms:any[] = Array.isArray(res.messageSummaries) ? res.messageSummaries : [];
ms.sort((a,b)=> Number(b.score||0)-Number(a.score||0));

console.log("\nTOP blocks:");
for (const m of ms.slice(0, 6)) {
  const stageTriggers = Array.isArray(m.stageTriggers) ? m.stageTriggers : [];
  const topRules = Array.isArray(m.topRules) ? m.topRules.map((r:any)=> String(r?.label||"").trim()).filter(Boolean) : [];
  console.log(
    `- BLK ${m.index} score=${m.score} stage=${String(m.stage||"")} ` +
    `triggers=[${stageTriggers.slice(0,3).join(" · ")}] ` +
    `rules=[${topRules.slice(0,3).join(" · ")}]`
  );
}
