import { pipeline, env } from "@xenova/transformers";

export type Embedder = {
    model: string;
    embed: (text: string) => Promise<Float32Array>;
};

function dot(a: Float32Array, b: Float32Array) {
    const n = Math.min(a.length, b.length);
    let s = 0;
    for (let i = 0; i < n; i++) s += a[i] * b[i];
    return s;
}

export function cosineSimNormalized(a: Float32Array, b: Float32Array) {
    // normalize:true면 사실상 dot이 cosine
    return dot(a, b);
}

export async function createEmbedder(model: string, cacheDir?: string): Promise<Embedder> {
    if (cacheDir) env.cacheDir = cacheDir;

    // pooling/normalize 옵션을 사용해 “문장 벡터”로 만든다
    const extractor = await pipeline("feature-extraction", model);

    const embed = async (text: string) => {
        // transformers.js는 pooling/normalize 지원
        const out: any = await extractor(text, { pooling: "mean", normalize: true });
        // out.data가 Float32Array로 옴
        const data = out?.data;
        if (!data || !(data instanceof Float32Array)) {
            throw new Error("feature-extraction output.data is not Float32Array");
        }
        return data;
    };

    return { model, embed };
}
