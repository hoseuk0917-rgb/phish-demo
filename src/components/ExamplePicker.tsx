import React, { useEffect, useMemo, useRef, useState } from "react";

export type ExampleMeta = {
    datasetTag?: string;
    datasetUrl?: string;

    fromNumber?: string;
    isSavedContact?: boolean; // true=연락처(known) / false=신규(unknown)
    callChecks?: { otpAsked?: boolean; remoteAsked?: boolean; urgentPressured?: boolean };
    demoSpeedMs?: number;
};

export type ExampleItem = { id: string; label: string; text: string; meta?: ExampleMeta };

type Props = {
    examples: ExampleItem[];
    onPick: (item: ExampleItem) => void;
};

const DATASET_SOURCES = [
    { url: "/datasets/ko_scam/demo54.jsonl", tag: "demo54" },
    { url: "/datasets/ko_scam/v3_200.jsonl", tag: "v3_200" },
    { url: "/datasets/ko_scam/url_mut200.jsonl", tag: "url_mut200" },
    { url: "/datasets/ko_scam/gen500.jsonl", tag: "gen500" },
    { url: "/datasets/ko_scam/mlm1453.jsonl", tag: "mlm1453" },
] as const;

const DATASET_META: Record<
    string,
    { label: string; badge: "BASIC" | "CORE" | "MLM"; desc: string }
> = {
    demo54: {
        label: "DEMO 54 (catalog)",
        badge: "CORE",
        desc: "v3 임베딩 기반 카탈로그(테마×라벨 균형) + 1케이스 엔진 검증 통과",
    },
    v3_200: {
        label: "V3 200 (baseline)",
        badge: "CORE",
        desc: "기준셋(v3) — High 80 / Medium 80 / Low 40",
    },
    url_mut200: {
        label: "URL MUT 200",
        badge: "CORE",
        desc: "URL 표기 변형 전용(난독화/표기변형) — 링크/검증 UX 확인용",
    },
    gen500: {
        label: "GEN 500",
        badge: "BASIC",
        desc: "생성 코어 커버리지(소재/패턴 다양) — 랜덤 데모 폭 확장용",
    },
    mlm1453: {
        label: "MLM 1335 (passOnly)",
        badge: "MLM",
        desc: "MLM 변형 강건성(오타/띄어쓰기/치환 노이즈)",
    },
};

function normalizeFromInside(inside: string): string {
    const s = String(inside || "").trim();

    // special
    if (/발신번호표시제한/.test(s)) return "발신번호표시제한";

    // try 3-part number anywhere inside (handles: "070-0000-201 (수사관)")
    const m3 = s.match(/(\d{2,4})\s*-\s*(\d{3,4})\s*-\s*(\d{3,4})/);
    if (m3) return `${m3[1]}-${m3[2]}-${m3[3]}`;

    // try 2-part number (1588-0000, 1577-0000)
    const m2 = s.match(/(\d{4})\s*-\s*(\d{4})/);
    if (m2) return `${m2[1]}-${m2[2]}`;

    // fallback: normalize spacing around hyphens (still better than raw)
    return s.replace(/\s+/g, " ").replace(/\s*-\s*/g, "-").trim();
}

function extractFromNumber(text: string): string {
    const s = String(text || "");
    // [발신 010-...] 뿐 아니라 [ 발신 010 - ... ] 형태도 허용
    const m = s.match(/\[\s*발신\s*([^\]]+?)\s*\]/);
    if (!m || !m[1]) return "";
    return normalizeFromInside(m[1]);
}

function stripFirstSenderHeader(threadText: string): string {
    const raw = String(threadText || "").replace(/\r\n/g, "\n").trim();
    if (!raw) return raw;

    const lines = raw.split("\n");
    let stripped = false;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // 첫 S: 라인에서만 [발신 ...] 제거
        if (!stripped && /^\s*S:\s*/.test(line) && /\[\s*발신/.test(line)) {
            lines[i] = line.replace(/(\bS:\s*)\[\s*발신[^\]]*\]\s*/g, "$1").trimEnd();
            stripped = true;
            continue;
        }

        // 혹시 S: 없는 포맷이면 첫 줄에서만 제거
        if (!stripped && i === 0 && /\[\s*발신/.test(line)) {
            lines[i] = line.replace(/^\s*\[\s*발신[^\]]*\]\s*/g, "").trimEnd();
            stripped = true;
        }
    }

    return lines.join("\n").trim();
}

