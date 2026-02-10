import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const inPath = "datasets/ko_scam/mutated/_fails_out_nonlow_fast.jsonl";
const lines = fs.readFileSync(inPath, "utf8").split(/\r?\n/).filter(l=>l.trim().length);

const freq = new Map<string, number>();

for (const line of lines) {
  const row = JSON.parse(line);
  const thread = String(row?.thread ?? row?.threadText ?? "");
  const res = await analyzeThread(({ threadText: thread, callChecks: [] } as any));
  for (const h of (res?.hitsTop ?? [])) {
    const id = String(h?.ruleId ?? "");
    if (!id) continue;
    freq.set(id, (freq.get(id) ?? 0) + 1);
  }
}

const top = [...freq.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 30);
console.log(top.map(([k,v])=>({ruleId:k, count:v})));
