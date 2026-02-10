// tools/analysis/buildSignalPack.ts (SWAP-IN)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type AnyObj = Record<string, any>;

function parseArgs(argv: string[]) {
    const out: AnyObj = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) continue;
        const k = a.slice(2);
        const v = argv[i + 1];
        if (!v || v.startsWith("--")) out[k] = true;
        else {
            out[k] = v;
            i++;
        }
    }
    return out;
}

function asBool(v: any, def: boolean) {
    if (v === undefined) return def;
    if (typeof v === "boolean") return v;
    const s = String(v).trim().toLowerCase();
    if (s === "false" || s === "0" || s === "no" || s === "off") return false;
    return true;
}

function mustFile(p: string, label: string) {
    if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
        throw new Error(`${label} not found: ${p}`);
    }
    return p;
}

function readJson(p: string) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p: string, obj: any) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function toDateKey(s: any): string {
    const v = String(s ?? "").trim();
    if (!v) return "";
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return "";
}

function topN<T>(arr: T[], n: number, keyFn: (x: T) => number) {
    return [...arr].sort((a, b) => keyFn(b) - keyFn(a)).slice(0, n);
}

function safeStr(x: any) {
    return String(x ?? "").trim();
}

function isMain() {
    try {
        const me = path.resolve(fileURLToPath(import.meta.url));
        const entry = path.resolve(process.argv[1] || "");
        return me === entry;
    } catch {
        return false;
    }
}

