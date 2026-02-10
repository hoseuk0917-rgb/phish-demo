import fs from "node:fs";
import path from "node:path";
import { analyzeThread } from "../src/engine/index";

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

const inPath = arg("--in");
const outPath = arg("--out");
const RISK_ONLY = has("--risk-only");

if (!inPath || !outPath) {
  console.error(
    "Usage: npx tsx tools/_relabelWithEngine.ts --in <in.jsonl> --out <out.jsonl> [--risk-only]"
  );
  process.exit(2);
}

function pickText(row: any) {
  const t =
    row?.threadText ??
    row?.thread ??
    row?.rawThreadText ??
    row?.rawThread ??
    row?.text ??
    row?.input ??
    "";
  return String(t ?? "");
}

function isGood(res: any) {
  const score = Number(res?.scoreTotal ?? 0);
  const hitsLen = Array.isArray(res?.hitsTop) ? res.hitsTop.length : 0;
  const mc = Number(res?.messageCount ?? 0);
  const chars = Number(res?.prefilter?.window?.charsConsidered ?? 0);
  return score > 0 || hitsLen > 0 || mc > 0 || chars > 0;
}

function norm(s: any) {
  return String(s ?? "").trim().toLowerCase();
}

function inferRisk(res: any, scoreTotal: number) {
  const r0 = norm(res?.riskLevel ?? res?.risk ?? res?.riskLevelId);
  if (r0 === "low" || r0 === "medium" || r0 === "high") return r0;
  if (scoreTotal >= 65) return "high";
  if (scoreTotal >= 35) return "medium";
  return "low";
}

function scoreMinForRisk(risk: string) {
  if (risk === "high") return 65;
  if (risk === "medium") return 35;
  return 0;
}

type PayloadKind = "threadText" | "rawThreadText" | "thread" | "rawThread" | "text" | "input";

function makePayload(kind: PayloadKind, text: string) {
  // ✅ runDataset쪽과 최대한 동일하게: callChecks는 true로
  const base: any = { callChecks: true };
  switch (kind) {
    case "threadText":
      return { ...base, threadText: text };
    case "rawThreadText":
      return { ...base, rawThreadText: text };
    case "thread":
      return { ...base, thread: text };
    case "rawThread":
      return { ...base, rawThread: text };
    case "text":
      return { ...base, text };
    case "input":
      return { ...base, input: text };
    default:
      return { ...base, threadText: text };
  }
}

let _PREF_KIND: PayloadKind | null = null;

async function analyzeCompat(text: string) {
  const candidates: PayloadKind[] = ["threadText", "rawThreadText", "thread", "rawThread", "text", "input"];

  if (_PREF_KIND) {
    const res = await analyzeThread(makePayload(_PREF_KIND, text) as any);
    if (isGood(res)) return res;
    _PREF_KIND = null;
  }

  for (const k of candidates) {
    const res = await analyzeThread(makePayload(k, text) as any);
    if (isGood(res)) {
      _PREF_KIND = k;
      return res;
    }
  }

  return analyzeThread(makePayload("threadText", text) as any);
}

// ---- main ----
const raw = fs.readFileSync(inPath, "utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

const out: string[] = [];
let i = 0;

// warmup
if (lines.length) {
  try {
    const row0 = JSON.parse(lines[0]);
    await analyzeCompat(pickText(row0));
  } catch { }
}

for (const line of lines) {
  i++;
  const row = JSON.parse(line);

  const text = pickText(row);

  // ✅ runDataset이 뭘 보더라도 동일 입력이 되게 동기화만 유지
  row.thread = text;
  row.threadText = text;

  const res = await analyzeCompat(text);

  const scoreTotal = Number(res?.scoreTotal ?? 0);
  const risk = inferRisk(res, scoreTotal);

  const exp: any = { ...(row.expected ?? {}) };

  // ✅ 여기만 바꿈 (핵심)
  exp.riskLevel = risk;
  exp.score_min = scoreMinForRisk(risk);

  // ✅ risk-only면 나머지는 건드리지 않음 (stagePeak/triggered/triggers 보존)
  if (!RISK_ONLY) {
    // 필요하면 나중에 full relabel 확장 가능 (지금은 안 씀)
  }

  row.expected = exp;

  row.meta_engine = {
    payloadPref: _PREF_KIND,
    scoreTotal,
    riskLevel: risk,
  };

  out.push(JSON.stringify(row));
  if (i % 50 === 0) console.log("relabel", i, "/", lines.length);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, out.join("\n") + "\n", "utf8");
console.log("OK:", "wrote", out.length, "->", outPath);
