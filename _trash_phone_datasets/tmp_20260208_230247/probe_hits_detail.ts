import fs from "node:fs";
import { analyzeThread } from "../src/engine";

const ds = process.argv[2];
const id = process.argv[3];

const rows = fs.readFileSync(ds,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
const row = rows.find(r => String(r.id ?? r.case_id ?? r.caseId ?? "") === id);
if(!row){ console.error("NOT FOUND", id); process.exit(2); }

const pickThread = (r:any) => {
  const t = r.thread ?? r.threadText ?? r.rawThread ?? r.text ?? "";
  return Array.isArray(t) ? t.join("\n") : String(t ?? "");
};

const res:any = await analyzeThread({ threadText: pickThread(row), callChecks: (row.callChecks ?? false) } as any);

console.log("riskLevel=", res.riskLevel, "uiRiskLevel=", res.uiRiskLevel, "scoreTotal=", res.scoreTotal, "uiScoreTotal=", res.uiScoreTotal);

const hits = Array.isArray(res.hitsTop) ? res.hitsTop : [];
console.log("hitsTop:");
for(const h of hits.slice(0,30)){
  console.log("-", {
    ruleId: h.ruleId ?? h.id,
    stage: h.stage,
    weight: h.weight,
    label: h.label,
    matched0: Array.isArray(h.matched) ? h.matched[0] : undefined,
  });
}

const ms = Array.isArray(res.messageSummaries) ? res.messageSummaries : [];
console.log("messageSummaries(includeInThreat):");
for(const m of ms){
  console.log("-", { idx: m.index, role: m.role, includeInThreat: m.includeInThreat, score: m.score, stage: m.stage });
}
