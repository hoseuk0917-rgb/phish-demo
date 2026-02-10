import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const P="datasets/ko_scam/mutated/out_nonlow_fast_expected_ui.jsonl";
const rows=fs.readFileSync(P,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));

for (const row of rows){
  const thread = String(row.thread ?? "");
  const expMin = Number(row?.expected?.score_min ?? row?.expected?.scoreMin ?? 0);
  if (!expMin) continue;

  const res = await analyzeThread({
    threadText: thread,
    callChecks:{ otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks??{}) }
  } as any);

  const score = Number((res as any).scoreTotal ?? 0);
  if (score < expMin){
    console.log(row.id, { expMin, score, threat: (res as any).riskLevel, ui: (res as any).uiRiskLevel });
    break;
  }
}
