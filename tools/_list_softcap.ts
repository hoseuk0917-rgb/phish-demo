import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const P="datasets/ko_scam/mutated/out_nonlow_fast_expected_threat.jsonl";
const rows=fs.readFileSync(P,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));

let n=0, capped=0;
for (const row of rows){
  const thread=String(row.thread ?? row.threadText ?? "");
  const res=await analyzeThread({ threadText: thread, callChecks:{ otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks??{}) } } as any);

  const hits = Array.isArray((res as any).hitsTop) ? (res as any).hitsTop : [];
  const hasSoft = hits.some((h:any)=>String(h?.ruleId??"")==="ctx_soft_high_cap");
  if (!hasSoft) continue;

  capped++;
  if (capped<=20){
    console.log(row.id, {
      threatRisk: (res as any).riskLevel,
      uiRisk: (res as any).uiRiskLevel,
      score: (res as any).scoreTotal,
      uiScore: (res as any).uiScoreTotal
    });
  }
}
console.log({ capped });
