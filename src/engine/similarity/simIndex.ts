import type { SparseVec } from "./patternVec";

export type SimIndexItem = {
    id: string;          // scenario id (e.g. KO-0008)
    category?: string;
    expectedRisk?: string;
    vec: SparseVec;
};

export type SimIndexFile = {
    version: number;
    createdAt: string;
    source: string;
    lang?: string; // ✅ 추가 (e.g. "ko")
    items: SimIndexItem[];
};
