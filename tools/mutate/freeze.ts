import crypto from "node:crypto";

export type FreezeKind = "url" | "phone" | "num" | "code" | "keyword";

export type FreezeSpan = {
    kind: FreezeKind;
    idx: number;
    placeholder: string;
    raw: string;
    raw_sha256_utf8: string;
};

export type FreezeResult = {
    frozen: string;
    spans: FreezeSpan[];
    restore: (text: string) => { restored: string; restored_ok: boolean; mismatch_placeholders: string[] };
};

function sha256utf8(s: string) {
    return crypto.createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");
}

// URL 끝의 문장부호는 보호 대상에서 제외(데이터셋에서 이미 많이 해결했지만 안전장치)
const RE_URL = /(https?:\/\/[^\s<>"'()]+?)([)\].,!?:;]+)?(?=\s|$)/gi;
const RE_PHONE = /\b01[016789][- ]?\d{3,4}[- ]?\d{4}\b/g;
const RE_CODE = /\b[A-Z0-9]{6,}\b/g;      // OTP/인증코드류
const RE_NUM = /\b\d{4,}\b/g;             // 숫자열(금액/OTP/계좌 일부 등)

function replaceAllWithSpans(
    input: string,
    kind: FreezeKind,
    re: RegExp,
    counter: { [k in FreezeKind]?: number },
    spans: FreezeSpan[],
    normalizeMatch?: (m: RegExpExecArray) => string
) {
    // reset lastIndex for global regex
    re.lastIndex = 0;
    return input.replace(re, (...args: any[]) => {
        const match = args[0] as string;
        const execArr = args as unknown as RegExpExecArray;

        const raw = normalizeMatch ? normalizeMatch(execArr) : match;

        counter[kind] = (counter[kind] ?? 0) + 1;
        const idx = counter[kind]!;
        const placeholder = `<${kind.toUpperCase()}_${idx}>`;

        spans.push({
            kind,
            idx,
            placeholder,
            raw,
            raw_sha256_utf8: sha256utf8(raw),
        });

        // normalizeMatch로 원문 일부만 쓰는 경우, replace 결과도 그 raw만 치환
        return placeholder;
    });
}

export function freezeText(input: string, freezeKeywords: string[] = []): FreezeResult {
    const spans: FreezeSpan[] = [];
    const counter: { [k in FreezeKind]?: number } = {};

    let frozen = input;

    // 1) URL
    frozen = replaceAllWithSpans(
        frozen,
        "url",
        RE_URL,
        counter,
        spans,
        (m) => m[1] // 그룹1만 raw로 저장(뒤 문장부호 제외)
    );

    // 2) 전화
    frozen = replaceAllWithSpans(frozen, "phone", RE_PHONE, counter, spans);

    // 3) 코드(알파넘)
    frozen = replaceAllWithSpans(frozen, "code", RE_CODE, counter, spans);

    // 4) 숫자열
    frozen = replaceAllWithSpans(frozen, "num", RE_NUM, counter, spans);

    // 5) (옵션) 고정 키워드 freeze — 원문 그대로 byte 보존 목적
    //    키워드가 많으면 과보호되니 “앵커 보존형”에서만 쓰는 게 안전
    if (freezeKeywords.length) {
        // 길이 긴 것부터(부분매치 방지)
        const kws = [...freezeKeywords].filter(Boolean).sort((a, b) => b.length - a.length);
        for (const kw of kws) {
            // 정규식 메타문자 escape
            const esc = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = new RegExp(esc, "g");
            frozen = replaceAllWithSpans(frozen, "keyword", re, counter, spans);
        }
    }

    const restore = (text: string) => {
        let restored = text;
        const mismatch_placeholders: string[] = [];

        for (const sp of spans) {
            if (!restored.includes(sp.placeholder)) {
                mismatch_placeholders.push(sp.placeholder);
                continue;
            }
            restored = restored.split(sp.placeholder).join(sp.raw);
        }

        const restored_ok = mismatch_placeholders.length === 0;
        return { restored, restored_ok, mismatch_placeholders };
    };

    return { frozen, spans, restore };
}
