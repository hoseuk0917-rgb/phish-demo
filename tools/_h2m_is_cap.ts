import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const p = "datasets/ko_scam/mutated/_fails_out_nonlow_fast.jsonl";
const rows = fs.readFileSync(p,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));

function isH2M(r:any){
  return (r?.meta_fail?.why ?? []).some((w:any)=>String(w)==="risk high -> medium");
}

let n=0, nScoreHi=0;
for (const row of rows) {
  if (!isH2M(row)) continue;
  n++;

  const thread = String(row.thread ?? row.threadText ?? "");
  const res = await analyzeThread({
    threadText: thread,
    callChecks: { otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks ?? {}) },
  } as any);

  const score = Number((res as any).scoreTotal);
  const risk = String((res as any).riskLevel);
  if (score >= 65 && risk === "medium") nScoreHi++;
}
console.log({ h2m: n, score_ge_65_but_medium: nScoreHi });
