import fs from "node:fs";

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  if (i < 0) return "";
  return String(process.argv[i + 1] ?? "");
}

let p =
  arg("--in") ||
  "datasets/ko_scam/mutated/_fails_expected_ui.jsonl";

// fallback (예전 기본값 호환)
if (!fs.existsSync(p)) {
  const fb = "datasets/ko_scam/mutated/_fails_out_nonlow_fast.jsonl";
  if (fs.existsSync(fb)) p = fb;
}

if (!p || !fs.existsSync(p)) {
  console.error(`Usage: npx tsx tools/_failWhyFreq.ts --in <fails.jsonl>`);
  console.error(`File not found: ${p || "(empty)"}`);
  process.exit(2);
}

const lines = fs
  .readFileSync(p, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim().length);

const freq = new Map<string, number>();

for (const line of lines) {
  const row = JSON.parse(line);
  const why = row?.meta_fail?.why ?? [];
  for (const w of why) {
    const k = String(w);
    freq.set(k, (freq.get(k) ?? 0) + 1);
  }
}

const top = [...freq.entries()].sort((a, b) => b[1] - a[1]);
console.log(top.map(([k, v]) => ({ why: k, count: v })));
