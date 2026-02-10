// tools/analysis/reportFails.ts
// Run:
//   npx tsx tools/analysis/reportFails.ts --fails corpus/derived/fails_v3.jsonl --top 15 --samples 3

import fs from "node:fs";
import path from "node:path";

type Risk = string;
type Stage = string;

type FailRow = {
    id: string;
    label?: string;
    expected: { riskLevel?: Risk; score_min?: number; stagePeak?: Stage; triggered?: boolean };
    got: { riskLevel?: Risk; scoreTotal?: number; stagePeak?: Stage; triggered?: boolean };
    why: string[];
    senderText?: string;
    meta?: any;
};

function abs(p: string) {
    return path.isAbsolute(p) ? p : path.join(process.cwd(), p);
}

function parseArgs(argv: string[]) {
    const out = { fails: "", top: 12, samples: 3 };
    const has = (k: string) => argv.includes(k);
    const get = (k: string) => {
        const i = argv.findIndex((x) => x === k);
        return i >= 0 ? (argv[i + 1] ?? "") : "";
    };

    if (has("--help") || has("-h")) {
        console.log(
            [
                "Usage:",
                "  npx tsx tools/analysis/reportFails.ts --fails <jsonl> [--top N] [--samples N]",
                "",
                "Example:",
                "  npx tsx tools/analysis/reportFails.ts --fails corpus/derived/fails_v3.jsonl --top 15 --samples 3",
            ].join("\n")
        );
        process.exit(0);
    }

    const f = get("--fails");
    if (f) out.fails = f;
    const t = get("--top");
    if (t && Number.isFinite(Number(t))) out.top = Math.max(1, Math.floor(Number(t)));
    const s = get("--samples");
    if (s && Number.isFinite(Number(s))) out.samples = Math.max(0, Math.floor(Number(s)));

    if (!out.fails) throw new Error("Missing: --fails <jsonl>");
    return out;
}

function readJsonl(filePath: string): FailRow[] {
    const raw = fs.readFileSync(abs(filePath), "utf-8").replace(/\r\n/g, "\n");
    const rows: FailRow[] = [];
    for (const line of raw.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
            rows.push(JSON.parse(t));
        } catch { }
    }
    return rows;
}

function whyKeyOf(w: string) {
    if (w.startsWith("risk mismatch:")) return "risk";
    if (w.startsWith("stagePeak mismatch:")) return "stage";
    if (w.startsWith("score below min:")) return "score";
    if (w.startsWith("triggered mismatch:")) return "triggered";
    if (w.startsWith("analyzeThread threw:")) return "engine_throw";
    return "other";
}

function inc(map: Record<string, number>, k: string, n = 1) {
    map[k] = (map[k] || 0) + n;
}

function topPairs(map: Record<string, number>, top: number) {
    return Object.entries(map)
        .sort((a, b) => b[1] - a[1])
        .slice(0, top)
        .map(([k, v]) => ({ key: k, count: v }));
}

function short(s: string, n: number) {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function main() {
    const args = parseArgs(process.argv.slice(2));
    const rows = readJsonl(args.fails);

    const byReason: Record<string, number> = {};
    const byReasonCombo: Record<string, number> = {};
    const riskMx: Record<string, number> = {};
    const stageMx: Record<string, number> = {};

    const samplesByCombo: Record<string, FailRow[]> = {};

    for (const r of rows) {
        const keys = Array.from(new Set((r.why || []).map(whyKeyOf))).sort();
        const combo = keys.join("+") || "unknown";

        inc(byReasonCombo, combo);

        for (const k of keys) inc(byReason, k);

        const er = r.expected?.riskLevel ?? "NA";
        const gr = r.got?.riskLevel ?? "NA";
        inc(riskMx, `${er} -> ${gr}`);

        const es = r.expected?.stagePeak ?? "NA";
        const gs = r.got?.stagePeak ?? "NA";
        inc(stageMx, `${es} -> ${gs}`);

        if (!samplesByCombo[combo]) samplesByCombo[combo] = [];
        if (samplesByCombo[combo].length < args.samples) samplesByCombo[combo].push(r);
    }

    console.log("");
    console.log(`FAILS: ${rows.length}`);
    console.log("");

    console.log("== by reason ==");
    console.table(
        Object.entries(byReason)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => ({ reason: k, count: v }))
    );

    console.log("== by reason combo (interaction) ==");
    console.table(topPairs(byReasonCombo, args.top));

    console.log("== risk matrix (top) ==");
    console.table(topPairs(riskMx, args.top));

    console.log("== stage matrix (top) ==");
    console.table(topPairs(stageMx, args.top));

    console.log("== samples per combo ==");
    for (const [combo, ss] of Object.entries(samplesByCombo).sort((a, b) => (byReasonCombo[b[0]] || 0) - (byReasonCombo[a[0]] || 0))) {
        console.log("");
        console.log(`-- ${combo} (n=${byReasonCombo[combo] || 0}) --`);
        for (const it of ss) {
            console.log(
                `  - ${it.id} exp(${it.expected?.riskLevel}/${it.expected?.stagePeak}/${it.expected?.score_min ?? 0}) got(${it.got?.riskLevel}/${it.got?.stagePeak}/${it.got?.scoreTotal ?? 0})`
            );
            console.log(`    S: ${short(it.senderText || "", 160)}`);
        }
    }
}

main();
