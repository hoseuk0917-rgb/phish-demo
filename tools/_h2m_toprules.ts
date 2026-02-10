import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const p = "datasets/ko_scam/mutated/_fails_out_nonlow_fast.jsonl";
const rows = fs.readFileSync(p,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));

function isH2M(row:any){
  return (row?.meta_fail?.why ?? []).some((w:any)=>String(w)==="risk high -> medium");
}

const ruleFreq = new Map<string, number>();
let n=0, nUiHigh=0;

for (const row of rows) {
  if (!isH2M(row)) continue;
  n++;

  const thread = String(row.thread ?? row.threadText ?? "");
  const res = await analyzeThread({
    threadText: thread,
    callChecks: { otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks ?? {}) },
  } as any);

  const risk = String((res as any).riskLevel ?? "");
  const uiRisk = String((res as any).uiRiskLevel ?? "");
  if (uiRisk === "high" && risk === "medium") nUiHigh++;

  const hits = Array.isArray((res as any).hitsTop) ? (res as any).hitsTop : [];
  for (const h of hits.slice(0, 12)) {
    const id = String(h?.ruleId ?? h?.id ?? "none");
    ruleFreq.set(id, (ruleFreq.get(id) ?? 0) + 1);
  }
}

const topRules = [...ruleFreq.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 25);
console.log({ h2m: n, uiHigh_but_riskMedium: nUiHigh });
console.log(topRules);
