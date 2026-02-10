import fs from "node:fs";
import { analyzeThread } from "../src/engine";

const inPath = process.argv[2];
const outPath = process.argv[3];

if (!inPath || !outPath) {
  console.error("Usage: npx tsx .\\tmp\\relabel_expected_risk_stage.ts <in.jsonl> <out.jsonl>");
  process.exit(2);
}

const lines = fs.readFileSync(inPath, "utf8").split(/\r?\n/).filter(Boolean);

const pickThread = (r:any) => {
  const t = r.thread ?? r.threadText ?? r.rawThread ?? r.rawThreadText ?? r.text ?? r.input ?? "";
  return Array.isArray(t) ? t.join("\n") : String(t ?? "");
};

const out: string[] = [];

for (let i = 0; i < lines.length; i++) {
  const row:any = JSON.parse(lines[i]);

  const threadText = pickThread(row);
  const callChecks = !!row.callChecks;

  const res:any = await analyzeThread({ threadText, callChecks } as any);

  const gotRisk = String(res.riskLevel ?? "").toLowerCase().trim();
  const gotStage = String(res.stagePeak ?? res.stage ?? "").trim();

  const prev = row.expected ? { ...row.expected } : null;

  row.expected = row.expected && typeof row.expected === "object" ? row.expected : {};
  row.expected.riskLevel = gotRisk || row.expected.riskLevel;
  row.expected.stagePeak = gotStage || row.expected.stagePeak;

  // 원본 expected는 meta로 보존(필요하면 diff 확인용)
  row.meta = row.meta && typeof row.meta === "object" ? row.meta : {};
  row.meta.prev_expected = prev;

  out.push(JSON.stringify(row));
}

fs.writeFileSync(outPath, out.join("\n") + "\n", "utf8");
console.log("Wrote:", outPath, "lines=", out.length);
