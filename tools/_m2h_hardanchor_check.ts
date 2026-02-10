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

let n = 0,
  hardYes = 0,
  hardNo = 0;

for (const line of lines) {
  const row: any = JSON.parse(line);
  if (!isM2H(row)) continue;
  n++;

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

  const ids = new Set<string>(
    ((res as any)?.hitsTop ?? []).map((h: any) => String(h?.ruleId ?? "")).filter(Boolean)
  );

  // “하드 앵커” 존재 여부(대략)
  const hasHard =
    ids.has("transfer") ||
    ids.has("ctx_payment_request") ||
    ids.has("remote") ||
    ids.has("otp") ||
    ids.has("ctx_otp_relay") ||
    ids.has("ctx_install_mention") ||
    (ids.has("link") && (ids.has("ctx_payment_request") || ids.has("ctx_pay_with_link") || ids.has("transfer")));

  if (hasHard) hardYes++;
  else hardNo++;
}

console.log({ m2h: n, hardYes, hardNo });
