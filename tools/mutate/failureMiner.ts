import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { createEmbedder, cosineSimNormalized } from "./embed";

type RiskLevel = "low" | "medium" | "high";
type StageId = string;

type FailItem = {
    id: string;
    label?: string;
    expected: { riskLevel: RiskLevel; score_min?: number; stagePeak?: StageId; triggered?: boolean };
    got: { riskLevel: RiskLevel; scoreTotal: number; stagePeak: StageId; triggered: boolean };
    why: string[];
    thread: string;
    senderText: string;
    notes?: any;
    meta?: any;
    should_trigger?: any;

    // runDataset dump가 아닌 원본 dataset enrich용(있으면)
    meta_mut?: any;
};

type MutatedRow = {
    id: string;
    thread: string;
    expected?: any;
    meta_mut?: any;
};

function sha256utf8(s: string) {
    return crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

function nowIso() {
    return new Date().toISOString();
}

function ensureDirForFile(p: string) {
    const dir = path.dirname(p);
    fs.mkdirSync(dir, { recursive: true });
}

function writeText(p: string, text: string) {
    const abs = path.resolve(p);
    ensureDirForFile(abs);
    fs.writeFileSync(abs, text, "utf8");
}

function writeJson(p: string, obj: any) {
    writeText(p, JSON.stringify(obj, null, 2) + "\n");
}

function readJsonl<T = any>(p: string): T[] {
    const abs = path.resolve(p);
    const raw = fs.readFileSync(abs, "utf8");
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    return lines.map((l) => JSON.parse(l));
}

function arg(key: string) {
    const i = process.argv.indexOf(key);
    if (i < 0) return "";
    return process.argv[i + 1] ?? "";
}
function has(key: string) {
    return process.argv.includes(key);
}
function argNum(key: string, def: number) {
    const v = arg(key);
    if (!v) return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
}

function whyKeyOf(w: string) {
    if (w.startsWith("risk mismatch:")) return "risk_mismatch";
    if (w.startsWith("score below min:")) return "score_below_min";
    if (w.startsWith("stagePeak mismatch:")) return "stage_mismatch";
    if (w.startsWith("triggered mismatch:")) return "triggered_mismatch";
    if (w.startsWith("analyzeThread threw:")) return "engine_throw";
    return "other";
}

function parentIdOf(mutId: string) {
    // MUT-KO-2031_e3v1-0001  형태도 있고, MUT-KO-2031-0001 형태도 있을 수 있음
    // KO-로 시작하는 덩어리를 뽑는다.
    const m = String(mutId).match(/(KO-\d+[A-Za-z0-9_]*?)(?:-|$)/);
    if (m?.[1]) return m[1];
    // fallback: MUT- 다음부터 마지막 -0000 전까지
    const m2 = String(mutId).match(/^MUT-(.+?)-\d+$/);
    return m2?.[1] ?? "";
}

function percentile(sorted: number[], p: number) {
    if (!sorted.length) return null;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
    return sorted[idx];
}

async function main() {
    const datasetPath = arg("--dataset"); // optional enrich
    const failsPath = arg("--fails");
    const outJson = arg("--out-json");
    const outMd = arg("--out-md");

    const embedEnabled = !has("--no-embed");
    const embedModel = arg("--embed-model") || "Xenova/bert-base-multilingual-cased";
    const cacheDir = arg("--cache"); // optional
    const clusterSim = Number(arg("--cluster-sim") || "0.86");

    if (!failsPath || !outJson || !outMd) {
        console.error(
            "Usage: npx tsx tools/mutate/failureMiner.ts --fails <fails.jsonl> --out-json <report.json> --out-md <report.md> [--dataset <mutated.jsonl>] [--embed-model <model>] [--cluster-sim 0.86] [--cache .hf_cache] [--no-embed]"
        );
        process.exit(2);
    }

    const fails = readJsonl<FailItem>(failsPath);

    // dataset enrich: id -> meta_mut
    const metaMutById = new Map<string, any>();
    if (datasetPath) {
        const rows = readJsonl<MutatedRow>(datasetPath);
        for (const r of rows) {
            if (r?.id) metaMutById.set(String(r.id), r.meta_mut);
        }
        for (const f of fails) {
            const mm = metaMutById.get(String(f.id));
            if (mm) (f as any).meta_mut = mm;
        }
    }

    const totalFails = fails.length;

    // counts
    const reasonCounts: Record<string, number> = {};
    const parentCounts: Record<string, number> = {};
    const parentExamples: Record<string, string[]> = {};

    const riskPairs: Record<string, number> = {};
    const stagePairs: Record<string, number> = {};

    const scoreDeltas: number[] = [];
    const scoreDeltaByParent: Record<string, number[]> = {};

    for (const f of fails) {
        const pid = parentIdOf(f.id) || "unknown_parent";
        parentCounts[pid] = (parentCounts[pid] || 0) + 1;
        parentExamples[pid] = parentExamples[pid] || [];
        if (parentExamples[pid].length < 5) parentExamples[pid].push(f.id);

        // reasons
        if (Array.isArray(f.why) && f.why.length) {
            for (const w of f.why) {
                const k = whyKeyOf(String(w));
                reasonCounts[k] = (reasonCounts[k] || 0) + 1;

                // score delta only when score_below_min
                if (k === "score_below_min" && typeof f.expected?.score_min === "number") {
                    const d = Number(f.expected.score_min) - Number(f.got?.scoreTotal ?? 0);
                    if (Number.isFinite(d)) {
                        scoreDeltas.push(d);
                        scoreDeltaByParent[pid] = scoreDeltaByParent[pid] || [];
                        scoreDeltaByParent[pid].push(d);
                    }
                }
            }
        } else {
            reasonCounts.other = (reasonCounts.other || 0) + 1;
        }

        // risk/stage pairs
        const rp = `${f.expected?.riskLevel ?? "?"} → ${f.got?.riskLevel ?? "?"}`;
        riskPairs[rp] = (riskPairs[rp] || 0) + 1;

        const sp = `${f.expected?.stagePeak ?? "?"} → ${f.got?.stagePeak ?? "?"}`;
        stagePairs[sp] = (stagePairs[sp] || 0) + 1;
    }

    const sortedEntries = (obj: Record<string, number>) =>
        Object.entries(obj).sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));

    // embedding clustering (fails만)
    let clusters: any[] = [];
    if (embedEnabled && totalFails > 0) {
        const embedder = await createEmbedder(embedModel, cacheDir || undefined);

        const vecs: Float32Array[] = [];
        for (const f of fails) {
            vecs.push(await embedder.embed(String(f.senderText ?? "")));
        }

        const assigned = new Array(totalFails).fill(false);

        const makeCluster = (repIdx: number) => {
            const memberIdx: number[] = [repIdx];
            assigned[repIdx] = true;
            for (let j = 0; j < totalFails; j++) {
                if (assigned[j]) continue;
                const sim = cosineSimNormalized(vecs[repIdx], vecs[j]);
                if (sim >= clusterSim) {
                    assigned[j] = true;
                    memberIdx.push(j);
                }
            }
            return memberIdx;
        };

        const clusterIdxList: number[][] = [];
        for (let i = 0; i < totalFails; i++) {
            if (assigned[i]) continue;
            clusterIdxList.push(makeCluster(i));
        }

        clusters = clusterIdxList
            .map((idxs, ci) => {
                const members = idxs.map((k) => fails[k]);
                const rep = fails[idxs[0]];
                const reasonAgg: Record<string, number> = {};
                for (const m of members) {
                    for (const w of m.why || []) {
                        const rk = whyKeyOf(String(w));
                        reasonAgg[rk] = (reasonAgg[rk] || 0) + 1;
                    }
                }
                const topReasons = sortedEntries(reasonAgg).slice(0, 5).map(([k, v]) => ({ reason: k, count: v }));

                // avg sim to rep
                let ssum = 0;
                for (const k of idxs) {
                    ssum += cosineSimNormalized(vecs[idxs[0]], vecs[k]);
                }
                const avgSim = idxs.length ? ssum / idxs.length : 1;

                // top parents in cluster
                const pc: Record<string, number> = {};
                for (const m of members) {
                    const pid = parentIdOf(m.id) || "unknown_parent";
                    pc[pid] = (pc[pid] || 0) + 1;
                }
                const topParents = sortedEntries(pc).slice(0, 5).map(([k, v]) => ({ parent_id: k, count: v }));

                return {
                    cluster_id: `C${String(ci + 1).padStart(3, "0")}`,
                    size: idxs.length,
                    rep_id: rep.id,
                    avg_sim_to_rep: Number(avgSim.toFixed(4)),
                    top_reasons: topReasons,
                    top_parents: topParents,
                    member_ids: members.map((m) => m.id),
                };
            })
            .sort((a, b) => b.size - a.size);
    }

    // score delta stats
    scoreDeltas.sort((a, b) => a - b);
    const deltaStats = {
        count: scoreDeltas.length,
        min: scoreDeltas.length ? scoreDeltas[0] : null,
        p50: percentile(scoreDeltas, 50),
        p90: percentile(scoreDeltas, 90),
        max: scoreDeltas.length ? scoreDeltas[scoreDeltas.length - 1] : null,
        avg: scoreDeltas.length ? scoreDeltas.reduce((a, b) => a + b, 0) / scoreDeltas.length : null,
    };

    const topParents = sortedEntries(parentCounts)
        .slice(0, 20)
        .map(([pid, cnt]) => ({
            parent_id: pid,
            count: cnt,
            examples: parentExamples[pid] || [],
            score_delta_avg:
                scoreDeltaByParent[pid]?.length
                    ? scoreDeltaByParent[pid].reduce((a, b) => a + b, 0) / scoreDeltaByParent[pid].length
                    : null,
        }));

    const report = {
        schema_version: "mutation_report.v1",
        created_at: nowIso(),
        inputs: {
            dataset: datasetPath || null,
            fails: failsPath,
        },
        config: {
            embed: { enabled: embedEnabled, model: embedModel, cluster_sim: clusterSim, cache: cacheDir || null },
            digest: `sha256:${sha256utf8(JSON.stringify({ datasetPath, failsPath, embedEnabled, embedModel, clusterSim, cacheDir }))}`,
        },
        stats: {
            total_fails: totalFails,
            by_reason: sortedEntries(reasonCounts).map(([reason, count]) => ({ reason, count })),
            risk_pairs: sortedEntries(riskPairs).map(([pair, count]) => ({ pair, count })),
            stage_pairs: sortedEntries(stagePairs).map(([pair, count]) => ({ pair, count })),
            score_delta: deltaStats,
            top_parents: topParents,
            clusters,
        },
    };

    writeJson(outJson, report);

    // markdown
    const md: string[] = [];
    md.push(`# Mutation Failure Report`);
    md.push(`- created_at: ${report.created_at}`);
    md.push(`- fails: ${path.resolve(failsPath)}`);
    if (datasetPath) md.push(`- dataset: ${path.resolve(datasetPath)}`);
    md.push(`- total_fails: ${totalFails}`);
    md.push("");

    md.push(`## By reason`);
    for (const [k, v] of sortedEntries(reasonCounts).slice(0, 20)) md.push(`- ${k}: ${v}`);
    md.push("");

    md.push(`## Risk pairs (top 15)`);
    for (const [k, v] of sortedEntries(riskPairs).slice(0, 15)) md.push(`- ${k}: ${v}`);
    md.push("");

    md.push(`## Stage pairs (top 15)`);
    for (const [k, v] of sortedEntries(stagePairs).slice(0, 15)) md.push(`- ${k}: ${v}`);
    md.push("");

    md.push(`## Score delta (expected_min - gotScore)`);
    md.push(`- count: ${deltaStats.count}`);
    md.push(`- min: ${deltaStats.min}`);
    md.push(`- p50: ${deltaStats.p50}`);
    md.push(`- p90: ${deltaStats.p90}`);
    md.push(`- max: ${deltaStats.max}`);
    md.push(`- avg: ${deltaStats.avg !== null ? Number(deltaStats.avg.toFixed(3)) : null}`);
    md.push("");

    md.push(`## Top parents (top 15)`);
    for (const p of topParents.slice(0, 15)) {
        md.push(`- ${p.parent_id}: ${p.count}  (avg_score_delta=${p.score_delta_avg !== null ? Number(p.score_delta_avg.toFixed(2)) : "n/a"})`);
        md.push(`  - examples: ${p.examples.join(", ")}`);
    }
    md.push("");

    if (embedEnabled) {
        md.push(`## Embedding clusters (sim >= ${clusterSim})`);
        md.push(`- model: ${embedModel}`);
        for (const c of clusters.slice(0, 15)) {
            md.push(`- ${c.cluster_id}: size=${c.size} avgSim=${c.avg_sim_to_rep} rep=${c.rep_id}`);
            md.push(`  - top_reasons: ${c.top_reasons.map((x: any) => `${x.reason}(${x.count})`).join(", ")}`);
            md.push(`  - top_parents: ${c.top_parents.map((x: any) => `${x.parent_id}(${x.count})`).join(", ")}`);
        }
        md.push("");
    } else {
        md.push(`## Embedding clusters`);
        md.push(`- disabled (--no-embed)`);
        md.push("");
    }

    writeText(outMd, md.join("\n") + "\n");

    console.log(`OK: wrote report -> ${outJson}`);
    console.log(`OK: wrote report -> ${outMd}`);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
