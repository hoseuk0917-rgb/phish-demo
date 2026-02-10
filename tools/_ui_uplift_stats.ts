import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const IN="datasets/ko_scam/mutated/out_nonlow_fast.jsonl";
const rows=fs.readFileSync(IN,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));

const dist=new Map<string,number>();
const tagFreq=new Map<string,number>();
const deltaFreq=new Map<string,number>();

let mh=0; // medium->high
let mh_base_60_64=0;

for (const row of rows){
  const thread=String(row.thread ?? row.threadText ?? "");
  const res=await analyzeThread({
    threadText: thread,
    callChecks:{ otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks??{}) }
  } as any);

  const r=String(res?.riskLevel ?? "none").toLowerCase().trim();
  const u=String(res?.uiRiskLevel ?? r).toLowerCase().trim();

  const score=Number(res?.scoreTotal ?? 0);
  const uiScore=Number(res?.uiScoreTotal ?? score);
  const d=Math.round(uiScore - score);

  const k=`${r}->${u}`;
  dist.set(k,(dist.get(k)||0)+1);

  const tag=String(res?.rGateTag ?? "");
  if (tag) tagFreq.set(tag,(tagFreq.get(tag)||0)+1);

  if (d>0) deltaFreq.set(String(d),(deltaFreq.get(String(d))||0)+1);

  if (r==="medium" && u==="high"){
    mh++;
    if (score>=60 && score<=64) mh_base_60_64++;
  }
}

const top=(m:Map<string,number>, n=20)=>[...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n);

console.log("dist", top(dist, 20));
console.log("rGateTag", top(tagFreq, 20));
console.log("delta", top(deltaFreq, 20));
console.log({ mh, mh_base_60_64 });
