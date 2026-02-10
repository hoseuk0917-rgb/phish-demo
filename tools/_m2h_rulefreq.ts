import fs from "node:fs";
import { analyzeThread } from "../src/engine/index";

const P = "datasets/ko_scam/mutated/_fails_out_nonlow_fast.jsonl";
const lines = fs
  .readFileSync(P, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim().length);

function isM2H(row: any): boolean {
  const why: any[] = row?.meta_fail?.why ?? [];
  return why.some((w: any) => String(w) === "risk medium -> high");
}

const freq = new Map<string, number>();

for (const line of lines) {
  const row: any = JSON.parse(line);
  if (!isM2H(row)) continue;

  const thread = String(row.thread ?? row.threadText ?? "");
  const res = await analyzeThread({
    threadText: thread,
    callChecks: {
      otpAsked: false,
      remoteAsked: false,
      urgentPressured: false,
      firstContact: false,
      ...(row.callChecks ?? {}),
    },
  } as any);

  for (const h of ((res as any)?.hitsTop ?? []) as any[]) {
    const id = String(h?.ruleId ?? "");
    if (!id) continue;
    freq.set(id, (freq.get(id) ?? 0) + 1);
  }
}

const top = [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log(top.map(([k, v]) => ({ ruleId: k, count: v })));
