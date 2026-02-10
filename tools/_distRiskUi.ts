import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const p="datasets/ko_scam/mutated/out_nonlow_fast.jsonl";
const rows=fs.readFileSync(p,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));

const dist=new Map<string, number>();
let i=0;

for (const row of rows){
  i++;
  const thread=String(row.thread ?? row.threadText ?? "");
  const res=await analyzeThread({
    threadText: thread,
    callChecks:{ otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks??{}) }
  } as any);

  const r=String((res as any).riskLevel||"none").toLowerCase().trim() || "none";
  const u=String((res as any).uiRiskLevel||"none").toLowerCase().trim() || "none";
  const k=r+"->"+u;
  dist.set(k,(dist.get(k)||0)+1);

  if (i%50===0) console.log("scan", i, "/", rows.length);
}

console.log([...dist.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20));
