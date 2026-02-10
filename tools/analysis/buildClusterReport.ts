// tools/analysis/buildClusterReport.ts (SWAP-IN)
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

function readJson(p: string) {
    return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p: string, obj: any) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function writeText(p: string, s: string) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, s, "utf8");
}

function safeStr(x: any) {
    return String(x ?? "").trim();
}

function toDateKey(s: any): string {
    const v = String(s ?? "").trim();
    if (!v) return "";
    const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    return "";
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

function normalizeRel(p: string) {
    return p.replace(/\//g, path.sep);
}

function existsFile(p: string) {
    try {
        return fs.existsSync(p) && fs.statSync(p).isFile();
    } catch {
        return false;
    }
}

type Signal = {
    key: string;
    label?: string;
    category?: string;
    count?: number;
    examples?: string[];
};

type SignalsDoc = {
    source: string;
    pstSn: string;
    title?: string;
    date?: string;
    signature?: string;
    signals?: Signal[];
};

function featureKeys(signals: Signal[], includeMeta: boolean) {
    const keys: string[] = [];
    for (const s of signals) {
        const k = safeStr(s?.key);
        if (!k) continue;
        if (!includeMeta && k.startsWith("meta:")) continue;
        keys.push(k);
    }
    return [...new Set(keys)];
}

function hasAnyPrefix(signals: Signal[], prefixes: string[], includeMeta: boolean) {
    for (const s of signals) {
        const k = safeStr(s?.key);
        if (!k) continue;
        if (!includeMeta && k.startsWith("meta:")) continue;
        for (const p of prefixes) if (k.startsWith(p)) return true;
    }
    return false;
}

function jaccard(a: string[], b: string[]) {
    if (!a.length && !b.length) return 1;
    if (!a.length || !b.length) return 0;
    const A = new Set(a);
    const B = new Set(b);
    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;
    const uni = A.size + B.size - inter;
    return uni <= 0 ? 0 : inter / uni;
}

function pickTopSignals(docs: Array<{ doc: SignalsDoc }>, includeMeta: boolean, topN: number) {
    const m = new Map<string, { key: string; total: number; docFreq: number }>();
    for (const { doc } of docs) {
        const signals = Array.isArray(doc.signals) ? doc.signals : [];
        const seen = new Set<string>();
        for (const s of signals) {
            const k = safeStr(s?.key);
            if (!k) continue;
            if (!includeMeta && k.startsWith("meta:")) continue;
            const cnt = Number(s?.count || 0);
            if (!m.has(k)) m.set(k, { key: k, total: 0, docFreq: 0 });
            m.get(k)!.total += cnt;
            if (!seen.has(k)) {
                seen.add(k);
                m.get(k)!.docFreq += 1;
            }
        }
    }
    return [...m.values()].sort((x, y) => y.total - x.total).slice(0, topN);
}

function mergeExamples(
    docs: Array<{ doc: SignalsDoc }>,
    keys: string[],
    maxPerKey: number,
    includeMeta: boolean
) {
    const out: Record<string, string[]> = {};
    const keySet = new Set(keys);
    for (const k of keys) out[k] = [];
    for (const { doc } of docs) {
        const signals = Array.isArray(doc.signals) ? doc.signals : [];
        for (const s of signals) {
            const k = safeStr(s?.key);
            if (!k || !keySet.has(k)) continue;
            if (!includeMeta && k.startsWith("meta:")) continue;
            const ex = Array.isArray(s?.examples) ? s.examples : [];
            for (const line of ex) {
                const t = safeStr(line);
                if (!t) continue;
                if (out[k].includes(t)) continue;
                out[k].push(t);
                if (out[k].length >= maxPerKey) break;
            }
        }
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv);

    const packPath = path.resolve(String(args.pack || "./corpus/derived/analysis/signal_pack.json"));
    const outJson = path.resolve(String(args.outJson || "./corpus/derived/analysis/cluster_pack.json"));
    const outMd = path.resolve(String(args.outMd || "./corpus/derived/analysis/cluster_report.md"));

    const debug = asBool(args.debug, false);
    const includeMeta = asBool(args.includeMeta, false);

    const maxDocsPerSig = Number(args.maxDocsPerSig || 500);
    const minJ = Number(args.minJaccard || 0.45);
    const maxClustersPerSig = Number(args.maxClustersPerSig || 30);

    const topSignalsPerCluster = Number(args.topSignalsPerCluster || 12);
    const maxExamplesPerSignal = Number(args.maxExamplesPerSignal || 4);

    // ✅ 신규 필터 옵션
    const requireActionOrImp = asBool(args.requireActionOrImp, false);
    const minSignalKeys = Number(args.minSignalKeys || 1);

    if (!existsFile(packPath)) {
        console.error(`ERROR: pack not found: ${packPath}`);
        process.exit(1);
    }

    const pack = readJson(packPath);
    const indexPath = safeStr(pack?.meta?.index);
    const signalsDir = safeStr(pack?.meta?.signals_dir);

    if (!indexPath || !existsFile(indexPath)) {
        console.error(`ERROR: pack.meta.index missing or not found: ${indexPath || "(empty)"}`);
        process.exit(1);
    }

    const index = readJson(indexPath);
    if (!Array.isArray(index)) {
        console.error(`ERROR: index is not array: ${indexPath}`);
        process.exit(1);
    }

    const bySig = new Map<string, any[]>();
    for (const row of index) {
        const sig = safeStr(row?.signature) || "sig:none";
        if (!bySig.has(sig)) bySig.set(sig, []);
        bySig.get(sig)!.push(row);
    }

    function loadSignalsDoc(outRel: string): SignalsDoc | null {
        const rel = normalizeRel(outRel);
        const abs = path.resolve(process.cwd(), rel);
        if (!existsFile(abs)) return null;
        try {
            const doc = readJson(abs);
            return doc as SignalsDoc;
        } catch {
            return null;
        }
    }

    type Member = {
        source: string;
        pstSn: string;
        date?: string;
        title?: string;
        out: string;
        signature: string;
        score_top?: number;
        keys: string[];
    };

    type Cluster = {
        id: string;
        seed_out: string;
        n_docs: number;
        top_signals: Array<{ key: string; total: number; docFreq: number }>;
        examples: Record<string, string[]>;
        members: Array<{
            source: string;
            pstSn: string;
            date?: string;
            title?: string;
            out: string;
            score_top?: number;
        }>;
    };

    const clustersBySig: Array<{
        signature: string;
        n_docs: number;
        clusters: Cluster[];
    }> = [];

    const sigCounts = [...bySig.entries()]
        .map(([signature, rows]) => ({ signature, n_docs: rows.length }))
        .sort((a, b) => b.n_docs - a.n_docs);

    let skippedInfoOnly = 0;
    let skippedTooSmall = 0;

    for (const { signature } of sigCounts) {
        const rows = bySig.get(signature)!;

        const members: Member[] = [];
        for (const r of rows.slice(0, maxDocsPerSig)) {
            const outRel = safeStr(r?.out);
            if (!outRel) continue;

            const doc = loadSignalsDoc(outRel);
            if (!doc) continue;

            const signals = Array.isArray(doc.signals) ? doc.signals : [];
            const keys = featureKeys(signals, includeMeta);

            if (keys.length < minSignalKeys) {
                skippedTooSmall++;
                continue;
            }

            // ✅ info-only/portal 컷: action/imp/pressure/platform 하나도 없으면 제외
            if (requireActionOrImp) {
                const hasAction = hasAnyPrefix(signals, ["action:"], includeMeta);
                const hasImp = hasAnyPrefix(signals, ["imp:", "impersonation:"], includeMeta);
                const hasPressure = hasAnyPrefix(signals, ["pressure:"], includeMeta);
                const hasPlatform = hasAnyPrefix(signals, ["platform:"], includeMeta);

                if (!hasAction && !hasImp && !hasPressure && !hasPlatform) {
                    skippedInfoOnly++;
                    continue;
                }
            }

            const top = Array.isArray(r?.top) ? r.top : [];
            const score_top = top.reduce((acc: number, t: any) => acc + Number(t?.count || 0), 0);

            members.push({
                source: safeStr(r?.source) || safeStr(doc.source),
                pstSn: safeStr(r?.pstSn) || safeStr(doc.pstSn),
                date: toDateKey(doc.date) || undefined,
                title: safeStr(doc.title) || undefined,
                out: outRel,
                signature,
                score_top,
                keys,
            });
        }

        if (!members.length) continue;

        members.sort((a, b) => (b.score_top || 0) - (a.score_top || 0));

        const clusters: Array<{ seed: Member; items: Member[] }> = [];

        for (const m of members) {
            let bestIdx = -1;
            let bestSim = -1;

            for (let i = 0; i < clusters.length; i++) {
                const sim = jaccard(clusters[i].seed.keys, m.keys);
                if (sim > bestSim) {
                    bestSim = sim;
                    bestIdx = i;
                }
            }

            if (bestIdx >= 0 && bestSim >= minJ) {
                clusters[bestIdx].items.push(m);
            } else {
                clusters.push({ seed: m, items: [m] });
                if (clusters.length >= maxClustersPerSig) continue;
            }
        }

        const outClusters: Cluster[] = [];
        let cIdx = 1;

        for (const c of clusters) {
            const docsForAgg: Array<{ doc: SignalsDoc }> = [];
            for (const it of c.items) {
                const d = loadSignalsDoc(it.out);
                if (d) docsForAgg.push({ doc: d });
            }

            const topSignals = pickTopSignals(docsForAgg, includeMeta, topSignalsPerCluster);
            const topKeys = topSignals.map((x) => x.key);
            const examples = mergeExamples(docsForAgg, topKeys, maxExamplesPerSignal, includeMeta);

            const memCompact = c.items.map((it) => ({
                source: it.source,
                pstSn: it.pstSn,
                date: it.date,
                title: it.title,
                out: it.out,
                score_top: it.score_top,
            }));

            outClusters.push({
                id: `C${String(cIdx).padStart(2, "0")}`,
                seed_out: c.seed.out,
                n_docs: c.items.length,
                top_signals: topSignals,
                examples,
                members: memCompact,
            });

            cIdx++;
        }

        outClusters.sort((a, b) => b.n_docs - a.n_docs);

        clustersBySig.push({
            signature,
            n_docs: members.length,
            clusters: outClusters,
        });

        if (debug) {
            console.log(`[SIG] ${signature} docs=${members.length} clusters=${outClusters.length}`);
        }
    }

    const outObj = {
        meta: {
            generated_at: new Date().toISOString(),
            pack: packPath,
            index: indexPath,
            signals_dir: signalsDir || "(unknown)",
            params: {
                includeMeta,
                maxDocsPerSig,
                minJaccard: minJ,
                maxClustersPerSig,
                topSignalsPerCluster,
                maxExamplesPerSignal,
                requireActionOrImp,
                minSignalKeys,
            },
            totals: {
                signatures_in_index: bySig.size,
                signatures_written: clustersBySig.length,
                docs_in_index: index.length,
            },
            skipped: {
                info_only: skippedInfoOnly,
                too_small: skippedTooSmall,
            },
        },
        signatures: clustersBySig,
    };

    writeJson(outJson, outObj);

    const lines: string[] = [];
    lines.push(`# Scam Signals Cluster Report`);
    lines.push(``);
    lines.push(`- generated_at: ${outObj.meta.generated_at}`);
    lines.push(`- docs_in_index: ${outObj.meta.totals.docs_in_index}`);
    lines.push(`- signatures_written: ${outObj.meta.totals.signatures_written}`);
    lines.push(`- minJaccard: ${minJ}`);
    lines.push(`- includeMeta: ${includeMeta}`);
    lines.push(`- requireActionOrImp: ${requireActionOrImp}`);
    lines.push(`- minSignalKeys: ${minSignalKeys}`);
    lines.push(`- skipped.info_only: ${outObj.meta.skipped.info_only}`);
    lines.push(`- skipped.too_small: ${outObj.meta.skipped.too_small}`);
    lines.push(``);

    lines.push(`## Top Signatures`);
    lines.push(`| signature | docs | clusters |`);
    lines.push(`|---|---:|---:|`);

    const sigRowMap = new Map<string, { docs: number; clusters: number }>();
    for (const s of clustersBySig) sigRowMap.set(s.signature, { docs: s.n_docs, clusters: s.clusters.length });

    for (const s of sigCounts.slice(0, 20)) {
        const hit = sigRowMap.get(s.signature);
        const docs = hit ? hit.docs : 0;
        const cls = hit ? hit.clusters : 0;
        if (!hit) continue; // 필터로 빠진 signature는 표에서 제외
        lines.push(`| ${s.signature} | ${docs} | ${cls} |`);
    }

    lines.push(``);
    for (const s of clustersBySig.sort((a, b) => b.n_docs - a.n_docs)) {
        lines.push(`---`);
        lines.push(`## ${s.signature}  (docs=${s.n_docs}, clusters=${s.clusters.length})`);
        lines.push(``);

        for (const c of s.clusters) {
            lines.push(`### ${c.id}  (docs=${c.n_docs})`);
            lines.push(`- seed_out: \`${c.seed_out}\``);
            lines.push(``);

            if (c.top_signals.length) {
                lines.push(`**top_signals**`);
                for (const ts of c.top_signals) {
                    lines.push(`- ${ts.key} (total=${ts.total}, docFreq=${ts.docFreq})`);
                    const ex = c.examples?.[ts.key] || [];
                    for (const e of ex) lines.push(`  - 예: ${e}`);
                }
                lines.push(``);
            }

            lines.push(`**members (top 10)**`);
            const topMembers = [...c.members]
                .sort((x, y) => (y.score_top || 0) - (x.score_top || 0))
                .slice(0, 10);

            for (const m of topMembers) {
                const title = m.title ? m.title.replace(/\s+/g, " ").slice(0, 120) : "";
                const dt = m.date ? m.date : "";
                lines.push(
                    `- ${m.source}/pstSn_${m.pstSn} ${dt ? `(${dt})` : ""} ${title ? `- ${title}` : ""}  \`${m.out}\``
                );
            }
            lines.push(``);
        }
    }

    writeText(outMd, lines.join("\n"));

    console.log(`cluster_pack_written: ${outJson}`);
    console.log(`report_written: ${outMd}`);
}

if (isMain()) {
    main().catch((e) => {
        console.error("FATAL:", e);
        process.exit(1);
    });
}
