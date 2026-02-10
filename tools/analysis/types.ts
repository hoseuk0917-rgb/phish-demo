// tools/analysis/types.ts
export type NormalizedAttachment = {
    name: string;
    saved_as?: string;
    url?: string;
};

export type AttachmentTextInfo = {
    name: string;
    saved_as: string;
    text_path?: string; // corpus/derived/.../*.txt (posix rel)
    chars?: number;
    note?: string;
};

export type NormalizedDoc = {
    source: string;
    pstSn: string;
    url?: string;
    title?: string;
    date?: string; // YYYY-MM-DD best-effort
    body_text: string;
    attachments: NormalizedAttachment[];
    attachment_texts?: AttachmentTextInfo[]; // ✅ 추가
    fetched_at?: string;
    raw_paths: Record<string, string>;
};

export type Signal = {
    key: string;        // e.g., action:otp
    label: string;      // human label
    category: string;   // channel/action/impersonation/platform/etc
    count: number;
    examples: string[];
};

export type Cluster = {
    signature: string;
    docs: Array<{ source: string; pstSn: string; title?: string; date?: string; url?: string }>;
    topSignals: Signal[];
};
