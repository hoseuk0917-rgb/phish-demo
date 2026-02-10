import fs from "fs";
import readline from "readline";
import { analyzeThread } from "../src/engine";

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

type StageId = "info" | "verify" | "install" | "payment";
const STAGE_RANK: Record<StageId, number> = { info: 0, verify: 1, install: 2, payment: 3 };

function peakFromMessageSummaries(ms: any[]): StageId {
    let best: StageId = "info";
    for (const m of ms || []) {
        const s = String(m?.stage ?? "") as StageId;
        if (s && STAGE_RANK[s] > STAGE_RANK[best]) best = s;
    }
    return best;
}

function peakFromTimeline(tl: any[]): StageId {
    if (!Array.isArray(tl) || tl.length === 0) return "info";
    const last = tl[tl.length - 1];
    const s = String(last?.stage ?? "") as StageId;
    return (s && STAGE_RANK[s] !== undefined ? s : "info");
}

async function main() {
    const path = arg("--path") || "./datasets/ko_scam/regression_v3_482_engineAligned_2026-01-30.policyRelabeled.jsonl";
    const outPath = arg("--out") || "./tmp/stagepeak_mismatch_detail.tsv";

    const rl = readline.createInterface({ input: fs.createReadStream(path, { encoding: "utf8" }) });
    const out = fs.createWriteStream(outPath, { encoding: "utf8" });

    out.write(
        [
            "caseId",
            "expectedStagePeak",
            "gotStagePeak",           // runDataset 축(=analyzeThread 기반)
            "gotStagePeak_byMsgs",    // messageSummaries max
            "gotStagePeak_byTL",      // stageTimeline peak(=마지막 stage)
            "scoreTotal",
            "riskLevel",
            "topHitIds",
            "topStageTriggers",
        ].join("\t") + "\n"
    );

    let total = 0;
    let mismatch = 0;

    for await (const line of rl) {
        const l = String(line || "").trim();
        if (!l) continue;
        total++;

        const obj: any = JSON.parse(l);
        const caseId = getId(obj) || `ROW_${total}`;

        const expected = String(obj?.expected?.stagePeak ?? obj?.expectedStagePeak ?? "").trim();
        if (!expected) continue;

        const threadTextRaw = getThreadText(obj);
        if (!threadTextRaw.trim()) continue;

        const threadText = String(threadTextRaw).replace(/\r\n/g, "\n");

        const res: any = analyzeThread(
            { threadText, callChecks: obj?.callChecks } as any,
            undefined
        );

        const ms = Array.isArray(res?.messageSummaries) ? res.messageSummaries : [];
        const tl = Array.isArray(res?.stageTimeline) ? res.stageTimeline : [];

        // runDataset 쪽과 같은 축: messageSummaries/stageTimeline 기반 peak
        const gotByMsgs = peakFromMessageSummaries(ms);
        const gotByTL = peakFromTimeline(tl);

        // 둘 중 뭐로 비교할지(일단 TL 우선, 비어있으면 msgs)
        const got: StageId = (tl.length ? gotByTL : gotByMsgs) as StageId;

        if (got !== (expected as any)) {
            mismatch++;

            const hits = Array.isArray(res?.hitsTop) ? res.hitsTop : [];
            const topHitIds = hits.slice(0, 12).map((h: any) => String(h?.ruleId ?? "")).filter(Boolean).join(",");

            const st = Array.isArray(ms)
                ? ms.flatMap((m: any) => (Array.isArray(m?.stageTriggers) ? m.stageTriggers : []))
                : [];
            const topStageTriggers = st
                .slice(0, 10)
                .map((x: any) => String(x ?? "").replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .join(" | ");

            out.write(
                [
                    caseId,
                    expected,
                    got,
                    gotByMsgs,
                    gotByTL,
                    String(Number(res?.scoreTotal ?? 0)),
                    String(res?.riskLevel ?? ""),
                    topHitIds,
                    topStageTriggers,
                ].join("\t") + "\n"
            );
        }
    }

    out.end();
    console.log(`total=${total} mismatch=${mismatch} -> ${outPath}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
