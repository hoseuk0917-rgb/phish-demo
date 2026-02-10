import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const p = "datasets/ko_scam/mutated/_fails_out_nonlow_fast.jsonl";
const row = JSON.parse(fs.readFileSync(p, "utf8").split(/\r?\n/).filter(Boolean)[0]);

const thread = String(row.thread ?? row.threadText ?? "");
const res = await analyzeThread({
  threadText: thread,
  callChecks: { otpAsked:false, remoteAsked:false, urgentPressured:false, firstContact:false, ...(row.callChecks ?? {}) },
} as any);

console.log({
  expected: row?.expected,
  got: {
    risk: (res as any).riskLevel,
    uiRisk: (res as any).uiRiskLevel,
    score: (res as any).scoreTotal,
    uiScore: (res as any).uiScoreTotal,
    rGate: (res as any).rGateTag,
  },
  topRules: ((res as any).hitsTop ?? []).slice(0, 12).map((h:any)=>({ id:h.ruleId, w:h.weight, stage:h.stage })),
});
