import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const IN="datasets/ko_scam/mutated/out_nonlow_fast.jsonl";
const OUT="datasets/ko_scam/mutated/out_nonlow_fast_expected_threat.jsonl";

function normRisk(x:any){
  const s=String(x??"").toLowerCase().trim();
  return (s==="low"||s==="medium"||s==="high")?s:"";
}
function scoreMinForThreat(r:"low"|"medium"|"high"){
  if (r==="high") return 60;
  if (r==="medium") return 30;
  return null;
}

const rows=fs.readFileSync(IN,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
const out:string[]=[];

for (const row of rows){
  const thread=String(row.thread ?? row.threadText ?? "");
  const res = await analyzeThread({
    threadText: thread,
    callChecks:{ otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks??{}) }
  } as any);

  const threat = normRisk((res as any).riskLevel) || "low";

  row.meta = row.meta ?? {};
  row.meta.expected_prev = row.expected ? { ...row.expected } : null;

  row.expected = row.expected ?? {};
  (row.expected as any).threatRiskLevel = threat;
  row.expected.riskLevel = threat;

  const min = scoreMinForThreat(threat as any);
  if (min == null) delete row.expected.score_min;
  else row.expected.score_min = min;

  out.push(JSON.stringify(row));
}

fs.writeFileSync(OUT, out.join("\n")+"\n","utf8");
console.log("OK:", OUT, "rows", out.length);
