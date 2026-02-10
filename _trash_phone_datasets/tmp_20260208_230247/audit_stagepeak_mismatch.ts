import fs from "fs";
import readline from "readline";
import { analyzeThread } from "../src/engine/index";

const STAGE_RANK: Record<string, number> = { info: 0, verify: 1, install: 2, payment: 3 };

function arg(name: string): string | undefined {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
}

function getId(o: any): string {
    return String(o?.id ?? o?.case_id ?? o?.caseId ?? o?.name ?? "");
}

function getThreadText(o: any): string {
    if (typeof o?.threadText === "string") return o.threadText;
    if (typeof o?.thread === "string") return o.thread;
    if (Array.isArray(o?.threadBlocks)) return o.threadBlocks.map((x: any) => String(x ?? "")).join("\n");
    if (typeof o?.text === "string") return o.text;
    return "";
}

function getExpectedStagePeak(o: any): string {
    const e = o?.expected;
    const v =
        e?.stagePeak ??
        e?.stage_peak ??
        e?.peakStage ??
        o?.expectedStagePeak ??
        o?.stagePeakExpected ??
        o?.stagePeak;
    return String(v ?? "info");
}

function getGotStagePeak(res: any): { stage: string; triggers: string[] } {
    const tl = Array.isArray(res?.stageTimeline) ? res.stageTimeline : [];
    if (tl.length) {
        const last = tl[tl.length - 1] || {};
        return { stage: String(last.stage ?? "info"), triggers: Array.isArray(last.triggers) ? last.triggers : [] };
    }
    // fallback: messageSummaries 최대 stage
    const ms = Array.isArray(res?.messageSummaries) ? res.messageSummaries : [];
    let best = "info";
    let bestTrig: string[] = [];
    for (const m of ms) {
        const st = String(m?.stage ?? "info");
        if ((STAGE_RANK[st] ?? 0) > (STAGE_RANK[best] ?? 0)) {
            best = st;
            bestTrig = Array.isArray(m?.stageTriggers) ? m.stageTriggers : [];
        }
    }
    return { stage: best, triggers: bestTrig };
}

async function main() {
    const path = arg("--path") || "./datasets/ko_scam/regression_v3_482_engineAligned_2026-01-30.policyRelabeled.jsonl";
    const outPath = arg("--out") || "./tmp/stagepeak_mismatch.tsv";

    const rl = readline.createInterface({ input: fs.createReadStream(path, { encoding: "utf8" }) });
    const out = fs.createWriteStream(outPath, { encoding: "utf8" });

    let total = 0;
    let mismatch = 0;

    const byGot: Record<string, number> = {};
    const trigFreq: Record<string, number> = {};

    out.write(["id", "expected_stagePeak", "got_stagePeak", "got_triggers_top3"].join("\t") + "\n");

    for await (const line of rl) {
        const l = String(line || "").trim();
        if (!l) continue;

        total++;
        const obj: any = JSON.parse(l);

        const expected = getExpectedStagePeak(obj);
        const threadText = getThreadText(obj);

        const res = analyzeThread({ threadText } as any);
        const got = getGotStagePeak(res);

        if (expected !== got.stage) {
            mismatch++;
            byGot[got.stage] = (byGot[got.stage] ?? 0) + 1;

            for (const t of (got.triggers || []).slice(0, 50)) {
                const k = String(t || "").trim();
                if (!k) continue;
                trigFreq[k] = (trigFreq[k] ?? 0) + 1;
            }

            out.write([getId(obj), expected, got.stage, (got.triggers || []).slice(0, 3).join(",")].join("\t") + "\n");
        }
    }

    out.end();

    const gotSorted = Object.entries(byGot).sort((a, b) => b[1] - a[1]);
    const trigSorted = Object.entries(trigFreq).sort((a, b) => b[1] - a[1]).slice(0, 15);

    console.log(`total=${total} mismatch=${mismatch} -> ${outPath}`);
    console.log("mismatch by got.stagePeak:", gotSorted);
    console.log("top triggers (stagePeak):", trigSorted);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
