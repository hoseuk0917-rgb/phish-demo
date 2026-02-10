// src/engine/semantic/semIndex.ts
export type DenseVec = number[];

export type SemIndexItem = {
    id: string; // scenario id
    category?: string;
    expectedRisk?: string;
    vec: DenseVec; // unit-normalized dense embedding
    textHint?: string; // optional UI hint (short)
};

export type SemIndexFile = {
    version: number;
    createdAt: string;
    source: string;
    lang?: string;
    model: string;
    dim: number;
    items: SemIndexItem[];
};
