export function normalizeForLexical(s: string) {
    return s
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

function trigrams(s: string) {
    const t: string[] = [];
    const x = normalizeForLexical(s);
    if (x.length < 3) return t;
    for (let i = 0; i < x.length - 2; i++) t.push(x.slice(i, i + 3));
    return t;
}

// distance = 1 - jaccard(trigram sets)
export function jaccard3gramDistance(a: string, b: string) {
    const A = new Set(trigrams(a));
    const B = new Set(trigrams(b));
    if (A.size === 0 && B.size === 0) return 0;

    let inter = 0;
    for (const x of A) if (B.has(x)) inter++;

    const union = A.size + B.size - inter;
    const jacc = union === 0 ? 1 : inter / union;
    return 1 - jacc;
}
