import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { scoreThread } from "../src/engine/scoring/scoreThread";
import { vecFromSignals } from "../src/engine/similarity/patternVec";
import type { SimIndexFile, SimIndexItem } from "../src/engine/similarity/simIndex";

function getArg(argv: string[], k: string): string {
    const i = argv.findIndex((x) => x === k);
    return i >= 0 ? (argv[i + 1] ?? "") : "";
}

function splitThread(thread: string): string[] {
    const raw = String(thread ?? "").replace(/\r\n/g, "\n").trim();
    if (!raw) return [];

    // 1) newline 기반(이미 블록화 된 케이스)
    if (raw.includes("\n")) {
        const lines = raw.split("\n").map((x) => x.trim()).filter(Boolean);
        if (lines.length >= 2) return lines;
    }

    // 2) "S:" / "R:" 토큰 기반(한 줄로 들어오는 케이스)
    const parts = raw
        .split(/(?=(?:^|\s)(?:S|R)\s*:\s*)/g)
        .map((x) => x.trim())
        .filter(Boolean);

    return parts.length ? parts : [raw];
}

function readJsonl(filePath: string): any[] {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    const raw = fs.readFileSync(abs, "utf-8").replace(/\r\n/g, "\n");

    const rows: any[] = [];
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            rows.push(JSON.parse(t));
        } catch {
            // ignore
        }
    }
    return rows;
}

function main() {
    const argv = process.argv.slice(2);
    const inPath = getArg(argv, "--in") || "datasets/ko_scam/scenarios_ko_v1.jsonl";
    const outPath = getArg(argv, "--out") || "public/simindex_ko_v1.json";

    const rows = readJsonl(inPath);

    const items: SimIndexItem[] = [];

    for (const row of rows) {
        const id = String(row?.id ?? "").trim();
        if (!id) continue;

        const thread =
            String((row as any)?.thread ?? "").trim() ||
            String((row as any)?.threadText ?? "").trim() ||
            String((row as any)?.thread_text ?? "").trim() ||
            String((row as any)?.rawThread ?? "").trim() ||
            String((row as any)?.rawThreadText ?? "").trim() ||
            String((row as any)?.threadRaw ?? "").trim() ||
            String((row as any)?.thread_raw ?? "").trim() ||
            String((row as any)?.text ?? "").trim() ||
            "";
        const messages = splitThread(thread);

        // ✅ UI 설명용: 후보 원문(sample) + label
        const norm1 = (s: string) => String(s || "").replace(/\s+/g, " ").trim();
        const sOnly = messages
            .map((m) => String(m || "").trim())
            .filter(Boolean)
            .filter((m) => /^\s*S\s*:\s*/i.test(m))
            .map((m) => m.replace(/^\s*S\s*:\s*/i, "").trim());

        const engineText = norm1(sOnly.length ? sOnly.join(" ") : messages.join(" "));
        const sample = engineText.slice(0, 160);

        const category0 = String((row as any)?.category ?? "").trim();
        const label = `${category0 || "unknown"} · ${id}`;

        const callChecks = {
            otpAsked: false,
            remoteAsked: false,
            urgentPressured: false,
            firstContact: false,
            ...(row?.callChecks || {}),
        } as any;

        const r = scoreThread(messages, callChecks);

        const vec = vecFromSignals((r as any).signals || []);
        items.push({
            id,
            category: row?.category,
            expectedRisk: row?.expected?.riskLevel,
            vec,

            // ✅ rankSimilar → UI로 흘려보낼 필드
            label,
            sample,
        } as any);
    }

    const payload: SimIndexFile = {
        version: 1,
        createdAt: new Date().toISOString(),
        source: inPath,
        items,
    };

    const absOut = path.isAbsolute(outPath) ? outPath : path.join(process.cwd(), outPath);
    fs.mkdirSync(path.dirname(absOut), { recursive: true });
    fs.writeFileSync(absOut, JSON.stringify(payload, null, 2), "utf-8");

    console.log(`OK: ${items.length} items -> ${absOut}`);
}

main();