function toExampleItem(obj: any): ExampleItem | null {
    if (!obj || typeof obj !== "object") return null;

    const baseId = String(obj.id ?? "").trim();
    const rawText = String(obj.thread ?? obj.text ?? obj.body ?? "").replace(/\r\n/g, "\n").trim();
    if (!baseId || !rawText) return null;

    const datasetTag = String(obj.__dsTag ?? "").trim();
    const datasetUrl = String(obj.__dsUrl ?? "").trim();

    // ✅ 세트 간 동일 id 충돌 방지: 내부 key는 tag:id 로 네임스페이스
    const id = datasetTag ? `${datasetTag}:${baseId}` : baseId;

    const category = String(obj.category ?? "").trim();
    const risk = String(obj.label ?? "").trim() || String(obj?.expected?.riskLevel ?? "").trim();
    const stage = String(obj?.expected?.stagePeak ?? obj?.expected?.stage_peak ?? "").trim();

    // label은 사람이 보는 값이니 baseId 유지(중복 tag 표기 방지)
    const labelParts = [datasetTag, baseId, category, risk, stage].filter(Boolean);
    const label = labelParts.length ? labelParts.join(" · ") : baseId;

    const meta: ExampleMeta = {};
    if (datasetTag) meta.datasetTag = datasetTag;
    if (datasetUrl) meta.datasetUrl = datasetUrl;

    // header에 쓸 번호는 rawText에서 뽑고
    const fromNumber = extractFromNumber(rawText);
    if (fromNumber) meta.fromNumber = fromNumber;

    // 버블(첫 S 메시지)에서는 [발신 ...] 표기를 제거
    const text = stripFirstSenderHeader(rawText);

    const isSaved = obj?.meta?.isSavedContact;
    if (typeof isSaved === "boolean") meta.isSavedContact = isSaved;

    const cc = obj?.callChecks ?? obj?.meta?.callChecks;
    if (cc && typeof cc === "object") {
        meta.callChecks = {
            otpAsked: !!cc.otpAsked,
            remoteAsked: !!cc.remoteAsked,
            urgentPressured: !!cc.urgentPressured,
        };
    }

    const demoSpeedMs = obj?.meta?.demoSpeedMs;
    if (typeof demoSpeedMs === "number" && Number.isFinite(demoSpeedMs)) meta.demoSpeedMs = demoSpeedMs;

    return { id, label, text, meta: Object.keys(meta).length ? meta : undefined };
}

async function loadJsonl(url: string, signal?: AbortSignal): Promise<any[]> {
    const res = await fetch(url, { cache: "no-store", signal });
    if (!res.ok) throw new Error(`fetch failed: ${url} (${res.status})`);
    const txt = await res.text();
    const out: any[] = [];

    for (const line of txt.split(/\r?\n/g)) {
        const s = line.trim();
        if (!s) continue;
        try {
            out.push(JSON.parse(s));
        } catch {
            // ignore broken line
        }
    }
    return out;
}

function shuffleWithSeed<T>(items: T[], seedU32: number): T[] {
    const arr = Array.isArray(items) ? [...items] : [];
    if (arr.length <= 1) return arr;

    let x = (seedU32 >>> 0) || 1;
    const nextU01 = () => {
        // xorshift32
        x ^= (x << 13) >>> 0;
        x ^= (x >>> 17) >>> 0;
        x ^= (x << 5) >>> 0;
        return (x >>> 0) / 4294967296;
    };

    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(nextU01() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

function Badge({ text }: { text: string }) {
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                height: 18,
                padding: "0 8px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: 800,
                letterSpacing: 0.2,
                border: "1px solid rgba(0,0,0,0.10)",
                background: "rgba(255,255,255,0.75)",
                opacity: 0.9,
            }}
        >
            {text}
        </span>
    );
}

