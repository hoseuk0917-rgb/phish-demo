// src/engine/similarity/applySimilarity.ts
import type { SimIndexItem } from "./simIndex";
import { rankSimilar, type SimilarityHit } from "./rankSimilar";
import { similarityFromSignals } from "./similarityFromSignals";

export type SimilarityMatch = {
    id: string;
    label: string; // UI 표시용
    sample?: string; // UI에 "유사 문장" 표시용
    similarity: number;
    category?: string;
    expectedRisk?: string;
    sharedSignals?: string[];
};

function clamp01(x: number) {
    if (!Number.isFinite(x)) return 0;
    return Math.max(0, Math.min(1, x));
}

export function applySimilarityFromSignals(
    signals: unknown,
    items: SimIndexItem[] | null | undefined,
    opts?: { topK?: number; minSim?: number }
): SimilarityMatch[] {
    if (!Array.isArray(items) || items.length === 0) return [];

    const topK = Math.max(1, Math.min(20, Number(opts?.topK ?? 6)));

    // minSim: 미지정이면 "필터 없음" (-1)로 두되,
    // rankSimilar에는 undefined로 넘겨서(= 내부 default 사용) 불필요한 오작동/과필터를 막음
    const minSimRaw = typeof opts?.minSim === "number" ? opts.minSim : -1;
    const minSimForRank = minSimRaw < 0 ? undefined : clamp01(minSimRaw);
    const minSimCheck = minSimRaw < 0 ? -Infinity : clamp01(minSimRaw);

    try {
        // similarityFromSignals 시그니처가 (signals, items) 이든 (signals) 이든 둘 다 안전하게 처리
        let vec: any;
        try {
            vec = (similarityFromSignals as any)(signals as any, items as any);
        } catch {
            vec = (similarityFromSignals as any)(signals as any);
        }

        // rankSimilar: (queryVec, items, opts)
        const ranked = rankSimilar(vec as any, items, { topK, minSim: minSimForRank as any }) as SimilarityHit[];

        const out: SimilarityMatch[] = [];
        for (const r of Array.isArray(ranked) ? ranked : []) {
            const id = String((r as any)?.id ?? "").trim();
            const simNum = Number((r as any)?.similarity ?? NaN);
            if (!id) continue;
            if (!Number.isFinite(simNum)) continue;
            if (simNum < minSimCheck) continue;

            const category = (r as any)?.category ? String((r as any).category).trim() : undefined;
            const expectedRisk = (r as any)?.expectedRisk ? String((r as any).expectedRisk).trim() : undefined;
            const sharedSignals = Array.isArray((r as any)?.sharedSignals)
                ? ((r as any).sharedSignals as any[])
                    .map((x) => String(x).trim())
                    .filter(Boolean)
                    .slice(0, 6)
                : undefined;

            const hitLabel = String((r as any)?.label ?? "").trim();
            const label = hitLabel || (category ? `${category} · ${id}` : id);

            const sample0 = String((r as any)?.sample ?? "").trim();
            const sample = sample0 ? sample0 : undefined;

            out.push({ id, label, sample, similarity: simNum, category, expectedRisk, sharedSignals });
            if (out.length >= topK) break;
        }

        return out;
    } catch {
        return [];
    }
}
