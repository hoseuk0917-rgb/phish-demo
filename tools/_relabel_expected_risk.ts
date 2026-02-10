import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const IN="datasets/ko_scam/mutated/out_nonlow_fast.jsonl";
const OUT="datasets/ko_scam/mutated/out_nonlow_fast_expected_engine.jsonl";

const rows = fs.readFileSync(IN,"utf8").split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l));
const out:string[] = [];

for (const row of rows){
  const thread = String(row.thread ?? row.threadText ?? "");
  const res = await analyzeThread({
    threadText: thread,
    callChecks:{ otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks??{}) }
  } as any);

  const gotRisk = String((res as any).riskLevel ?? "low");
  const prev = row.expected ? { ...row.expected } : null;

  row.meta = row.meta ?? {};
  row.meta.expected_prev = prev;

  row.expected = row.expected ?? {};
  row.expected.riskLevel = gotRisk;

  out.push(JSON.stringify(row));
}

fs.writeFileSync(OUT, out.join("\n")+"\n", "utf8");
console.log("OK:", OUT, "rows", out.length);
