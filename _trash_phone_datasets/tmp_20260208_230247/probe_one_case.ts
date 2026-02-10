import fs from "node:fs";
import { analyzeThread } from "../src/engine";

const ds = process.argv[2];
const id = process.argv[3];

const pickThread = (row: any) => {
  const t = row.thread ?? row.threadText ?? row.rawThread ?? row.text ?? "";
  if (Array.isArray(t)) return t.join("\n");
  return String(t ?? "");
};

const rows = fs.readFileSync(ds, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
const row = rows.find((r) => String(r.id ?? r.case_id ?? r.caseId ?? "") === id);
if (!row) {
  console.error("NOT FOUND:", id);
  process.exit(2);
}

const threadText = pickThread(row);

const res = await analyzeThread({
  threadText,
  callChecks: {
    otpAsked: false,
    remoteAsked: false,
    urgentPressured: false,
    firstContact: false,
    ...(row.callChecks ?? {}),
  },
} as any);

const keys = Object.keys(res as any).sort();
console.log("res.keys =", keys);

const hardHigh =
  (res as any).hardHigh ??
  (res as any).hard_high ??
  (res as any).meta?.hardHigh ??
  (res as any).meta?.hard_high ??
  (res as any).context?.hardHigh ??
  (res as any).context?.hard_high;

console.log("riskLevel    =", (res as any).riskLevel);
console.log("uiRiskLevel  =", (res as any).uiRiskLevel);
console.log("scoreTotal   =", (res as any).scoreTotal);
console.log("stagePeak    =", (res as any).stagePeak);
console.log("hardHigh(any)=", hardHigh);

const hitsTop = (res as any).hitsTop ?? (res as any).riskHitsTop ?? [];
console.log("hitsTop(ruleId) =", hitsTop.slice(0, 16).map((h: any) => String(h.ruleId ?? h.id ?? "")));

