import { cosine, sharedTopKeys, type SparseVec } from "./patternVec";
import type { SimIndexItem } from "./simIndex";

export type SimilarityHit = {
    id: string;
    label?: string;
    sample?: string;
    category?: string;
    expectedRisk?: string;
    similarity: number;
    sharedSignals: string[];
};

export function rankSimilar(
    query: SparseVec,
    items: SimIndexItem[],
    opts?: { topK?: number; minSim?: number }
): SimilarityHit[] {
    const topK = opts?.topK ?? 3;
    const minSim = opts?.minSim ?? 0.35;

    const scored: SimilarityHit[] = [];
    for (const it of items) {
        const sim = cosine(query, it.vec || {});
        if (sim < minSim) continue;

        scored.push({
            id: it.id,
            label: String((it as any)?.label ?? "").trim() || undefined,
            sample: String((it as any)?.sample ?? "").trim() || undefined,
            category: it.category,
            expectedRisk: it.expectedRisk,
            similarity: sim,
            sharedSignals: sharedTopKeys(query, it.vec || {}, 3),
        });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}

