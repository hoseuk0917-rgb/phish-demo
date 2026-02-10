// src/engine/semantic/clientSemIndex.ts
import type { SemIndexFile, SemIndexItem } from "./semIndex";

export type { SemIndexFile, SemIndexItem } from "./semIndex";

let cacheValue: SemIndexFile | null = null;
let cachePromise: Promise<SemIndexFile> | null = null;

const DEFAULT_PATH = "semindex_ko_e5_small_v1.json";

function normalizePath(url?: string) {
    const s = String(url || "").trim();
    if (!s) return `/${DEFAULT_PATH}`;
    return s.startsWith("/") ? s : `/${s}`;
}

function asFile(v: unknown): SemIndexFile {
    const anyV: any = v as any;
    const items: SemIndexItem[] = Array.isArray(anyV?.items) ? anyV.items : [];
    const dim = Number(anyV?.dim ?? (items[0]?.vec?.length ?? 0)) || 0;

    return {
        version: Number(anyV?.version ?? 1),
        createdAt: String(anyV?.createdAt ?? new Date().toISOString()),
        source: String(anyV?.source ?? "unknown"),
        lang: anyV?.lang ? String(anyV.lang) : undefined,
        model: String(anyV?.model ?? "unknown"),
        dim,
        items,
    };
}

export function getSemIndexCached(): SemIndexFile | null {
    return cacheValue;
}

export async function loadSemIndexOnce(url?: string, timeoutMs = 12000): Promise<SemIndexFile> {
    if (cacheValue) return cacheValue;
    if (cachePromise) return cachePromise;

    const path = normalizePath(url);

    cachePromise = (async () => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), Math.max(500, timeoutMs));

        try {
            const res = await fetch(path, { signal: ac.signal, cache: "no-store" as any });
            if (!res.ok) throw new Error(`semindex fetch failed: ${res.status}`);
            const json = (await res.json()) as any;
            cacheValue = asFile(json);
            return cacheValue;
        } finally {
            clearTimeout(t);
            cachePromise = null;
        }
    })();

    return cachePromise;
}

export async function loadSemIndexItemsOnce(url?: string, timeoutMs = 12000): Promise<SemIndexItem[]> {
    const file = await loadSemIndexOnce(url, timeoutMs);
    return Array.isArray(file.items) ? file.items : [];
}