async function main() {
    const args = parseArgs(process.argv);

    const signalsDir = path.resolve(String(args.signalsDir || "./corpus/derived/signals"));
    const indexPath = path.resolve(String(args.index || path.join(signalsDir, "_index.json")));
    const outPath = path.resolve(
        String(args.out || "./corpus/derived/analysis/signal_pack.json")
    );

    const debug = asBool(args.debug, false);
    const maxExamplesPerSignal = Number(args.maxExamples || 6);
    const maxItemsPerSignature = Number(args.maxItemsPerSignature || 8);
    const topSignalsPerSignature = Number(args.topSignalsPerSignature || 12);
    const topSignalsGlobal = Number(args.topSignalsGlobal || 40);
    const topSignatures = Number(args.topSignatures || 60);

    mustFile(indexPath, "index");

    const index = readJson(indexPath);
    if (!Array.isArray(index)) throw new Error(`index is not array: ${indexPath}`);

    // ---- global aggregators ----
    const globalSignalCount = new Map<string, number>(); // key -> total count
    const globalDocFreq = new Map<string, number>(); // key -> docs containing signal
    const globalSigCount = new Map<string, number>(); // signature -> docs

    // source stats
    const perSourceCount = new Map<string, number>();

    // signature buckets
    type SigBucket = {
        signature: string;
        n_docs: number;
        per_signal_count: Map<string, number>; // signal key -> total count
        per_signal_docfreq: Map<string, number>; // signal key -> docs
        items: Array<{
            source: string;
            pstSn: string;
            date?: string;
            title?: string;
            signature: string;
            top: Array<{ key: string; count: number }>;
            out: string;
        }>;
        per_source_count: Map<string, number>;
        by_day: Map<string, number>;
        examples: Map<string, string[]>; // signal key -> example lines (dedup)
    };

    const sigBuckets = new Map<string, SigBucket>();

    // helper: load a signals json
    function loadSignalsDoc(outRel: string) {
        const abs = path.resolve(process.cwd(), outRel.replace(/\//g, path.sep));
        if (!fs.existsSync(abs)) return null;
        try {
            return readJson(abs);
        } catch {
            return null;
        }
    }

    for (const row of index) {
        const source = safeStr(row?.source);
        const pstSn = safeStr(row?.pstSn);
        const signature = safeStr(row?.signature) || "sig:none";
        const outRel = safeStr(row?.out);

        if (!source || !pstSn || !outRel) continue;

        perSourceCount.set(source, (perSourceCount.get(source) || 0) + 1);
        globalSigCount.set(signature, (globalSigCount.get(signature) || 0) + 1);

        // bucket init
        if (!sigBuckets.has(signature)) {
            sigBuckets.set(signature, {
                signature,
                n_docs: 0,
                per_signal_count: new Map(),
                per_signal_docfreq: new Map(),
                items: [],
                per_source_count: new Map(),
                by_day: new Map(),
                examples: new Map(),
            });
        }
        const bucket = sigBuckets.get(signature)!;
        bucket.n_docs += 1;
        bucket.per_source_count.set(source, (bucket.per_source_count.get(source) || 0) + 1);

        // load doc (for examples/date/title + full signals)
        const doc = loadSignalsDoc(outRel);
        const dateKey = toDateKey(doc?.date);
        if (dateKey) bucket.by_day.set(dateKey, (bucket.by_day.get(dateKey) || 0) + 1);

        const itemTop = Array.isArray(row?.top) ? row.top : [];
        bucket.items.push({
            source,
            pstSn,
            date: dateKey || undefined,
            title: safeStr(doc?.title) || undefined,
            signature,
            top: itemTop.map((x: any) => ({ key: safeStr(x?.key), count: Number(x?.count || 0) })),
            out: outRel,
        });

        // aggregate counts + docfreq
        const seenInDoc = new Set<string>();

        // prefer full signals array from doc, fallback to row.top
        const sigArr = Array.isArray(doc?.signals) ? doc.signals : null;
        const list = sigArr && sigArr.length
            ? sigArr.map((s: any) => ({
                key: safeStr(s?.key),
                count: Number(s?.count || 0),
                examples: Array.isArray(s?.examples) ? s.examples.map((e: any) => safeStr(e)).filter(Boolean) : [],
            }))
            : itemTop.map((t: any) => ({ key: safeStr(t?.key), count: Number(t?.count || 0), examples: [] as string[] }));

        for (const s of list) {
            if (!s.key) continue;

            // global total count
            globalSignalCount.set(s.key, (globalSignalCount.get(s.key) || 0) + s.count);

            // per signature total count
            bucket.per_signal_count.set(s.key, (bucket.per_signal_count.get(s.key) || 0) + s.count);

            if (!seenInDoc.has(s.key)) {
                seenInDoc.add(s.key);
                // global docfreq
                globalDocFreq.set(s.key, (globalDocFreq.get(s.key) || 0) + 1);
                // per signature docfreq
                bucket.per_signal_docfreq.set(s.key, (bucket.per_signal_docfreq.get(s.key) || 0) + 1);
            }

            // examples (dedup)
            if (s.examples && s.examples.length) {
                if (!bucket.examples.has(s.key)) bucket.examples.set(s.key, []);
                const cur = bucket.examples.get(s.key)!;
                for (const ex of s.examples) {
                    if (!ex) continue;
                    if (cur.includes(ex)) continue;
                    cur.push(ex);
                    if (cur.length >= maxExamplesPerSignal) break;
                }
            }
        }
    }

    // ---- build output ----
    const totalDocs = index.length;

    const sources = [...perSourceCount.entries()]
        .map(([source, n_docs]) => ({ source, n_docs }))
        .sort((a, b) => b.n_docs - a.n_docs);

    const globalSignals = [...globalSignalCount.entries()]
        .map(([key, total_count]) => ({
            key,
            total_count,
            doc_freq: globalDocFreq.get(key) || 0,
            doc_ratio: totalDocs ? (globalDocFreq.get(key) || 0) / totalDocs : 0,
        }))
        .sort((a, b) => b.total_count - a.total_count)
        .slice(0, topSignalsGlobal);

    const signatures = [...sigBuckets.values()]
        .sort((a, b) => b.n_docs - a.n_docs)
        .slice(0, topSignatures)
        .map((b) => {
            const perSignal = [...b.per_signal_count.entries()].map(([key, total_count]) => ({
                key,
                total_count,
                doc_freq: b.per_signal_docfreq.get(key) || 0,
            }));

            const topSignals = perSignal
                .sort((x, y) => y.total_count - x.total_count)
                .slice(0, topSignalsPerSignature);

            const bySource = [...b.per_source_count.entries()]
                .map(([source, n_docs]) => ({ source, n_docs }))
                .sort((x, y) => y.n_docs - x.n_docs);

            const byDay = [...b.by_day.entries()]
                .map(([day, n_docs]) => ({ day, n_docs }))
                .sort((x, y) => (x.day < y.day ? -1 : x.day > y.day ? 1 : 0));

            // representative items: sum of top-counts in row.top
            const scoredItems = b.items.map((it) => ({
                ...it,
                score: (it.top || []).reduce((acc, t) => acc + Number(t.count || 0), 0),
            }));

            const reps = topN(scoredItems, maxItemsPerSignature, (x) => x.score).map((it) => ({
                source: it.source,
                pstSn: it.pstSn,
                date: it.date,
                title: it.title,
                score: it.score,
                out: it.out,
                top: it.top,
            }));

            const examples: Record<string, string[]> = {};
            for (const [k, arr] of b.examples.entries()) examples[k] = arr.slice(0, maxExamplesPerSignal);

            return {
                signature: b.signature,
                n_docs: b.n_docs,
                by_source: bySource,
                by_day: byDay,
                top_signals: topSignals,
                examples,
                representative_items: reps,
            };
        });

    const outObj = {
        meta: {
            generated_at: new Date().toISOString(),
            total_docs: totalDocs,
            signals_dir: signalsDir,
            index: indexPath,
            params: {
                maxExamplesPerSignal,
                maxItemsPerSignature,
                topSignalsPerSignature,
                topSignalsGlobal,
                topSignatures,
            },
        },
        sources,
        global_top_signals: globalSignals,
        signatures,
    };

    writeJson(outPath, outObj);

    console.log(`pack_written: ${outPath}`);
    console.log(`total_docs: ${totalDocs}`);
    console.log(`signatures: ${sigBuckets.size}`);
    console.log(`sources: ${sources.length}`);

    if (debug) {
        const topSig = [...globalSigCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        console.log("[TOP_SIGNATURES]", topSig);
    }
}

if (isMain()) {
    main().catch((e) => {
        console.error("FATAL:", e);
        process.exit(1);
    });
}
