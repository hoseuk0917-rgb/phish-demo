import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const p="datasets/ko_scam/mutated/_fails_out_nonlow_fast.jsonl";
const rows=fs.readFileSync(p,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));

let h2m=0, softMark=0, score64=0, scoreHi=0;
for (const row of rows){
  const why = row?.meta_fail?.why ?? [];
  if (!why.some((w:any)=>String(w)==="risk high -> medium")) continue;
  h2m++;

  const thread=String(row.thread ?? row.threadText ?? "");
  const res = await analyzeThread({
    threadText: thread,
    callChecks:{ otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks??{}) }
  } as any);

  const score = Number((res as any).scoreTotal ?? 0);
  const hits = Array.isArray((res as any).hitsTop) ? (res as any).hitsTop : [];
  const hasSoft = hits.some((h:any)=>String(h?.ruleId ?? "")==="ctx_soft_high_cap");

  if (hasSoft) softMark++;
  if (score === 64) score64++;
  if (score >= 65) scoreHi++;
}

console.log({ h2m, softMark, score64, score_ge_65: scoreHi });
