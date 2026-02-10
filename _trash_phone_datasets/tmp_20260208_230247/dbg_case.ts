import fs from "fs";
import { analyzeThread } from "../src/engine";

const file = process.argv[2];
const id = process.argv[3];
if (!file || !id) {
  console.error("usage: npx tsx tmp/dbg_case.ts <dataset.jsonl> <CASE_ID>");
  process.exit(1);
}

const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
const line = lines.find((l) => l.includes(id));
if (!line) {
  console.error("case not found:", id);
  process.exit(1);
}

const row = JSON.parse(line);
const threadText = String(row.threadText ?? row.thread ?? "");
const res = analyzeThread({ threadText } as any);

console.log(JSON.stringify({
  id,
  scoreTotal: res.scoreTotal,
  riskLevel: res.riskLevel,
  stagePeak: res.stagePeak,
  triggersTop: res.triggersTop,
  signalsTop: res.signalsTop,
}, null, 2));

const hits = Array.isArray((res as any).hits) ? (res as any).hits : [];
console.log("\\nTop hits:");
hits.slice(0, 30).forEach((h: any) => {
  const rid = String(h.ruleId ?? "");
  const w = Number(h.weight ?? 0);
  const st = String(h.stage ?? "");
  const s = String(h.sample ?? h.evidence?.text ?? "").replace(/\\s+/g, " ").slice(0, 120);
  console.log([rid, w, st, s].join("\\t"));
});
