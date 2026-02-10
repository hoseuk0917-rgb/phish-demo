// src/engine/similarity/clientSimIndex.ts
import type { SimIndexFile, SimIndexItem } from "./simIndex";

export type { SimIndexFile, SimIndexItem } from "./simIndex";
export { similarityFromSignals } from "./similarityFromSignals";

let cacheValue: SimIndexFile | null = null;
let cachePromise: Promise<SimIndexFile> | null = null;

const DEFAULT_SIMINDEX_PATH = "simindex_ko_v2.json";

function resolveSimIndexUrl(pathOrUrl?: string): string {
    const s = String(pathOrUrl || DEFAULT_SIMINDEX_PATH).trim();
    if (!s) return "/simindex_ko_v2.json";

    // absolute url
    if (/^https?:\/\//i.test(s)) return s;

    // absolute path
    if (s.startsWith("/")) return s;

    // vite base url (supports sub-path deployments)
    const base = (import.meta as any)?.env?.BASE_URL ? String((import.meta as any).env.BASE_URL) : "/";
    const b = base.endsWith("/") ? base : `${base}/`;
    return `${b}${s.replace(/^\/+/, "")}`;
}

function asFile(v: unknown): SimIndexFile {
    const obj = (v ?? null) as any;

    const version = typeof obj?.version === "number" ? obj.version : 1;
    const createdAt =
        typeof obj?.createdAt === "string" && obj.createdAt.trim()
            ? obj.createdAt.trim()
            : new Date(0).toISOString();

    const source =
        typeof obj?.source === "string" && obj.source.trim()
            ? obj.source.trim()
            : "unknown";

    const lang =
        typeof obj?.lang === "string" && obj.lang.trim()
            ? obj.lang.trim()
            : "unknown";

    const rawItems = Array.isArray(obj?.items) ? obj.items : [];

    // 최소한 "객체"만 남기고, 타입은 SimIndexItem으로 캐스팅
    const items = rawItems.filter((x: any) => x && typeof x === "object") as SimIndexItem[];

    return { version, createdAt, source, lang, items };
}

export function getSimIndexCached(): SimIndexFile | null {
    return cacheValue;
}

// ✅ 헷갈리지 말라고 items 전용 캐시 getter 추가
export function getSimIndexItemsCached(): SimIndexItem[] {
    return cacheValue?.items ?? [];
}

export async function loadSimIndexOnce(url?: string, timeoutMs = 9000): Promise<SimIndexFile> {
    if (cacheValue) return cacheValue;
    if (cachePromise) return cachePromise;

    const resolved = resolveSimIndexUrl(url);

    cachePromise = (async () => {
        const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
        const timer = ctrl ? window.setTimeout(() => ctrl.abort(), Math.max(1000, timeoutMs | 0)) : null;

        try {
            const res = await fetch(resolved, {
                cache: "no-store",
                signal: ctrl?.signal,
                headers: { "accept": "application/json" },
            });

            const text = await res.text();

            if (!res.ok) {
                const msg = text && text.trim() ? text.trim().slice(0, 220) : "";
                throw new Error(`simindex fetch failed: ${res.status} (${resolved})${msg ? ` :: ${msg}` : ""}`);
            }

            let json: any = null;
            try {
                json = text ? JSON.parse(text) : null;
            } catch (e: any) {
                throw new Error(`simindex json parse failed (${resolved}): ${String(e?.message || e)}`);
            }

            const file = asFile(json);
            cacheValue = file;
            return file;
        } finally {
            if (timer) window.clearTimeout(timer);
        }
    })();

    try {
        return await cachePromise;
    } finally {
        // 성공/실패 상관없이 다음 호출에서 재시도 가능하게
        cachePromise = null;
    }
}

// ✅ items만 바로 받는 helper (AnalyzePage에서 이거 쓰면 실수 줄어듦)
export async function loadSimIndexItemsOnce(url?: string, timeoutMs = 9000): Promise<SimIndexItem[]> {
    const file = await loadSimIndexOnce(url, timeoutMs);
    return Array.isArray(file?.items) ? file.items : [];
}

export function resetSimIndexCache() {
    cacheValue = null;
    cachePromise = null;
}