export function ExamplePicker({ examples, onPick }: Props) {
    const [open, setOpen] = useState(false);
    const [selected, setSelected] = useState("");
    const [shuffleSeed, setShuffleSeed] = useState<number>(() => (Date.now() ^ 0x9e3779b9) >>> 0);
    const rootRef = useRef<HTMLDivElement | null>(null);

    // ✅ public/datasets/ko_scam 의 여러 jsonl을 로드해서 “pool”을 구성
    const [remoteExamples, setRemoteExamples] = useState<ExampleItem[]>([]);
    const [remoteErr, setRemoteErr] = useState<string>("");

    useEffect(() => {
        const ac = new AbortController();

        (async () => {
            try {
                setRemoteErr("");
                const parts = await Promise.all(
                    DATASET_SOURCES.map(async (src) => {
                        const arr = await loadJsonl(src.url, ac.signal);
                        for (const obj of arr) {
                            if (obj && typeof obj === "object") {
                                (obj as any).__dsTag = src.tag;
                                (obj as any).__dsUrl = src.url;
                            }
                        }
                        return arr;
                    })
                );

                // id 중복 제거(앞 파일 우선)
                const seen = new Set<string>();
                const merged: ExampleItem[] = [];
                for (const arr of parts) {
                    for (const obj of arr) {
                        const ex = toExampleItem(obj);
                        if (!ex) continue;
                        if (seen.has(ex.id)) continue;
                        seen.add(ex.id);
                        merged.push(ex);
                    }
                }

                if (!ac.signal.aborted) setRemoteExamples(merged);
            } catch (e: any) {
                if (!ac.signal.aborted) {
                    setRemoteErr(String(e?.message || e || "dataset load error"));
                    setRemoteExamples([]);
                }
            }
        })();

        return () => ac.abort();
    }, []);

    const pool = useMemo(() => {
        // remote가 뜨면 무조건 remote만 사용
        return remoteExamples.length ? remoteExamples : Array.isArray(examples) ? examples : [];
    }, [remoteExamples, examples]);

    const byTag = useMemo(() => {
        const m: Record<string, ExampleItem[]> = {};
        for (const ex of pool) {
            const t = ex.meta?.datasetTag || "unknown";
            (m[t] ??= []).push(ex);
        }
        return m;
    }, [pool]);

    const selectedLabel = useMemo(() => {
        return pool.find((x) => x.id === selected)?.label || "";
    }, [pool, selected]);

    // click outside 닫기
    useEffect(() => {
        const onDown = (ev: MouseEvent) => {
            const el = rootRef.current;
            if (!el) return;
            if (!open) return;
            if (el.contains(ev.target as any)) return;
            setOpen(false);
        };
        window.addEventListener("mousedown", onDown);
        return () => window.removeEventListener("mousedown", onDown);
    }, [open]);

    useEffect(() => {
        if (!open) return;
        setShuffleSeed(((Date.now() ^ 0x85ebca6b) >>> 0) || 1);
    }, [open]);

    const shuffled = useMemo(() => {
        return shuffleWithSeed(pool, shuffleSeed);
    }, [pool, shuffleSeed]);

    const pick = (id: string) => {
        setSelected(id);
        setOpen(false);
        const ex = pool.find((x) => x.id === id);
        if (ex) onPick(ex);
    };

    const pickRandom = () => {
        if (!Array.isArray(pool) || pool.length === 0) return;

        const seed = ((Date.now() ^ 0xc2b2ae35) >>> 0) || 1;
        setShuffleSeed(seed);

        const shuffledLocal = shuffleWithSeed(pool, seed);
        const idx = Math.max(0, Math.min(shuffledLocal.length - 1, Math.floor((seed / 4294967296) * shuffledLocal.length)));
        const ex = shuffledLocal[idx] || shuffledLocal[0];
        if (ex) {
            setSelected(ex.id);
            setOpen(false);
            onPick(ex);
        }
    };

    const pickRandomFromTag = (tag: string) => {
        const arr = byTag[tag] || [];
        if (!arr.length) return;

        const idx = Math.floor(Math.random() * arr.length);
        const ex = arr[idx] || arr[0];
        if (!ex) return;

        setSelected(ex.id);
        setOpen(false);
        onPick(ex);
    };

    return (
        <div ref={rootRef} style={{ position: "relative", display: "flex", flexDirection: "column", gap: 8 }}>
            {/* TOP ROW */}
            <div className="row" style={{ gap: 8 }}>
                <button
                    type="button"
                    className="btn"
                    onClick={() => setOpen((v) => !v)}
                    aria-haspopup="listbox"
                    aria-expanded={open}
                    style={{
                        minWidth: 260,
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                    }}
                >
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {selectedLabel || "Examples"}
                    </span>
                    <span aria-hidden style={{ opacity: 0.8 }}>
                        ▾
                    </span>
                </button>

                <button type="button" className="btn" onClick={() => pickRandom()}>
                    Random (ALL)
                </button>

                <button
                    type="button"
                    className="btn"
                    onClick={() => {
                        setSelected("");
                        setOpen(false);
                    }}
                >
                    Reset
                </button>
            </div>

            {/* DATASET RANDOM BUTTONS */}
            <div
                style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    padding: 10,
                    borderRadius: 12,
                    border: "1px solid rgba(0,0,0,0.10)",
                    background: "rgba(255,255,255,0.06)",
                }}
            >
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                    <Badge text="BASIC" />
                    <span style={{ fontSize: 12, opacity: 0.85 }}>LLM 원문</span>
                    <span style={{ opacity: 0.35 }}>·</span>
                    <Badge text="CORE" />
                    <span style={{ fontSize: 12, opacity: 0.85 }}>규칙 생성</span>
                    <span style={{ opacity: 0.35 }}>·</span>
                    <Badge text="MLM" />
                    <span style={{ fontSize: 12, opacity: 0.85 }}>단어 치환 변이</span>
                </div>

                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                    {DATASET_SOURCES.map((s) => {
                        const meta = DATASET_META[s.tag] ?? { label: s.tag, badge: "CORE" as const, desc: "" };
                        const n = (byTag[s.tag]?.length ?? 0);
                        return (
                            <button
                                key={s.tag}
                                type="button"
                                className="btn"
                                disabled={n === 0}
                                onClick={() => pickRandomFromTag(s.tag)}
                                title={meta.desc || meta.label}
                                style={{
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    maxWidth: 320,
                                }}
                            >
                                <Badge text={meta.badge} />
                                <span style={{ fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                    {meta.label}
                                </span>
                                <span style={{ fontSize: 12, opacity: 0.75 }}>{n}</span>
                            </button>
                        );
                    })}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {DATASET_SOURCES.map((s) => {
                        const meta = DATASET_META[s.tag];
                        if (!meta?.desc) return null;
                        return (
                            <div key={`desc:${s.tag}`} style={{ fontSize: 12, opacity: 0.75 }}>
                                <span style={{ fontWeight: 800 }}>{meta.label}</span>
                                <span style={{ opacity: 0.6 }}> — </span>
                                <span>{meta.desc}</span>
                            </div>
                        );
                    })}
                </div>
            </div>

            {/* DROPDOWN */}
            {open ? (
                <div
                    role="listbox"
                    style={{
                        position: "absolute",
                        top: 42,
                        left: 0,
                        zIndex: 50,
                        minWidth: 420,
                        maxWidth: 560,
                        maxHeight: 420,
                        overflow: "auto",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        padding: 10,
                        borderRadius: 12,
                        border: "1px solid rgba(0,0,0,0.10)",
                        background: "#fff",
                        color: "#000",
                        boxShadow: "0 18px 40px rgba(0,0,0,0.14)",
                        backdropFilter: "blur(10px)",
                        WebkitBackdropFilter: "blur(10px)",
                        opacity: 1,
                    }}
                >
                    {remoteErr ? (
                        <div className="muted" style={{ fontSize: 12 }}>
                            dataset load error: {remoteErr}
                        </div>
                    ) : null}

                    {Array.isArray(shuffled) && shuffled.length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                            {shuffled.map((x) => (
                                <button
                                    key={x.id}
                                    type="button"
                                    className="btn"
                                    style={{
                                        display: "block",
                                        width: "100%",
                                        textAlign: "left",
                                        whiteSpace: "nowrap",
                                        overflow: "hidden",
                                        textOverflow: "ellipsis",
                                        background: "#fff",
                                        color: "#000",
                                    }}
                                    onClick={() => pick(x.id)}
                                >
                                    {x.label}
                                </button>
                            ))}
                        </div>
                    ) : (
                        <div className="muted" style={{ fontSize: 12 }}>
                            no examples
                        </div>
                    )}
                </div>
            ) : null}
        </div>
    );
}
