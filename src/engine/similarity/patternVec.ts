import type { SignalSummary } from "../../types/analysis";

export type SparseVec = Record<string, number>;

export function vecFromSignals(signals: SignalSummary[], opts?: { topK?: number }): SparseVec {
    const topK = opts?.topK ?? 24;
    const list = Array.isArray(signals) ? signals.slice() : [];

    list.sort((a: any, b: any) => Number(b?.weightSum ?? 0) - Number(a?.weightSum ?? 0));

    let maxW = 0;
    for (const s of list.slice(0, topK)) {
        const w = Number((s as any)?.weightSum ?? 0);
        if (Number.isFinite(w) && w > maxW) maxW = w;
    }
    if (maxW <= 0) return {};

    const v: SparseVec = {};
    for (const s of list.slice(0, topK)) {
        const id = String((s as any)?.id ?? "").trim();
        const w0 = Number((s as any)?.weightSum ?? 0);
        if (!id) continue;
        if (!Number.isFinite(w0) || w0 <= 0) continue;

        // log scale + normalize
        const w = Math.log1p(w0) / Math.log1p(maxW);
        v[id] = w;
    }
    return v;
}

export function cosine(a: SparseVec, b: SparseVec): number {
    let dot = 0;
    let na = 0;
    let nb = 0;

    for (const k of Object.keys(a)) {
        const av = a[k];
        if (!Number.isFinite(av)) continue;
        na += av * av;

        const bv = b[k];
        if (Number.isFinite(bv)) dot += av * bv;
    }

    for (const k of Object.keys(b)) {
        const bv = b[k];
        if (!Number.isFinite(bv)) continue;
        nb += bv * bv;
    }

    if (na <= 0 || nb <= 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function sharedTopKeys(a: SparseVec, b: SparseVec, n = 3): string[] {
    const common: Array<{ k: string; s: number }> = [];
    for (const k of Object.keys(a)) {
        if (b[k] == null) continue;
        common.push({ k, s: (a[k] ?? 0) + (b[k] ?? 0) });
    }
    common.sort((x, y) => y.s - x.s);
    return common.slice(0, n).map((x) => x.k);
}
