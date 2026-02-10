// src/engine/similarity/similarityFromSignals.ts
import { vecFromSignals, type SparseVec } from "./patternVec";
import { rankSimilar } from "./rankSimilar";
import type { SimIndexItem } from "./simIndex";

export type SimilarityHit = {
    id: string;
    label: string;
    similarity: number;
    category?: string;
    expectedRisk?: string;
    sharedSignals?: string[];
};

/**
 * ✅ "임베딩(유사도)용 query vector"를 만든다.
 * - 호출 형태를 모두 허용:
 *   1) similarityFromSignals(signals)
 *   2) similarityFromSignals(signals, opts)
 *   3) similarityFromSignals(signals, items)           // items는 무시(호환)
 *   4) similarityFromSignals(signals, items, opts)     // items는 무시(호환)
 *
 * - 반환은 항상 SparseVec (rank 결과가 아니라 "벡터")
 */
export function similarityFromSignals(
    signals: any[],
    itemsOrOpts?: SimIndexItem[] | { topK?: number } | null,
    optsMaybe?: { topK?: number }
): SparseVec {
    const isItems = Array.isArray(itemsOrOpts);
    const opts = (isItems ? optsMaybe : itemsOrOpts) as { topK?: number } | undefined;

    const topK = Math.max(1, Math.floor(opts?.topK ?? 12));

    if (!Array.isArray(signals) || signals.length === 0) return {};

    try {
        const qv = (vecFromSignals as any)(signals, { topK }) as SparseVec;
        if (!qv || typeof qv !== "object") return {};
        return qv;
    } catch {
        return {};
    }
}

/**
 * (선택) 신호→벡터→시나리오 topK 매칭까지 한 번에 필요하면 사용.
 * applySimilarityFromSignals가 이미 이 역할을 하니까, UI 쪽에서만 쓰고 싶을 때만 사용.
 */
export function similarityHitsFromSignals(
    signals: any[],
    items: SimIndexItem[],
    opts?: { topK?: number; minSim?: number }
): SimilarityHit[] {
    const topK = Math.max(1, Math.floor(opts?.topK ?? 6));

    if (!Array.isArray(signals) || signals.length === 0) return [];
    if (!Array.isArray(items) || items.length === 0) return [];

    try {
        const qv = similarityFromSignals(signals, { topK: 12 });

        const ranked = (rankSimilar as any)(qv, items, { topK, minSim: opts?.minSim });
        if (!Array.isArray(ranked)) return [];

        return ranked
            .map((r: any) => ({
                id: String(r?.id ?? "").trim(),
                label: String(r?.label ?? "").trim(),
                similarity: Number(r?.similarity ?? 0),
                category: r?.category ? String(r.category).trim() : undefined,
                expectedRisk: r?.expectedRisk ? String(r.expectedRisk).trim() : undefined,
                sharedSignals: Array.isArray(r?.sharedSignals)
                    ? r.sharedSignals.map((x: any) => String(x).trim()).filter(Boolean).slice(0, 6)
                    : undefined,
            }))
            .filter((x) => x.id && Number.isFinite(x.similarity))
            .slice(0, topK);
    } catch {
        return [];
    }
}
