// src/engine/semantic/rankSemantic.ts
import type { SemIndexItem, DenseVec } from "./semIndex";

export type SemanticHit = {
    id: string;
    similarity: number;
    category?: string;
    expectedRisk?: string;
    textHint?: string;
};

function clamp01(x: number) {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(1, x));
}

// vectors are assumed unit-normalized; cosine = dot
function dot(a: DenseVec, b: DenseVec): number {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += (a[i] || 0) * (b[i] || 0);
    return s;
}

export function rankSemantic(
    queryVec: DenseVec,
    items: SemIndexItem[],
    opts?: { topK?: number; minSim?: number }
): SemanticHit[] {
    if (!Array.isArray(items) || items.length === 0) return [];
    if (!Array.isArray(queryVec) || queryVec.length === 0) return [];

    const topK = Math.max(1, Math.min(20, Number(opts?.topK ?? 6)));
    const minSim = typeof opts?.minSim === "number" ? clamp01(opts.minSim) : undefined;

    const scored: SemanticHit[] = [];
    for (const it of items) {
        const v = (it as any)?.vec;
        if (!Array.isArray(v) || v.length === 0) continue;

        const sim = dot(queryVec, v);
        if (!Number.isFinite(sim)) continue;

        // cosine(sim)은 보통 [0,1] 근처로 나옴 (음수면 0으로 clamp)
        const s01 = clamp01(sim);

        if (minSim != null && s01 < minSim) continue;

        scored.push({
            id: String((it as any)?.id ?? "").trim(),
            similarity: s01,
            category: (it as any)?.category ? String((it as any).category).trim() : undefined,
            expectedRisk: (it as any)?.expectedRisk ? String((it as any).expectedRisk).trim() : undefined,
            textHint: (it as any)?.textHint ? String((it as any).textHint).trim() : undefined,
        });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
}
