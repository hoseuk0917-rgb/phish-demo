// src/engine/similarity/simIndexLoader.ts
import type { SimIndexFile } from "./simIndex";

let cache: SimIndexFile | null = null;
let inflight: Promise<SimIndexFile> | null = null;

function isObject(v: unknown): v is Record<string, any> {
    return !!v && typeof v === "object";
}

export function getSimIndexCached(): SimIndexFile | null {
    return cache;
}

export async function loadSimIndex(url = "/simindex_ko_v2.json"): Promise<SimIndexFile> {
    if (cache) return cache;
    if (inflight) return inflight;

    inflight = (async () => {
        const res = await fetch(url, { cache: "no-cache" });
        if (!res.ok) throw new Error(`simindex fetch failed: ${res.status} ${res.statusText}`);

        const json = (await res.json()) as unknown;
        if (!isObject(json)) throw new Error("simindex invalid: not an object");

        const items = (json as any).items;
        if (!Array.isArray(items)) throw new Error("simindex invalid: items[] missing");

        cache = json as SimIndexFile;
        return cache;
    })();

    try {
        return await inflight;
    } finally {
        inflight = null;
    }
}
