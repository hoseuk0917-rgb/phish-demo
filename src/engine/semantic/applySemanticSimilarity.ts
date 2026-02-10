// src/engine/semantic/applySemanticSimilarity.ts
import type { SemIndexItem, DenseVec } from "./semIndex";
import { rankSemantic } from "./rankSemantic";
import type { SimilarityMatch } from "../../types/analysis";

function clamp01(x: number) {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(1, x));
}

export function applySemanticFromVec(
    queryVec: DenseVec | null | undefined,
    items: SemIndexItem[] | null | undefined,
    opts?: { topK?: number; minSim?: number }
): SimilarityMatch[] {
    if (!Array.isArray(items) || items.length === 0) return [];
    if (!Array.isArray(queryVec) || queryVec.length === 0) return [];

    const topK = Math.max(1, Math.min(20, Number(opts?.topK ?? 6)));
    const minSim = typeof opts?.minSim === "number" ? clamp01(opts.minSim) : undefined;

    const ranked = rankSemantic(queryVec, items, { topK, minSim });

    const out: SimilarityMatch[] = [];
    for (const r of ranked) {
        const id = String(r.id || "").trim();
        const sim = Number(r.similarity);
        if (!id) continue;
        if (!Number.isFinite(sim)) continue;

        const label = r.category ? `${r.category} · ${id}` : id;
        out.push({
            id,
            label,
            similarity: sim,
            category: r.category,
            expectedRisk: r.expectedRisk,
            sharedSignals: r.textHint ? [r.textHint].slice(0, 1) : undefined, // 재활용 슬롯(원하면 나중에 필드 분리)
        });
        if (out.length >= topK) break;
    }

    return out;
}
