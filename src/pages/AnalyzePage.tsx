import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AnalysisInput, AnalysisResult, StageId } from "../types/analysis";
import { analyzeThread } from "../engine";
import { splitThreadWithRanges } from "../engine/extract/splitThread";
import { prefilterThread } from "../engine/prefilter/prefilter";
import { TextArea } from "../components/TextArea";
import { ToggleRow } from "../components/ToggleRow";
import { ExamplePicker } from "../components/ExamplePicker";
import { ActionButtons } from "../components/ActionButtons";
import { EXAMPLES } from "../data/examples";
import { copyText } from "../utils/clipboard";

import type { SimIndexItem } from "../engine/similarity/simIndex";
import { loadSimIndexOnce } from "../engine/similarity/clientSimIndex";

import type { SemIndexItem } from "../engine/semantic/semIndex";
import { loadSemIndexItemsOnce } from "../engine/semantic/clientSemIndex";

type Props = {
    initial: AnalysisInput;
    onAnalyze: (input: AnalysisInput, result: AnalysisResult) => void;
};

function scoreCls(score: number): "good" | "warn" | "bad" {
    if (score >= 65) return "bad";
    if (score >= 35) return "warn";
    return "good";
}

function stageBadge(stage: StageId): { cls: "good" | "warn" | "bad"; label: string } {
    if (stage === "payment") return { cls: "bad", label: "PAYMENT" };
    if (stage === "install") return { cls: "warn", label: "INSTALL" };
    if (stage === "verify") return { cls: "warn", label: "VERIFY" };
    return { cls: "good", label: "INFO" };
}

function jumpByRange(textarea: HTMLTextAreaElement, start: number, end: number) {
    const hay = (textarea.value || "").replace(/\r\n/g, "\n");
    const s = Math.max(0, Math.min(start, hay.length));
    const e = Math.max(s, Math.min(end, hay.length));

    textarea.focus();
    textarea.setSelectionRange(s, e);

    const before = hay.slice(0, s);
    const line = before.split("\n").length - 1;
    const lh = parseFloat(getComputedStyle(textarea).lineHeight || "20") || 20;
    const target = Math.max(0, line * lh - textarea.clientHeight / 3);
    textarea.scrollTop = target;
}

// 턴 프리픽스/자동부착은 입력 텍스트를 변경하지 않고,
// splitThreadWithRanges / analyzeThread 옵션으로만 반영한다.

function getPrefilterScore(pf: any): number {
    const n =
        pf?.score ??
        pf?.prefilter?.score ??
        pf?.scoreTotal ??
        pf?.total ??
        pf?.riskScore ??
        pf?.prefilterScore ??
        0;
    const x = Number(n);
    return Number.isFinite(x) ? x : 0;
}

function pickPrefilterReasons(pf: any): string[] {
    const p = pf?.prefilter ? pf.prefilter : pf;

    const sigs = Array.isArray(p?.signals) ? p.signals : [];
    const combos = Array.isArray(p?.combos) ? p.combos : [];

    const all = [...sigs, ...combos]
        .filter(Boolean)
        .sort((a: any, b: any) => (Number(b?.points || 0) - Number(a?.points || 0)));

    const out: string[] = [];

    const clamp = (v: any, n: number) => {
        const s = String(v ?? "").trim();
        if (!s) return "";
        return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
    };

    for (const it of all) {
        if (!it) continue;

        const label = it.label ?? it.id ?? it.reason ?? it.ruleId;
        if (!label) continue;

        const pts = Number(it.points || 0);

        const rawMatches = Array.isArray(it.matches) ? it.matches : [];
        const ms = rawMatches
            .filter(Boolean)
            .map((x: any) => clamp(x, 72))
            .filter(Boolean)
            .slice(0, 2);

        const extra = ms.length ? ` · ${ms.join(" | ")}` : "";
        const line = pts ? `${String(label)}(+${pts})${extra}` : `${String(label)}${extra}`;

        if (!out.includes(line)) out.push(line);
        if (out.length >= 6) break;
    }

    return out.slice(0, 6);
}

export function AnalyzePage({ initial, onAnalyze }: Props) {
    const taRef = useRef<HTMLTextAreaElement | null>(null);

    const KNOWN_NUMBERS_KEY = "phish_demo_known_numbers_v1";
    const normalizePhone = (s: string) => (s || "").trim().replace(/[^\d]/g, "").slice(0, 32);

    const loadKnownNumbers = (): string[] => {
        try {
            if (typeof window === "undefined") return [];
            const raw = window.localStorage.getItem(KNOWN_NUMBERS_KEY) || "[]";
            const arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : [];
        } catch {
            return [];
        }
    };

    const [threadText, setThreadText] = useState(initial.threadText || "");
    const [displayText, setDisplayText] = useState(initial.threadText || "");

    // Phone UI는 페이지 기본 레이아웃으로 항상 켜두고(필요하면 버튼으로만 토글)
    const [phoneUxEnabled, setPhoneUxEnabled] = useState(true);

    type PhoneTurn = { who: "S" | "R"; text: string };

    const extractInlineUrls = (s: string): string[] => {
        const t = String(s || "");
        const re = /\bhttps?:\/\/[^\s<>"')]+/gi;
        const m = t.match(re) || [];
        const out: string[] = [];

        for (const u of m) {
            const x = String(u || "").trim();
            if (!x) continue;
            if (!out.includes(x)) out.push(x);
            if (out.length >= 12) break;
        }
        return out;
    };

    const isInstallUrl = (u: string) => /(\.apk|\.ipa|\.exe|\.msi|\.pkg|\/download\b|install\b)/i.test(String(u || ""));

    // ✅ URL 변형(우회) 패턴 감지 → 짧은 MUT 칩으로 표기
    const detectUrlMutChips = (text0: string, urls0?: string[]) => {
        const text = String(text0 || "");
        const urls = Array.isArray(urls0) ? urls0 : [];
        const hay = [text, ...urls.map((u) => String(u || ""))].join("\n");

        const chips: string[] = [];

        if (/(^|[^a-z])hxxps?:\/\//i.test(hay)) chips.push("MUT:hxxp");
        if (/\[\s*\.\s*\]/.test(hay)) chips.push("MUT:[.]");
        if (/\(\s*dot\s*\)/i.test(hay)) chips.push("MUT:(dot)");
        if (/\bxn--[a-z0-9-]+\b/i.test(hay)) chips.push("MUT:xn--");
        if (/(?:https?|hxxps?):\/\/[^\s/]+@/i.test(hay)) chips.push("MUT:@");
        if (/\b(?:redirect|redir|url|target|dest|destination)=https?/i.test(hay)) chips.push("MUT:redirect");
        if (/(?:https?|hxxps?):\/\/(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?(?:[\/?#]|$)/i.test(hay)) chips.push("MUT:ip");
        if (/\b(?:bit\.ly|t\.co|tinyurl\.com|me2\.do|vo\.la|is\.gd)\b/i.test(hay)) chips.push("MUT:short");

        const out: string[] = [];
        for (const c of chips) {
            const s = String(c || "").trim();
            if (!s) continue;
            if (!out.includes(s)) out.push(s);
            if (out.length >= 2) break;
        }
        return out;
    };

    const parsePhoneTurns = (t: string): PhoneTurn[] => {
        const raw = String(t || "").replace(/\r\n/g, "\n");
        const lines = raw.split("\n");

        const out: PhoneTurn[] = [];
        let cur: PhoneTurn | null = null;

        const pushCur = () => {
            if (!cur) return;
            const text = String(cur.text || "").trim();
            if (!text) {
                cur = null;
                return;
            }
            out.push({ who: cur.who, text });
            cur = null;
        };

        for (const lineRaw of lines) {
            const line = String(lineRaw || "").trimEnd();
            if (!line.trim()) continue;

            const m = /^\s*([sSrR])\s*:\s*(.*)$/.exec(line);
            if (m) {
                pushCur();
                const who = String(m[1] || "S").toUpperCase() as "S" | "R";
                const body = String(m[2] || "");
                cur = { who, text: body };
                continue;
            }

            if (!cur) cur = { who: "S", text: line.trim() };
            else cur.text += `\n${line.trim()}`;
        }

        pushCur();
        return out.slice(0, 300);
    };

    const turnsToText = (turns: PhoneTurn[], n: number) =>
        turns
            .slice(0, Math.max(0, Math.min(n, turns.length)))
            .map((x) => `${x.who}: ${x.text}`)
            .join("\n");

    const [demoRunning, setDemoRunning] = useState(false);
    const [demoTurns, setDemoTurns] = useState<PhoneTurn[]>([]);
    const [demoFullText, setDemoFullText] = useState("");
    const [demoIndex, setDemoIndex] = useState(0);
    const [demoSpeedMs, setDemoSpeedMs] = useState(900);

    const startDemo = (t: string) => {
        const full = String(t || "").replace(/\r\n/g, "\n");
        const turns0 = parsePhoneTurns(full);

        // parse 실패(=turns가 비어있음)하면, 라인 단위로라도 폰 화면/분석에 들어가게 폴백
        const fallbackTurns: PhoneTurn[] = full
            .split("\n")
            .map((s) => String(s || "").trimEnd())
            .filter((s) => s.trim().length > 0)
            .map((text) => ({ who: "S", text }));

        const turns = turns0.length ? turns0 : fallbackTurns;

        setDemoFullText(full);
        setDemoTurns(turns);
        setDemoIndex(0);

        // ✅ Restart 시 이전 결과/점수 잔상 제거
        setPreview(null);
        setAnalysisBusy(false);

        // 실제로 “한 턴씩 흘러가는” 데모가 가능할 때만 displayText를 비우고 애니메이션
        if (turns0.length) {
            setDemoRunning(true);
            setDisplayText("");
        } else {
            setDemoRunning(false);
            setDisplayText(full);
        }

        setSelectedBlock(null);
        setExplicitActions({});
        setHoverUrl("");
    };

    const stopDemo = () => {
        setDemoRunning(false);
        setDemoTurns([]);
        setDemoIndex(0);
        setDisplayText(String(threadText || "").replace(/\r\n/g, "\n"));
    };

    useEffect(() => {
        if (!demoRunning) return;

        if (!demoTurns.length) {
            setDemoRunning(false);
            return;
        }

        if (demoIndex >= demoTurns.length) {
            setDemoRunning(false);
            setDisplayText(turnsToText(demoTurns, demoTurns.length));
            return;
        }

        const t = window.setTimeout(() => {
            const next = Math.min(demoTurns.length, demoIndex + 1);
            setDemoIndex(next);
            setDisplayText(turnsToText(demoTurns, next));
        }, Math.max(120, Math.floor(demoSpeedMs || 650)));

        return () => window.clearTimeout(t);
    }, [demoRunning, demoTurns, demoIndex, demoSpeedMs]);

    useEffect(() => {
        // LIVE(=demoTurns 비어있음)일 때만 threadText를 displayText로 동기화
        if (demoRunning) return;
        if (demoTurns.length) return; // paused demo면 현재 displayText 유지
        setDisplayText(String(threadText || "").replace(/\r\n/g, "\n"));
    }, [threadText, demoRunning, demoTurns.length]);

    const [otpAsked, setOtpAsked] = useState(!!initial.callChecks?.otpAsked);
    const [remoteAsked, setRemoteAsked] = useState(!!initial.callChecks?.remoteAsked);
    const [urgentPressured, setUrgentPressured] = useState(!!initial.callChecks?.urgentPressured);

    const [fromNumber, setFromNumber] = useState("");
    const [knownNumbers, setKnownNumbers] = useState<string[]>(() => loadKnownNumbers());

    useEffect(() => {
        if (knownNumbers.length) return;
        setKnownNumbers(["01012345678", "01098765432"]);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        try {
            if (typeof window === "undefined") return;
            window.localStorage.setItem(KNOWN_NUMBERS_KEY, JSON.stringify(knownNumbers));
        } catch {
            // ignore
        }
    }, [knownNumbers]);

    const normalizedNumber = useMemo(() => normalizePhone(fromNumber), [fromNumber]);
    const firstContact = useMemo(() => {
        if (!normalizedNumber || normalizedNumber.length < 6) return false;
        return !knownNumbers.includes(normalizedNumber);
    }, [normalizedNumber, knownNumbers]);

    const markKnown = () => {
        if (!normalizedNumber || normalizedNumber.length < 6) return;
        setKnownNumbers((prev) => (prev.includes(normalizedNumber) ? prev : [normalizedNumber, ...prev].slice(0, 200)));
    };

    const forgetKnown = () => {
        if (!normalizedNumber || normalizedNumber.length < 6) return;
        setKnownNumbers((prev) => prev.filter((x) => x !== normalizedNumber));
    };

    const [previewEnabled, setPreviewEnabled] = useState(true);
    const [preview, setPreview] = useState<AnalysisResult | null>(null);
    const [phoneAlertDismissSig, setPhoneAlertDismissSig] = useState<string>("");

    const [analysisBusy, setAnalysisBusy] = useState(false);

    const [selectedBlock, setSelectedBlock] = useState<number | null>(null);

    // ✅ 턴 분리 프리픽스 사용 여부 (입력 원문은 그대로 유지)
    const [turnPrefixMode, setTurnPrefixMode] = useState(true);
    const [autoPrefixMode, setAutoPrefixMode] = useState(false);

    const splitOpts = useMemo(
        () => ({
            turnPrefixMode,
            autoPrefixMode,
            defaultWho: "S" as const,
        }),
        [turnPrefixMode, autoPrefixMode]
    );

    // ✅ similarity index (client cached)
    const [simIndexItems, setSimIndexItems] = useState<SimIndexItem[]>([]);
    const [simTopK, setSimTopK] = useState(6);
    const [simMinSim, setSimMinSim] = useState(0.12);

    // ✅ semantic index (client cached) — 문장 임베딩 후보용(점수/리스크 반영 X)
    const [semIndexItems, setSemIndexItems] = useState<SemIndexItem[]>([]);
    const [semTopK, setSemTopK] = useState(5);
    const [semMinSim, setSemMinSim] = useState(0.90);

    // (lazy) E5 extractor + last-vec cache (모델은 버튼 분석에서만 로드)
    const semExtractorRef = useRef<Promise<any> | null>(null);
    const semLastRef = useRef<{ key: string; vec: number[] } | null>(null);

    function toDenseVec(emb: any): number[] | null {
        if (!emb) return null;
        if (Array.isArray(emb)) return emb as number[];
        if (emb instanceof Float32Array) return Array.from(emb);
        if (emb?.data instanceof Float32Array) return Array.from(emb.data);
        if (typeof emb?.tolist === "function") {
            const t = emb.tolist();
            if (Array.isArray(t) && Array.isArray(t[0])) return (t[0] as number[]).slice();
            if (Array.isArray(t)) return (t as number[]).slice();
        }
        return null;
    }

    async function getE5Extractor(model = "Xenova/multilingual-e5-small"): Promise<any> {
        if (semExtractorRef.current) return semExtractorRef.current;
        semExtractorRef.current = (async () => {
            const mod: any = await import("@xenova/transformers");
            const pipeline = mod?.pipeline;
            if (typeof pipeline !== "function") throw new Error("semantic: pipeline() not available");
            return await pipeline("feature-extraction", model);
        })();
        return semExtractorRef.current;
    }

    async function buildSemQueryVecFromText(text: string): Promise<number[] | null> {
        const raw = String(text || "").replace(/\r\n/g, "\n").trim();
        if (!raw) return null;

        // 너무 길면 비용/메모리 급증 → 안정적으로 컷
        const clipped = raw.length > 1200 ? raw.slice(0, 1200) : raw;

        // 동일 텍스트면 재계산 X
        const key = `${clipped.length}:${clipped.slice(0, 220)}`;
        if (semLastRef.current?.key === key) return semLastRef.current.vec;

        try {
            const extractor = await getE5Extractor();
            const inp = `query: ${clipped}`;
            const emb: any = await (extractor as any)(inp, { pooling: "mean", normalize: true });
            const vec = toDenseVec(emb);
            if (!vec || vec.length === 0) return null;
            semLastRef.current = { key, vec };
            return vec;
        } catch {
            return null;
        }
    }

    const analyzeOpts = useMemo(
        () => ({
            turnSplit: { ...splitOpts, enabled: true },
            simIndexItems,
            simTopK,
            simMinSim,
            semIndexItems,
            semTopK,
            semMinSim,
        }),
        [splitOpts, simIndexItems, simTopK, simMinSim, semIndexItems, semTopK, semMinSim]
    );

    // ✅ Threat 스코어링용: R 본문은 무해 토큰으로 마스킹(턴/블록 구조는 유지)
    const threatThreadText = useMemo(() => {
        const raw = String(displayText || "").replace(/\r\n/g, "\n");
        if (!raw.trim()) return raw;

        const lines = raw.split("\n");
        let mode: "S" | "R" | "" = "";
        const out: string[] = [];

        for (const line of lines) {
            const m = line.match(/^\s*([SR])\s*:\s*(.*)$/i);
            if (m) {
                const who = String(m[1] || "").toUpperCase() === "R" ? "R" : "S";
                mode = who;

                if (who === "R") out.push("R: (reply)");
                else out.push(line);
                continue;
            }

            if (mode === "R") out.push("(reply)");
            else out.push(line);
        }

        return out.join("\n");
    }, [displayText]);

    const input: any = useMemo(
        () => ({
            threadText: threatThreadText, // ✅ Threat는 R 마스킹 텍스트로만 계산
            rawThreadText: displayText,   // (옵션) 표시/디버그용
            callChecks: { otpAsked, remoteAsked, urgentPressured, firstContact },
        }),
        [threatThreadText, displayText, otpAsked, remoteAsked, urgentPressured, firstContact]
    );

    const canAnalyze = displayText.trim().length > 0;

    const ranges = useMemo(() => splitThreadWithRanges(displayText, splitOpts), [displayText, splitOpts]);

    // ✅ inboundText = "R에게 온 텍스트" (== S 블록만)
    const inboundText = useMemo(() => {
        const blocks = Array.isArray(ranges) ? ranges : [];
        return blocks
            .filter((b: any) => String(b?.speaker || "") === "S")
            .map((b: any) => String(b?.text || "").trim())
            .filter(Boolean)
            .join("\n");
    }, [ranges]);

    // ✅ Threat 스코어링용: R 본문은 무해 토큰으로 마스킹(턴/블록 구조는 유지)
    // (moved) threatThreadText is declared above (before input) to avoid TS used-before-declaration.

    // ✅ R 텍스트(게이트용) = R 블록만
    const rTextForGate = useMemo(() => {
        const blocks = Array.isArray(ranges) ? ranges : [];
        return blocks
            .filter((b: any) => String(b?.speaker || "") === "R")
            .map((b: any) => String(b?.text || "").trim())
            .filter(Boolean)
            .join(" ")
            .trim();
    }, [ranges]);

    // ✅ inbound URL 집합(클릭/카운트는 이 안에 있는 URL만 인정)
    const inboundUrlSet = useMemo(() => {
        const normalizeKey = (u: string) => {
            let s = String(u || "").trim();
            // 끝에 붙는 구두점/괄호/따옴표 제거 (urlfixed랑 동일 계열)
            s = s.replace(/[)\]}>,.;:!?'"”’]+$/g, "");
            s = s.replace(/^[(\[{<"']+/g, "");
            return s.trim();
        };

        const set = new Set<string>();
        const t = String(inboundText || "");
        const re = /\bhttps?:\/\/[^\s"'<>]+/gi;

        for (const m of t.matchAll(re)) {
            const u = normalizeKey(String(m[0] || ""));
            if (u) set.add(u);
        }
        return set;
    }, [inboundText]);

    useEffect(() => {
        setSelectedBlock(null);
    }, [displayText, splitOpts]);

    // ✅ Prefilter gate (threshold 넘을 때만 자동 분석)
    const [triggerGateEnabled, setTriggerGateEnabled] = useState(true);
    const [autoAnalyzeOnTrigger, setAutoAnalyzeOnTrigger] = useState(true);
    const [triggerThreshold, setTriggerThreshold] = useState(18);

    const [prefilter, setPrefilter] = useState<any | null>(null);
    const [prefilterErr, setPrefilterErr] = useState<string | null>(null);

    const [explicitActions, setExplicitActions] = useState<{ copyUrl?: number; openUrl?: number; installClick?: number }>(
        {}
    );

    const [hoverUrl, setHoverUrl] = useState<string>("");

    const bumpExplicit = (k: "copyUrl" | "openUrl" | "installClick", n = 1, url?: string) => {
        // URL 액션은 inbound URL만 카운트(가능하면 hoverUrl을 fallback으로 사용)
        if (k === "copyUrl" || k === "openUrl") {
            const normalizeKey = (u: string) => {
                let s = String(u || "").trim();
                s = s.replace(/[)\]}>,.;:!?'"”’]+$/g, "");
                s = s.replace(/^[(\[{<"']+/g, "");
                return s.trim();
            };

            const cand = normalizeKey(String(url || hoverUrl || ""));
            if (cand && inboundUrlSet && !inboundUrlSet.has(cand)) return;
        }

        setExplicitActions((prev) => ({ ...prev, [k]: Math.max(0, Math.floor((prev as any)?.[k] ?? 0) + n) }));
    };

    const callBoost = useMemo(() => {
        // 체크박스는 “확실한 맥락 신호”라서 프리필터 점수에 더해 trigger 결정을 빠르게
        // (값은 UI 트리거용이므로 가볍게만 사용)
        let b = 0;
        if (otpAsked) b += 12;
        if (remoteAsked) b += 12;
        if (urgentPressured) b += 6;
        if (firstContact) b += 6;
        return b;
    }, [otpAsked, remoteAsked, urgentPressured, firstContact]);

    // [OK] R(수신자) 순응/수행 여부는 Threat 점수에 섞지 않고 "경고 타이밍(트리거 게이트)"에만 반영
    const rGate = useMemo(() => {
        const raw = String(displayText || "").replace(/\r\n/g, "\n");
        if (!raw.trim()) return { tag: "", boost: 0 };

        const rText = raw
            .split("\n")
            .map((l) => {
                const m = l.match(/^\s*R\s*:\s*(.*)$/i);
                return m ? String(m[1] || "").trim() : "";
            })
            .filter(Boolean)
            .join(" ")
            .trim();

        if (!rText) return { tag: "", boost: 0 };

        const hasAlready = /(눌렀|열었|설치했|다운받|입력했|보냈|송금했|이체했|인증했|원격(으로)?\s*해줬|연결했)/i.test(rText);
        const hasAbout = /(눌러(볼게|보려)|열어(볼게|보려)|설치(할게|하려)|다운(받을게|받으려)|입력(할게|하려)|보내(줄게|볼게|려)|송금(할게|하려)|이체(할게|하려)|인증(할게|하려)|원격(으로)?\s*해줄게)/i.test(rText);
        const hasAsk = /(맞나|사기|스캠|피싱|도와(줘|주세요)|확인(해줘|해주세요)|이거\s*뭐야|진짜야)/i.test(rText);
        const hasResist = /(안\s*할게|거절|차단했|신고했|무시했|끊었|삭제했)/i.test(rText);

        if (hasAlready) return { tag: "r:already", boost: 14 };
        if (hasAbout) return { tag: "r:about", boost: 10 };
        if (hasAsk) return { tag: "r:ask", boost: 4 };
        if (hasResist) return { tag: "r:resist", boost: 2 };
        return { tag: "", boost: 0 };
    }, [displayText]);

    const embedGateBoost = useMemo(() => {
        if (!triggerGateEnabled || !autoAnalyzeOnTrigger) return 0;

        const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

        const fnv1a32 = (s: string) => {
            let h = 0x811c9dc5;
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
            return h >>> 0;
        };

        const normForEmbed = (s: string) => {
            const t = String(s || "").toLowerCase();
            const noUrl = t.replace(/\bhttps?:\/\/[^\s<>"')]+/gi, " ");
            const noDigits = noUrl.replace(/\d/g, "0");
            return noDigits.replace(/\s+/g, " ").trim().slice(0, 2200);
        };

        const embed64 = (s: string) => {
            const v = new Array(64).fill(0);
            const t = normForEmbed(s);

            const pad = `  ${t}  `;
            for (let i = 0; i + 3 <= pad.length; i++) {
                const g = pad.slice(i, i + 3);
                const h = fnv1a32(g);
                const idx = h % 64;
                const sign = (h & 1) === 0 ? 1 : -1;
                v[idx] += sign;
            }

            let n = 0;
            for (let i = 0; i < v.length; i++) n += v[i] * v[i];
            n = Math.sqrt(Math.max(1e-9, n));
            for (let i = 0; i < v.length; i++) v[i] /= n;

            return v;
        };

        const cos = (a: number[], b: number[]) => {
            let s = 0;
            for (let i = 0; i < 64; i++) s += (a[i] || 0) * (b[i] || 0);
            return clamp01((s + 1) / 2);
        };

        const protos = [
            "otp one time password verification code auth code 인증번호 보안코드 본인확인",
            "remote control anydesk teamviewer support install app 원격 제어 설치 앱",
            "parcel delivery address tracking link 택배 배송 주소 운송장 링크",
            "payment invoice refund charge card 결제 청구 환불 카드",
            "account locked suspicious login bank 금융기관 보안 계정 잠김 의심 로그인",
            "recruiter job offer interview telegram whatsapp 알바 채용 면접 연락",
        ];

        const text = String(inboundText || "");
        if (!text.trim()) return 0;

        const v = embed64(text);
        let maxSim = 0;
        for (const p of protos) {
            const sim = cos(v, embed64(p));
            if (sim > maxSim) maxSim = sim;
        }

        if (maxSim >= 0.86) return 10;
        if (maxSim >= 0.82) return 7;
        if (maxSim >= 0.78) return 5;
        if (maxSim >= 0.74) return 3;
        return 0;
    }, [triggerGateEnabled, autoAnalyzeOnTrigger, inboundText]);

    const prefilterScore = useMemo(
        () => getPrefilterScore(prefilter) + callBoost + embedGateBoost + (rGate?.boost ?? 0),
        [prefilter, callBoost, embedGateBoost, rGate]
    );

    const prefilterReasons = useMemo(() => {
        const base = pickPrefilterReasons(prefilter);
        const tag = String((rGate as any)?.tag || "").trim();
        return tag ? [tag, ...base] : base;
    }, [prefilter, rGate]);

    const triggerState = useMemo(() => {
        if (!triggerGateEnabled) return { mode: "off" as const, ok: true, why: "gate-off" };
        if (prefilterErr) return { mode: "error" as const, ok: false, why: "prefilter-error" };
        if (!autoAnalyzeOnTrigger) return { mode: "manual" as const, ok: true, why: "manual" };

        // ✅ 새 트리거조건: prefilterThread가 계산한 gatePass를 최우선 반영
        const gp = !!(prefilter as any)?.gatePass;

        // (옵션) 기존 임계값도 fallback으로 유지
        const byScore = Number(prefilterScore || 0) >= Number(triggerThreshold || 0);

        const why = gp ? "gatePass" : byScore ? "score>=threshold" : "below-threshold";
        return { mode: "auto" as const, ok: gp || byScore, why };
    }, [triggerGateEnabled, autoAnalyzeOnTrigger, prefilterScore, triggerThreshold, prefilterErr, prefilter]);

    useEffect(() => {
        if (!canAnalyze) {
            setPrefilter(null);
            setPrefilterErr(null);
            setExplicitActions({});
            return;
        }

        if (!triggerGateEnabled) {
            setPrefilter(null);
            setPrefilterErr(null);
            return;
        }

        // ✅ UI에서 입력 변화마다 prefilter를 즉시 계산해야 gate가 동작한다.
        try {
            setPrefilterErr(null);

            const raw = String(inboundText || "").replace(/\r\n/g, "\n");
            const lines = raw.split("\n");

            const sLines = lines
                .map((l) => {
                    const m = l.match(/^\s*S\s*:\s*(.*)$/i);
                    return m ? String(m[1] || "").trim() : "";
                })
                .filter(Boolean);

            const sOnly = sLines.length > 0 ? sLines.join("\n") : raw;

            const pf = prefilterThread(sOnly, ((analyzeOpts as any)?.prefilter ?? undefined) as any);
            setPrefilter(pf as any);
        } catch (e: any) {
            setPrefilter(null);
            setPrefilterErr(String(e?.message || "prefilter error"));
        }
    }, [canAnalyze, triggerGateEnabled, inboundText, analyzeOpts]);

    useEffect(() => {
        let alive = true;

        (async () => {
            try {
                const file = await loadSimIndexOnce();
                const items: SimIndexItem[] = Array.isArray((file as any)?.items) ? (file as any).items : [];
                if (alive) setSimIndexItems(items);
            } catch {
                if (alive) setSimIndexItems([]);
            }

            try {
                const items: SemIndexItem[] = await loadSemIndexItemsOnce();
                if (alive) setSemIndexItems(Array.isArray(items) ? items : []);
            } catch {
                if (alive) setSemIndexItems([]);
            }
        })();

        return () => {
            alive = false;
        };
    }, []);

    // ✅ (dedup) auto preview effect is handled by the later useEffect block below.

    const blocksTop = useMemo(() => {
        if (!preview) return [];
        return [...preview.messageSummaries].sort((a, b) => b.score - a.score).slice(0, 6);
    }, [preview]);

    const selected = useMemo(() => {
        if (!preview || !selectedBlock) return null;
        return preview.messageSummaries.find((m) => m.index === selectedBlock) || null;
    }, [preview, selectedBlock]);

    const selectedRange = useMemo(() => {
        if (!selectedBlock) return null;
        return ranges[selectedBlock - 1] || null;
    }, [ranges, selectedBlock]);

    const selectedRawText = useMemo(() => {
        if (!selectedRange) return "";
        const hay = String(displayText || "").replace(/\r\n/g, "\n");
        const s = Math.max(0, Math.min(selectedRange.start, hay.length));
        const e = Math.max(s, Math.min(selectedRange.end, hay.length));
        return hay.slice(s, e);
    }, [displayText, selectedRange]);

    const onJumpBlock = (blockIndex: number) => {
        setSelectedBlock(blockIndex);
        const el = taRef.current;
        if (!el) return;

        const r = ranges[blockIndex - 1];
        if (r) {
            jumpByRange(el, r.start, r.end);
            return;
        }
        el.focus();
    };

    const runAnalyze = () => {
        if (!canAnalyze) return;

        setAnalysisBusy(true);

        // ✅ 즉시 실행하면 상태 업데이트가 배치되어 “분석중”이 안 보일 수 있어서 0ms로 한 틱 미룸
        const t = setTimeout(() => {
            (async () => {
                try {
                    let opts: any = analyzeOpts;

                    // ✅ semantic embedding: 버튼 분석에서만(무거움 방지)
                    if (Array.isArray(semIndexItems) && semIndexItems.length > 0) {
                        const v = await buildSemQueryVecFromText(inboundText);
                        if (Array.isArray(v) && v.length > 0) opts = { ...analyzeOpts, semQueryVec: v };
                    }

                    const res = analyzeThread(input, opts);
                    setPreview(res); // manual에서도 deepEnabled 켜지게
                    onAnalyze(input, res);
                } catch {
                    setPreview(null);
                } finally {
                    setAnalysisBusy(false);
                }
            })();
        }, 0);

        return () => clearTimeout(t);
    };

    const copyReportPackage = async () => {
        if (!canAnalyze) return false;
        try {
            const res: any = analyzeThread(input, analyzeOpts);

            let pack = String(res?.packageText || "n/a");

            if (selectedBlock) {
                const arr = Array.isArray(res?.messageSummaries) ? res.messageSummaries : [];
                const m = arr.find((x: any) => x?.index === selectedBlock) || null;

                if (m) {
                    const clamp = (s: string, n: number) => {
                        const t = String(s || "").replace(/\r\n/g, "\n");
                        if (t.length <= n) return t;
                        return t.slice(0, n).trimEnd() + "…";
                    };

                    const urls: string[] = Array.isArray(m.urls) ? m.urls : [];
                    const speaker = String(m.speakerLabel || "").trim();
                    const actor = String(m.actorHint || "").trim();
                    const header = String(m.header || "").trim();
                    const trig: string[] = Array.isArray(m.stageTriggers) ? m.stageTriggers : [];

                    const body = String(selectedRawText || m.content || m.text || "").replace(/\r\n/g, "\n").trim();

                    const lines: string[] = [];
                    lines.push((pack || "").trim());
                    lines.push("");
                    lines.push("----");
                    lines.push("[Selected Block]");
                    lines.push(`BLK ${m.index} · ${m.score}/100 · ${String(m.stage).toUpperCase()}`);
                    lines.push(`Triggers: ${trig.length ? trig.join(" / ") : "n/a"}`);
                    lines.push(`URLs: ${urls.length ? urls.join(" ") : "n/a"}`);

                    lines.push(`Speaker: ${speaker || "n/a"}`);
                    lines.push(`Actor: ${actor ? actor.toUpperCase() : "n/a"}`);
                    lines.push(`Header: ${header || "n/a"}`);

                    if (selectedRange) lines.push(`Range: ${selectedRange.start}-${selectedRange.end}`);

                    lines.push("");
                    lines.push("[Block Text]");
                    lines.push(clamp(body, 900));

                    pack = lines.join("\n").trim() + "\n";
                }
            }

            return await copyText(pack || "n/a");
        } catch {
            return await copyText("n/a");
        }
    };

    const gatePass = useMemo(() => {
        if (!triggerGateEnabled) return true;
        if (prefilterErr) return false;

        // ✅ prefilter.gatePass OR score>=threshold
        const gp = !!(prefilter as any)?.gatePass;
        const byScore = Number(prefilterScore || 0) >= Number(triggerThreshold || 0);
        return gp || byScore;
    }, [
        triggerGateEnabled,
        prefilterErr,
        prefilter,
        prefilterScore,
        triggerThreshold,
    ]);

    // 기존 UI/로직에서 deepTriggered를 계속 쓰고 있으면 gatePass를 그대로 alias로 제공
    const deepTriggered = gatePass;

    useEffect(() => {
        const pushTL = (type: string, msg: string, data?: any) => {
            const g: any = globalThis as any;
            if (!g.__phishTimeline) g.__phishTimeline = { events: [] as any[], lastSig: "" };
            const root = g.__phishTimeline as { events: any[]; lastSig: string };

            const sig = `${type}|${msg}`;
            if (root.lastSig === sig) return;
            root.lastSig = sig;

            const now = new Date();
            root.events.push({
                t: now.toISOString(),
                type,
                msg,
                data: data ?? null,
            });

            if (root.events.length > 240) root.events.splice(0, root.events.length - 240);
        };

        if (!previewEnabled) {
            setAnalysisBusy(false);
            pushTL("preview_off", "preview disabled");
            return;
        }

        if (!canAnalyze) {
            setAnalysisBusy(false);
            pushTL("blocked", "canAnalyze=false");
            // 입력이 순간적으로 비는 경우 preview를 지우면 UI가 급하게 사라짐
            return;
        }

        // Gate ON + manual이면: 자동 미리보기만 중지(기존 preview는 유지)
        if (triggerGateEnabled && !autoAnalyzeOnTrigger) {
            setAnalysisBusy(false);
            pushTL("blocked", "gate ON (manual) · auto preview paused");
            return;
        }

        // Gate ON + auto이면: threshold 만족할 때만 자동 미리보기
        if (triggerGateEnabled && !gatePass) {
            setAnalysisBusy(false);
            pushTL("wait", "waiting for trigger (auto gate)");
            // ✅ 여기서 preview를 비워버리면 화면이 허전해짐 + “분석중”도 헷갈림
            // setPreview(null);
            return;
        }

        // ✅ 지금부터 풀분석 “실행 예정/실행중”
        setAnalysisBusy(true);

        pushTL("schedule", "auto preview scheduled", {
            len: String(input || "").length,
            gate: triggerGateEnabled ? "on" : "off",
        });

        const t = setTimeout(() => {
            try {
                const res: any = analyzeThread(input, analyzeOpts);
                setPreview(res);

                const score = Math.round(Math.max(0, Math.min(100, Number(res?.scoreTotal || 0))));
                const stage = String(res?.stagePeak || res?.stage || "n/a");
                const risk =
                    String(res?.riskLevel || "").toLowerCase() ||
                    (score >= 65 ? "high" : score >= 35 ? "medium" : "low");

                pushTL("run", "auto preview ran", { score, risk, stage });
            } catch (e) {
                pushTL("err", "auto preview failed");
                setPreview(null);
            } finally {
                setAnalysisBusy(false);
            }
        }, 220);

        return () => {
            clearTimeout(t);
            // cleanup에서 analysisBusy를 false로 내리면 입력 변화/재스케줄 때
            // 경고바가 "분석중" ↔ 다른 문구로 깜빡이며 조기 노출이 생김.
            // busy 종료는 timeout의 finally(실행 완료) 또는 early-return 경로에서만 처리.
        };
    }, [
        previewEnabled,
        canAnalyze,
        input,
        analyzeOpts,
        triggerGateEnabled,
        autoAnalyzeOnTrigger,
        gatePass,
    ]);

    const deepEnabled = useMemo(() => {
        if (!triggerGateEnabled) return canAnalyze;
        if (autoAnalyzeOnTrigger) return gatePass;
        return !!preview; // manual Analyze now 누르면 runAnalyze에서 setPreview로 켜짐
    }, [triggerGateEnabled, autoAnalyzeOnTrigger, gatePass, canAnalyze, preview]);

    const gateLocked = useMemo(() => {
        return (
            !!deepEnabled &&
            !!triggerGateEnabled &&
            !!autoAnalyzeOnTrigger &&
            String((triggerState as any)?.mode || "") === "auto" &&
            !(triggerState as any)?.ok &&
            !preview
        );
    }, [deepEnabled, triggerGateEnabled, autoAnalyzeOnTrigger, triggerState, preview]);

    const ctxSignals = useMemo(() => {
        if (!deepEnabled) return { score: 0, hits: [] as { label: string; points: number; count: number }[] };

        const text = String(inboundText || "").toLowerCase();

        const rules: { label: string; points: number; re: RegExp }[] = [
            { label: "OTP/인증번호 요구", points: 10, re: /\b(otp|one[\s-]?time|auth code|verification code|인증번호|본인확인|보안코드)\b/i },
            { label: "원격/앱 설치 유도", points: 10, re: /\b(remote|anydesk|teamviewer|support|원격|제어|앱\s*설치|설치해)\b/i },
            { label: "긴급/압박", points: 6, re: /\b(urgent|immediately|now|asap|긴급|지금\s*바로|즉시|오늘\s*안에)\b/i },
            { label: "계정/결제/환불", points: 8, re: /\b(payment|invoice|refund|charge|결제|환불|청구|카드)\b/i },
            { label: "택배/주소/배송", points: 6, re: /\b(parcel|delivery|address|shipping|택배|배송|주소)\b/i },
            { label: "링크 클릭 유도", points: 8, re: /\b(click|open|link|url|접속|클릭|링크)\b/i },
        ];

        const hits: { label: string; points: number; count: number }[] = [];
        let score = 0;

        for (const r of rules) {
            const m = text.match(r.re);
            const count = m ? m.length : 0;
            if (!count) continue;

            hits.push({ label: r.label, points: r.points, count });
            score += r.points * Math.min(2, count);
        }

        // 컨텍스트 체크박스(확실 신호)
        if (otpAsked) score += 6;
        if (remoteAsked) score += 6;
        if (urgentPressured) score += 3;
        if (firstContact) score += 3;

        score = Math.max(0, Math.min(100, score));
        return { score, hits: hits.slice(0, 8) };
    }, [deepEnabled, inboundText, otpAsked, remoteAsked, urgentPressured, firstContact]);

    const urlGuard = useMemo(() => {
        if (!deepEnabled) {
            return {
                total: 0,
                blocked: [] as string[],
                items: [] as { url: string; score: number; flags: string[] }[],
                followMode: false,
            };
        }

        const urls = extractInlineUrls(inboundText);
        const items: { url: string; score: number; flags: string[] }[] = [];
        const blocked: string[] = [];

        const shorteners = /(bit\.ly|tinyurl\.com|t\.co|goo\.gl|rebrand\.ly|cutt\.ly|s\.id|is\.gd|ow\.ly)/i;
        const badTlds = /\.(zip|mov|top|xyz|click|link|rest|work|cam|icu|cfd|kim|gq|tk|ml)(\/|$)/i;

        for (const u of urls) {
            const url = String(u || "").trim();
            if (!url) continue;

            const flags: string[] = [];
            let score = 0;

            if (shorteners.test(url)) { flags.push("shortener"); score += 8; }
            if (/^https?:\/\/(\d{1,3}\.){3}\d{1,3}\b/i.test(url)) { flags.push("ip-host"); score += 10; }
            if (/@/.test(url)) { flags.push("at-sign"); score += 6; }
            if (/xn--/i.test(url)) { flags.push("punycode"); score += 10; }
            if (badTlds.test(url)) { flags.push("risky-tld"); score += 8; }
            if (url.length >= 60) { flags.push("long-url"); score += 4; }
            if (isInstallUrl(url)) { flags.push("install"); score += 14; }

            score = Math.max(0, Math.min(100, score));
            items.push({ url, score, flags });

            if (score >= 14) blocked.push(url);
        }

        const uniqBlocked: string[] = [];
        for (const b of blocked) if (b && !uniqBlocked.includes(b)) uniqBlocked.push(b);

        const followMode = Math.max(0, Math.floor((explicitActions as any)?.openUrl ?? 0)) > 0;

        return {
            total: items.reduce((a, x) => a + x.score, 0),
            blocked: uniqBlocked.slice(0, 12),
            items: items.sort((a, b) => b.score - a.score).slice(0, 10),
            followMode,
        };
    }, [deepEnabled, inboundText, explicitActions]);

    const embedSignals = useMemo(() => {
        if (!deepEnabled) {
            return {
                enabled: false,
                top: [] as { label: string; sim: number }[],
                maxSim: 0,
                triggered: false,
                byIndex: {} as Record<number, { label: string; sim: number; top: { label: string; sim: number }[] }>,
                blockTop: [] as { index: number; label: string; sim: number }[],
                // ✅ 룰/트리거 없이도 “후보”로 잡힌 블록들
                novelTop: [] as { index: number; label: string; sim: number; score: number }[],
                novelMaxSim: 0,

                // ✅ “앵커는 있는데 귀결행동이 어색” / “귀결행동은 있는데 앵커가 어색”
                mismatchTop: [] as {
                    index: number;
                    kind: "ANCHOR_MISS" | "ACTION_MISS";
                    anchorLabel: string;
                    anchorSim: number;
                    actionLabel: string;
                    actionSim: number;
                    score: number;
                }[],

                // ✅ 앵커-귀결행동 조합이 비정상(혼합형) 후보
                hybridTop: [] as {
                    index: number;
                    anchorLabel: string;
                    anchorSim: number;
                    actionLabel: string;
                    actionSim: number;
                    score: number;
                }[],

                // threshold 표기용
                thBlock: 0.72,
                thNovel: 0.74,
                thTrigger: 0.78,
                thMatch: 0.74,
                thLow: 0.70,
            };
        }

        const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

        const fnv1a32 = (s: string) => {
            let h = 0x811c9dc5;
            for (let i = 0; i < s.length; i++) {
                h ^= s.charCodeAt(i);
                h = Math.imul(h, 0x01000193);
            }
            return h >>> 0;
        };

        const normForEmbed = (s: string) => {
            const t = String(s || "").toLowerCase();
            const noUrl = t.replace(/\bhttps?:\/\/[^\s<>"')]+/gi, " ");
            const noDigits = noUrl.replace(/\d/g, "0");
            return noDigits.replace(/\s+/g, " ").trim().slice(0, 2200);
        };

        const embed64 = (s: string) => {
            const v = new Array(64).fill(0);
            const t = normForEmbed(s);

            // char 3-gram hashing
            const pad = `  ${t}  `;
            for (let i = 0; i + 3 <= pad.length; i++) {
                const g = pad.slice(i, i + 3);
                const h = fnv1a32(g);
                const idx = h % 64;
                const sign = (h & 1) === 0 ? 1 : -1;
                v[idx] += sign;
            }

            // normalize
            let n = 0;
            for (let i = 0; i < v.length; i++) n += v[i] * v[i];
            n = Math.sqrt(Math.max(1e-9, n));
            for (let i = 0; i < v.length; i++) v[i] /= n;

            return v;
        };

        const cos = (a: number[], b: number[]) => {
            let s = 0;
            for (let i = 0; i < 64; i++) s += (a[i] || 0) * (b[i] || 0);
            return clamp01((s + 1) / 2); // map [-1,1] -> [0,1]
        };

        // thresholds (UI/데모 기준)
        const thBlock = 0.72;   // 블록 단위 표시
        const thNovel = 0.74;   // “룰/트리거 없이도 후보”
        const thTrigger = 0.78; // 상단 TRIGGER 표기
        const thMatch = 0.74;   // 앵커/액션 각각 “있다” 판정
        const thLow = 0.70;     // 앵커/액션 “낮다” 판정

        // ====== Anchor prototypes (상황/주제) ======
        const anchors = [
            { label: "OTP/인증", text: "otp one time password verification code auth code 인증번호 보안코드 본인확인" },
            { label: "원격/설치", text: "remote control anydesk teamviewer support install app 원격 제어 설치 앱" },
            { label: "택배/배송", text: "parcel delivery address tracking link 택배 배송 주소 운송장 링크" },
            { label: "결제/환불", text: "payment invoice refund charge card 결제 청구 환불 카드" },
            { label: "계정/보안", text: "account locked suspicious login bank 금융기관 보안 계정 잠김 의심 로그인" },
            { label: "구인/알바", text: "recruiter job offer interview telegram whatsapp 알바 채용 면접 연락" },
            { label: "정부/기관", text: "police prosecutor court 국세청 검찰 경찰 수사 기관 압수 영장 사건" },
        ];
        const anchorVecs = anchors.map((p) => ({ label: p.label, vec: embed64(p.text) }));

        // ====== Action prototypes (귀결행동/요구행동) ======
        const actions = [
            { label: "인증/코드요구", text: "send code tell me otp enter code 입력해 보내줘 인증번호 알려줘 보안코드 전달" },
            { label: "앱설치/원격요구", text: "install app anydesk teamviewer apk 설치 원격 연결 화면공유 권한 허용" },
            { label: "링크클릭/로그인", text: "click link open url 접속 로그인 인증 링크 눌러 확인" },
            { label: "송금/이체", text: "transfer remit wire deposit 송금 이체 입금 계좌로 보내" },
            { label: "결제/상품권", text: "pay payment card gift card 문화상품권 결제 구매 충전" },
            { label: "계정정보/개인정보", text: "password pin 주민번호 계좌번호 비밀번호 아이디 인증정보 신분증" },
        ];
        const actionVecs = actions.map((p) => ({ label: p.label, vec: embed64(p.text) }));

        // ====== Anchor-Action 정상 조합(데모용) ======
        const okPairs: Record<string, string[]> = {
            "OTP/인증": ["인증/코드요구", "계정정보/개인정보", "링크클릭/로그인"],
            "원격/설치": ["앱설치/원격요구"],
            "택배/배송": ["링크클릭/로그인", "결제/상품권"],
            "결제/환불": ["결제/상품권", "송금/이체"],
            "계정/보안": ["링크클릭/로그인", "인증/코드요구", "계정정보/개인정보"],
            "구인/알바": ["링크클릭/로그인", "앱설치/원격요구", "계정정보/개인정보"],
            "정부/기관": ["송금/이체", "인증/코드요구", "계정정보/개인정보"],
        };

        const topK = (vec: number[], vecs: { label: string; vec: number[] }[], k: number) =>
            vecs
                .map((p) => ({ label: p.label, sim: cos(vec, p.vec) }))
                .sort((a, b) => b.sim - a.sim)
                .slice(0, Math.max(1, k));

        // global
        const fullText = String(inboundText || "");
        const vFull = embed64(fullText);

        const aTopFull = topK(vFull, anchorVecs, 3).map((x) => ({ label: `A:${x.label}`, sim: x.sim }));
        const xTopFull = topK(vFull, actionVecs, 3).map((x) => ({ label: `X:${x.label}`, sim: x.sim }));
        const scored = [...aTopFull, ...xTopFull].sort((a, b) => b.sim - a.sim).slice(0, 6);

        const maxSim = scored.length ? scored[0].sim : 0;
        const triggered = maxSim >= thTrigger;

        // per-block
        const byIndex: Record<number, { label: string; sim: number; top: { label: string; sim: number }[] }> = {};
        const blockTop: { index: number; label: string; sim: number }[] = [];

        // ✅ 룰/트리거 없이도 후보
        const novelTop: { index: number; label: string; sim: number; score: number }[] = [];
        let novelMaxSim = 0;

        // ✅ 미스매치/혼합형 후보
        const mismatchTop: {
            index: number;
            kind: "ANCHOR_MISS" | "ACTION_MISS";
            anchorLabel: string;
            anchorSim: number;
            actionLabel: string;
            actionSim: number;
            score: number;
        }[] = [];

        const hybridTop: {
            index: number;
            anchorLabel: string;
            anchorSim: number;
            actionLabel: string;
            actionSim: number;
            score: number;
        }[] = [];

        const ms = Array.isArray((preview as any)?.messageSummaries) ? (preview as any).messageSummaries : [];
        for (const m of ms) {
            const idx = Number((m as any)?.index || 0);
            if (!idx) continue;

            const bt = String((m as any)?.text || (m as any)?.content || (m as any)?.preview || "").trim();
            if (!bt) continue;

            const vb = embed64(bt);

            const aTop = topK(vb, anchorVecs, 3);
            const xTop = topK(vb, actionVecs, 3);

            const bestA = aTop[0] || { label: "n/a", sim: 0 };
            const bestX = xTop[0] || { label: "n/a", sim: 0 };

            const combTop = [
                ...aTop.map((x) => ({ label: `A:${x.label}`, sim: x.sim })),
                ...xTop.map((x) => ({ label: `X:${x.label}`, sim: x.sim })),
            ]
                .sort((a, b) => b.sim - a.sim)
                .slice(0, 3);

            const best = combTop[0] || { label: "n/a", sim: 0 };
            byIndex[idx] = { label: best.label, sim: best.sim, top: combTop };

            if (best.sim >= thBlock) blockTop.push({ index: idx, label: best.label, sim: best.sim });

            // 룰/트리거 없는 블록 판정
            const stageTriggers: any[] = Array.isArray((m as any)?.stageTriggers) ? (m as any).stageTriggers : [];
            const topRules: any[] = Array.isArray((m as any)?.topRules) ? (m as any).topRules : [];
            const hasRuleish = stageTriggers.length > 0 || topRules.length > 0;

            const score = Number((m as any)?.score ?? 0);

            // ✅ 룰/트리거 없이도 후보
            if (!hasRuleish && score < 35 && best.sim >= thNovel) {
                novelTop.push({ index: idx, label: best.label, sim: best.sim, score });
                if (best.sim > novelMaxSim) novelMaxSim = best.sim;
            }

            // ✅ 미스매치: 한쪽은 높은데 다른쪽은 낮음
            const anchorHigh = bestA.sim >= thMatch;
            const actionHigh = bestX.sim >= thMatch;
            const anchorLow = bestA.sim < thLow;
            const actionLow = bestX.sim < thLow;

            if (actionHigh && anchorLow) {
                mismatchTop.push({
                    index: idx,
                    kind: "ANCHOR_MISS",
                    anchorLabel: bestA.label,
                    anchorSim: bestA.sim,
                    actionLabel: bestX.label,
                    actionSim: bestX.sim,
                    score,
                });
            } else if (anchorHigh && actionLow) {
                mismatchTop.push({
                    index: idx,
                    kind: "ACTION_MISS",
                    anchorLabel: bestA.label,
                    anchorSim: bestA.sim,
                    actionLabel: bestX.label,
                    actionSim: bestX.sim,
                    score,
                });
            }

            // ✅ 혼합형: 둘 다 높은데(=앵커도 있고 귀결행동도 있음) 조합이 “비정상”
            if (anchorHigh && actionHigh) {
                const oks = okPairs[bestA.label] || [];
                const ok = oks.includes(bestX.label);
                if (!ok) {
                    hybridTop.push({
                        index: idx,
                        anchorLabel: bestA.label,
                        anchorSim: bestA.sim,
                        actionLabel: bestX.label,
                        actionSim: bestX.sim,
                        score,
                    });
                }
            }
        }

        blockTop.sort((a, b) => b.sim - a.sim);
        novelTop.sort((a, b) => b.sim - a.sim);
        mismatchTop.sort((a, b) => Math.max(b.anchorSim, b.actionSim) - Math.max(a.anchorSim, a.actionSim));
        hybridTop.sort((a, b) => Math.max(b.anchorSim, b.actionSim) - Math.max(a.anchorSim, a.actionSim));

        return {
            enabled: true,
            top: scored,
            maxSim,
            triggered,
            byIndex,
            blockTop: blockTop.slice(0, 10),

            novelTop: novelTop.slice(0, 10),
            novelMaxSim,

            mismatchTop: mismatchTop.slice(0, 10),
            hybridTop: hybridTop.slice(0, 10),

            thBlock,
            thNovel,
            thTrigger,
            thMatch,
            thLow,
        };
    }, [deepEnabled, inboundText, preview]);

    const phoneTurns = useMemo(() => parsePhoneTurns(displayText), [displayText]);
    const [phoneDraft, setPhoneDraft] = useState("");
    const [phoneDraftWho, setPhoneDraftWho] = useState<"S" | "R">("R");

    const sendPhoneDraft = () => {
        if (demoRunning) return;

        const body = String(phoneDraft || "").replace(/\r\n/g, "\n").trim();
        if (!body) return;

        const line = `${phoneDraftWho}: ${body}`;

        setThreadText((prev) => {
            const base = String(prev || "").replace(/\r\n/g, "\n").trimEnd();
            const next = base ? `${base}\n${line}` : line;

            setDisplayText(next);
            setSelectedBlock(null);

            return next;
        });

        setPhoneDraft("");
    };

    type UxPhase = 0 | 1 | 2 | 3;
    const [uxPhase, setUxPhase] = useState<UxPhase>(0);

    useEffect(() => {
        if (!deepEnabled) {
            setUxPhase(0);
            return;
        }

        // demo면 턴이 늘어날수록 1->2->3 단계로 켜짐
        const target: UxPhase = demoRunning
            ? ((Math.min(3, Math.max(1, Math.floor(phoneTurns.length / 3) + 1)) as unknown) as UxPhase)
            : 3;

        if (uxPhase >= target) return;

        const t = window.setTimeout(() => {
            setUxPhase((p) => ((Math.min(3, (p + 1) as number) as unknown) as UxPhase));
        }, 260);

        return () => window.clearTimeout(t);
    }, [deepEnabled, demoRunning, phoneTurns.length, uxPhase]);

    const chatRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
        const el = chatRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
    }, [phoneTurns.length, demoRunning]);

    const emitExplicitAction = (type: "openUrl" | "copyUrl" | "installClick", url?: string) => {
        const u = String(url || hoverUrl || "").trim();

        // ✅ 현재 URL이 "차단 목록"에 있는지(없으면 false)
        const blockedList = Array.isArray((urlGuard as any)?.blocked) ? ((urlGuard as any).blocked as string[]) : [];
        const isBlocked = !!u && blockedList.includes(u);

        // ✅ inbound URL이 아니면: 정책/트리거에는 반영하지 않고(이벤트/카운트 X), 동작만 수행
        const isInboundUrl = !!u && inboundUrlSet.has(u);

        if (!isInboundUrl) {
            if (type === "copyUrl") {
                if (u) void copyText(u);
                return;
            }
            if (type === "openUrl" || type === "installClick") {
                if (!u) return;

                if (isBlocked) {
                    void copyText(u);
                    return;
                }

                try {
                    window.open(u, "_blank", "noopener,noreferrer");
                } catch {
                    // ignore
                }
                return;
            }
            return;
        }

        // ✅ inbound URL에 대해서만 explicit action으로 기록
        try {
            window.dispatchEvent(
                new CustomEvent("pf_explicit_action", { detail: { type, url: u || undefined } } as any)
            );
        } catch {
            // ignore
        }

        try {
            setExplicitActions((prev: any) => {
                const base = prev && typeof prev === "object" ? prev : {};
                const next: any = { ...base };
                next[type] = Math.max(0, Math.floor(next[type] ?? 0)) + 1;
                if (u) next.lastUrl = u;
                next.lastType = type;
                next.lastAt = Date.now();
                return next;
            });
        } catch {
            // ignore
        }

        if (type === "copyUrl") {
            if (u) void copyText(u);
            return;
        }

        if (type === "openUrl" || type === "installClick") {
            if (!u) return;

            if (isBlocked) {
                void copyText(u);
                return;
            }

            try {
                window.open(u, "_blank", "noopener,noreferrer");
            } catch {
                // ignore
            }
            return;
        }
    };

    // Compact single-screen demo: Phone UX는 유지하고, 디버그/딥 패널은 기본 숨김
    const COMPACT_UI = true;

    // Call context는 데모 가치가 높아서 항상 노출(체크만으로도 설명 가능)
    const ctxOn = true;

    // URL/Embedding/Similarity 후보 목록 등 “딥 패널”은 compact에서는 숨김
    const urlOn = !COMPACT_UI && deepEnabled && uxPhase >= 2;
    const embOn = !COMPACT_UI && deepEnabled && uxPhase >= 3;


    type PhoneAlertLevel = "none" | "info" | "warn" | "danger";

    type PhoneAlert = {
        level: PhoneAlertLevel;
        title: string;
        detail?: string;
        chips?: string[];
        // danger일 때 중앙 토스트를 띄울지
        toast?: boolean;
    };

    // R(수신) 텍스트는 Threat 점수에 넣지 말고 “개입 타이밍”만 당기는 용도
    function inferInterventionUrgencyFromRawThread(rawThread: string): PhoneAlertLevel {
        if (!rawThread) return "none";
        const rLines = rawThread
            .split("\n")
            .filter((l) => /^\s*R\s*:/.test(l))
            .join(" ");

        // “이미 행동함/지금 하겠다” 류 = 개입 급함
        const danger = /(설치했|설치할게|원격|애니데스크|팀뷰어|눌렀|접속했|입력했|인증번호.*(보낼게|전달)|송금|이체|입금했|보냈어|결제했)/;
        if (danger.test(rLines)) return "danger";

        // “진행 중/검증 없이 따름” 류
        const warn = /(알겠|네\s*예|진행할게|확인했어|보낼까|어떻게 하면 돼|따라할게|지금 해볼게)/;
        if (warn.test(rLines)) return "warn";

        return "none";
    }

    function toScoreNumber(x: any): number | null {
        const n = typeof x === "number" ? x : Number(x);
        return Number.isFinite(n) ? n : null;
    }

    function normalizeRiskLevel(x: any): "low" | "medium" | "high" | null {
        const s = String(x ?? "").toLowerCase();
        if (s.includes("high")) return "high";
        if (s.includes("med")) return "medium";
        if (s.includes("low")) return "low";
        return null;
    }

    function stageToAlertLevel(stagePeak: any): PhoneAlertLevel {
        const s = String(stagePeak ?? "").toLowerCase();
        // 네 엔진 단계명에 맞춰 조정 가능
        if (s.includes("install") || s.includes("payment") || s.includes("bank")) return "danger";
        if (s.includes("verify") || s.includes("account")) return "warn";
        return "none";
    }

    function pickChipsFromPreview(preview: any, max = 3): string[] {
        const chips: string[] = [];

        const signalsTop = preview?.signalsTop;
        if (Array.isArray(signalsTop)) {
            for (const s of signalsTop) {
                const label = (s?.label ?? s?.id ?? "").toString().trim();
                if (label) chips.push(label);
                if (chips.length >= max) return chips;
            }
        }

        const similarityTop = preview?.similarityTop;
        if (similarityTop?.id && chips.length < max) chips.push(`유사사례: ${String(similarityTop.id)}`);

        const semanticTopArr: any[] = Array.isArray(preview?.semanticTop) ? (preview.semanticTop as any[]) : [];
        const sem0: any = semanticTopArr.length ? semanticTopArr[0] : null;
        if (sem0?.id && chips.length < max) chips.push(`유사문장: ${String(sem0.id)}`);

        return chips.slice(0, max);
    }

    /** 메시지/근거에서 “전화번호 후보” 추출 (근거용: tel 링크 아님) */
    function normalizePhoneKey(raw: string): string {
        if (!raw) return "";
        let s = String(raw).trim();
        // +82 / 82 → 0 으로 통일
        s = s.replace(/[^\d+]/g, "");
        if (s.startsWith("+82")) s = "0" + s.slice(3);
        else if (s.startsWith("82")) s = "0" + s.slice(2);
        s = s.replace(/[^\d]/g, "");

        // ✅ 개인번호만 허용: 모바일(01x) + 070
        if (/^01[016789]\d{7,8}$/.test(s)) return s;
        if (/^070\d{7,8}$/.test(s)) return s;

        // (02/지역/1588/단축번호 등은 여기서 제외)
        return "";
    }

    function formatPhoneDisplay(key: string): string {
        if (!key) return "";

        // 010/011/016/017/018/019
        if (/^01\d{8,9}$/.test(key)) {
            const a = key.slice(0, 3);
            const mid = key.length === 11 ? key.slice(3, 7) : key.slice(3, 6);
            const last = key.length === 11 ? key.slice(7) : key.slice(6);
            return `${a}-${mid}-${last}`;
        }

        // 070 포함(0xx 3자리 prefix)
        if (/^0\d{2}\d{7,8}$/.test(key)) {
            const a = key.slice(0, 3);
            const rest = key.slice(3);
            const mid = rest.length === 8 ? rest.slice(0, 4) : rest.slice(0, 3);
            const last = rest.length === 8 ? rest.slice(4) : rest.slice(3);
            return `${a}-${mid}-${last}`;
        }

        return key;
    }

    function extractPhoneCandidatesFromText(text: string, max = 6): Array<{ key: string; display: string }> {
        const out: Array<{ key: string; display: string }> = [];
        if (!text) return out;

        // ✅ 개인번호만 커버: 01x / 070 (하이픈/공백/무구분 + +82 케이스)
        const phoneRe =
            /(?:\+?82\s*)?(?:0?1[016789])[\s-]?\d{3,4}[\s-]?\d{4}|(?:\+?82\s*)?(?:0?70)[\s-]?\d{3,4}[\s-]?\d{4}|\b(?:01[016789]\d{7,8}|070\d{7,8})\b/g;

        const seen = new Set<string>();
        const src = String(text);

        let m: RegExpExecArray | null;
        while ((m = phoneRe.exec(src)) !== null) {
            const raw = String(m[0] || "").trim();
            const key = normalizePhoneKey(raw);
            if (!key) continue;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ key, display: formatPhoneDisplay(key) });
            if (out.length >= max) break;
        }

        return out;
    }

    /**
     * preview가 없어도 “gatePass/prefilter” 기반으로 경고바가 뜨게 하는 게 핵심.
     * - Threat(불변): preview(score/risk/stage) 기반
     * - Intervention(가변): R 라인 기반으로 알림을 더 빨리/강하게
     */
    function buildPhoneAlert(args: {
        preview: any | null;
        gatePass: boolean;
        prefilterScore: number;
        prefilterReasons?: string[];
        rawThread: string;
    }) {
        const { preview, gatePass, rawThread } = args;

        const none = {
            level: "none" as const,
            title: "",
            detail: "",
            chips: [] as string[],
            toast: false,
        };

        const uniq = (arr: string[]) => {
            const out: string[] = [];
            for (const x of arr) {
                const s = String(x || "").trim();
                if (!s) continue;
                if (out.includes(s)) continue;
                out.push(s);
            }
            return out;
        };

        const extractPhones = (text: string, cap = 3): string[] => {
            try {
                const arr = extractPhoneCandidatesFromText(String(text || ""), cap);
                const out: string[] = [];
                for (const x of arr) {
                    const disp = String((x as any)?.display || "").trim();
                    if (!disp) continue;
                    if (out.includes(disp)) continue;
                    out.push(disp);
                    if (out.length >= cap) break;
                }
                return out;
            } catch {
                return [];
            }
        };

        const detectedPhones = extractPhones(rawThread, 3);

        // full analysis score (0..100)
        const scoreTotal = Math.round(
            Math.max(0, Math.min(100, Number((preview as any)?.uiScoreTotal ?? (preview as any)?.scoreTotal ?? 0)))
        );

        // UI 경고는 uiRiskLevel(개입 타이밍) 우선, 없으면 riskLevel(Threat) 사용
        const uiRiskLevel = String((preview as any)?.uiRiskLevel || (preview as any)?.riskLevel || "")
            .toLowerCase()
            .trim();

        const stagePeak = String((preview as any)?.stagePeak || (preview as any)?.stage || "").trim();
        const chipsFromPreview = preview ? pickChipsFromPreview(preview, 3) : [];
        const detailFromPreview = (() => {
            const parts: string[] = [];
            if (stagePeak) parts.push(`stage: ${stagePeak}`);
            if (chipsFromPreview.length) parts.push(chipsFromPreview.join(" · "));
            return parts.join(" · ");
        })();

        // ✅ R(수신) 진행/순응 신호(Threat 점수와 분리된 “개입 타이밍”)
        const intervention = inferInterventionUrgencyFromRawThread(rawThread);

        const interventionHint = (() => {
            if (intervention === "danger") return "개입 급함: 수신자가 이미 진행/실행한 정황";
            if (intervention === "warn") return "개입 필요: 수신자가 지시에 따르려는 정황";
            return "";
        })();

        const mergeDetail = (base: string) => {
            const parts: string[] = [];
            if (base) parts.push(base);
            if (interventionHint) parts.push(interventionHint);
            return parts.join(" · ");
        };

        // medium/high일 때 경고바에 추가로 한 줄 안내(=detail)를 보여주기 위한 문구
        const guidanceLine = "앱을 통해 상세분석 후 필요시 신고 또는 상담 요망";

        // Threat=high는 항상 danger(기존 유지)
        if (uiRiskLevel === "high") {
            return {
                level: "danger" as const,
                title: "고위험 의심! 신고·상담 필요!",
                detail: mergeDetail(guidanceLine),
                chips: uniq([...detectedPhones, ...chipsFromPreview]),
                toast: false,
            };
        }

        // Threat=medium인데 R 진행 신호가 “danger”면 alert를 danger로 올려 ‘즉시 중단’ 토스트를 띄움(Threat 점수는 그대로)
        if (uiRiskLevel === "medium") {
            if (intervention === "danger") {
                return {
                    level: "danger" as const,
                    title: "지금 중단! 진행 신호 감지",
                    detail: mergeDetail(guidanceLine),
                    chips: uniq([...detectedPhones, ...chipsFromPreview]),
                    toast: true,
                };
            }

            return {
                level: "warn" as const,
                title: intervention === "warn" ? "주의! 순응 신호 감지" : "위험도 상승! 피싱/스캠 의심!",
                detail: mergeDetail(guidanceLine),
                chips: uniq([...detectedPhones, ...chipsFromPreview]),
                toast: false,
            };
        }

        // Threat가 낮거나(또는 preview가 없더라도) R 진행 신호가 강하면 “개입” 경고만 올림
        if (intervention === "danger") {
            return {
                level: "danger" as const,
                title: "지금 중단! 진행 신호 감지",
                detail: mergeDetail(detailFromPreview),
                chips: uniq([...detectedPhones, ...chipsFromPreview]),
                toast: true,
            };
        }

        if (intervention === "warn") {
            return {
                level: "warn" as const,
                title: "주의! 순응 신호 감지",
                detail: mergeDetail(detailFromPreview),
                chips: uniq([...detectedPhones, ...chipsFromPreview]),
                toast: false,
            };
        }

        // 프리필터가 임계값을 넘어서 "풀필터로 넘어가는" 구간에서만 노출
        if (!!triggerGateEnabled && gatePass && !preview) {
            return {
                level: "warn" as const,
                title: "위험 신호 발견! 분석 중…",
                detail: "",
                chips: uniq(["TRIGGER", ...detectedPhones]),
                toast: false,
            };
        }

        // 트리거로 분석이 끝났지만(저위험/무개입) 바가 바로 사라지는 UX 방지
        if (!!triggerGateEnabled && gatePass && !!preview) {
            const d = (Array.isArray(prefilterReasons) ? prefilterReasons : [])
                .filter(Boolean)
                .slice(0, 2)
                .join(" · ");
            return {
                level: "warn" as const,
                title: "분석 완료",
                detail: d,
                chips: uniq(["TRIGGER", ...detectedPhones]),
                toast: false,
            };
        }

        return none;
    }

    function PhoneTopAlertBar(props: { alert: PhoneAlert }) {
        const a: any = props?.alert as any;
        const level = String(a?.level || "none");
        const title = String(a?.title || "").trim();
        const detail = String(a?.detail || "").trim();

        const key = `${level}|${title}`;
        const [dismissKey, setDismissKey] = useState<string>("");

        useEffect(() => {
            if (dismissKey && dismissKey !== key) setDismissKey("");
        }, [key, dismissKey]);

        if (!a || level === "none" || !title) return null;
        if (dismissKey === key) return null;

        const isDanger = level === "danger";
        const bg = isDanger ? "rgba(255,70,70,0.88)" : "rgba(255,170,40,0.86)";
        const bd = isDanger ? "rgba(255,255,255,0.20)" : "rgba(255,255,255,0.18)";

        const chips: string[] = Array.isArray(a?.chips)
            ? a.chips.map((x: any) => String(x || "").trim()).filter(Boolean)
            : [];

        const toDigits = (s: string) => String(s || "").replace(/\D/g, "");
        const isPhoneLike = (d: string) => d.length >= 7 && d.length <= 12; // 감지된 실제 번호(표시만)

        const evidencePhones: string[] = [];

        for (const c of chips) {
            const d = toDigits(c);
            if (!d) continue;

            if (isPhoneLike(d)) {
                if (!evidencePhones.includes(c)) evidencePhones.push(c);
                continue;
            }
        }

        const shownEvidence = evidencePhones.slice(0, 2);

        return (
            <div
                style={{
                    position: "absolute",
                    left: 10,
                    right: 10,
                    top: 8,
                    zIndex: 60,
                    pointerEvents: "none",
                }}
            >
                <div
                    style={{
                        pointerEvents: "auto",
                        display: "flex",
                        flexDirection: "column",
                        gap: 8,
                        padding: "10px 12px",
                        borderRadius: 16,
                        background: bg,
                        border: `1px solid ${bd}`,
                        boxShadow: "0 10px 24px rgba(0,0,0,0.30)",
                        backdropFilter: "blur(6px)",
                    }}
                >
                    {/* 1줄: 문구 + 닫기 */}
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                        <div
                            style={{
                                minWidth: 0,
                                color: "rgba(255,255,255,0.98)",
                                fontSize: 13,
                                fontWeight: 900,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}
                            title={title}
                        >
                            {title}
                        </div>

                        <button
                            className="btn"
                            onClick={() => setDismissKey(key)}
                            title="닫기"
                            style={{
                                padding: "6px 10px",
                                borderRadius: 999,
                                background: "rgba(0,0,0,0.18)",
                                border: "1px solid rgba(255,255,255,0.22)",
                                color: "rgba(255,255,255,0.98)",
                                fontWeight: 900,
                                lineHeight: 1,
                            }}
                        >
                            ×
                        </button>
                    </div>

                    {/* 1.5줄: 안내/가이드(detail) */}
                    {detail ? (
                        <div
                            style={{
                                color: "rgba(255,255,255,0.94)",
                                fontSize: 12,
                                fontWeight: 850,
                                lineHeight: 1.25,
                                whiteSpace: "nowrap",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                            }}
                            title={detail}
                        >
                            {detail}
                        </div>
                    ) : null}

                    {/* 2줄: 감지번호(근거) */}
                    {shownEvidence.length ? (
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            {shownEvidence.map((p) => (
                                <span
                                    key={`e-${p}`}
                                    title="감지된 번호(근거)"
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: 6,
                                        padding: "6px 10px",
                                        borderRadius: 999,
                                        background: "rgba(0,0,0,0.14)",
                                        border: "1px solid rgba(255,255,255,0.20)",
                                        color: "rgba(255,255,255,0.98)",
                                        fontSize: 12,
                                        fontWeight: 850,
                                    }}
                                >
                                    <span style={{ fontSize: 13 }}>☎</span>
                                    <span>{p}</span>
                                </span>
                            ))}
                        </div>
                    ) : null}
                </div>
            </div>
        );
    }

    function PhoneCenterToast(props: { alert: PhoneAlert }) {
        const { alert } = props;
        if (!alert || !alert.toast || alert.level !== "danger") return null;

        const title = String(alert.title || "").trim();
        const detail = String((alert as any)?.detail || "").trim();

        return (
            <div style={{ position: "absolute", left: 12, right: 12, top: 70, zIndex: 40 }}>
                <div
                    style={{
                        background: "rgba(0,0,0,0.88)",
                        color: "white",
                        borderRadius: 18,
                        padding: "12px 12px",
                        boxShadow: "0 14px 40px rgba(0,0,0,0.55)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        backdropFilter: "blur(10px)",
                    }}
                >
                    <div
                        style={{
                            fontSize: 13,
                            fontWeight: 900,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                        }}
                        title={title}
                    >
                        {title}
                    </div>

                    {detail ? (
                        <div
                            style={{
                                marginTop: 6,
                                fontSize: 12,
                                fontWeight: 850,
                                color: "rgba(255,255,255,0.92)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                            title={detail}
                        >
                            {detail}
                        </div>
                    ) : null}
                </div>
            </div>
        );
    }

    const phoneAlert: PhoneAlert = (() => {
        try {
            // gatePass가 “현재 임계값 통과”와 정확히 맞도록 여기서 보정
            const gateOk = !!gatePass;

            const out = buildPhoneAlert({
                preview,
                gatePass: gateOk,
                prefilterScore: triggerGateEnabled ? prefilterScore : 0,
                prefilterReasons,
                rawThread: displayText,
            });

            // ✅ 원칙: 풀분석이 도는 구간(analysisBusy) 또는 결과(preview)가 있을 때만 노출
            // ✅ 예외: R(수신)에서 “이미 진행”급(danger) 신호가 있으면 즉시 개입 경고는 노출
            const rUrgency = inferInterventionUrgencyFromRawThread(displayText);
            const allowInterventionNow = rUrgency === "danger";

            if (!preview && !analysisBusy && !gateOk && !allowInterventionNow) {
                return {
                    level: "none",
                    title: "",
                    detail: "",
                    chips: [],
                    toast: false,
                } as any;
            }

            return out;
        } catch {
            return {
                level: "none",
                title: "",
                detail: "",
                chips: [],
                toast: false,
            } as any;
        }
    })();

    // 번호는 “입력 텍스트 + (가능하면) preview 근거(examples)”에서 같이 뽑기
    const detectedPhones = (() => {
        try {
            const raw = String(displayText || "");
            const sigs: any[] = Array.isArray((preview as any)?.signalsTop) ? ((preview as any)?.signalsTop as any[]) : [];
            const ex: string[] = [];

            for (const s of sigs) {
                const arr: any[] = Array.isArray(s?.examples) ? s.examples : [];
                for (const t of arr) {
                    const st = String(t || "").trim();
                    if (st) ex.push(st);
                    if (ex.length >= 40) break;
                }
                if (ex.length >= 40) break;
            }

            // fromNumber도 같이 넣어서 “[발신 070-…]” 케이스도 잡히게
            return extractPhoneCandidatesFromText([String(fromNumber || ""), raw, ...ex].join(" "));
        } catch {
            return [] as Array<{ key: string; display: string }>;
        }
    })();

    const primaryPhone = detectedPhones?.[0]?.display || "";

    // 폰 상단에 쓸 번호(우선순위: fromNumber → primaryPhone)
    const phoneHeaderNumber = useMemo(() => {
        const a = String(fromNumber || "").trim();
        if (a) return a;

        const b = String(primaryPhone || "").trim();
        if (b) return b;

        return "";
    }, [fromNumber, primaryPhone]);

    const phoneUx = phoneUxEnabled ? (
        <div className="card" style={{ background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.12)" }}>
            <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
                <div>
                    <div className="card-title">Demo layout</div>
                    <div className="card-desc">left: gauge · center: phone · right: compact controls</div>
                </div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <span className="pill">{demoRunning ? `DEMO ${demoIndex}/${demoTurns.length}` : "LIVE"}</span>
                    <span className="pill">ALERT: {String((phoneAlert as any)?.level || "none") === "none" ? "NONE" : String((phoneAlert as any)?.level || "unknown").toUpperCase()}</span>
                    <button className="btn" onClick={() => setPhoneUxEnabled(false)}>
                        Close
                    </button>
                </div>
            </div>

            <div style={{ height: 10 }} />

            <div
                style={{
                    display: "grid",
                    // center(폰) 최소 420~최대 520으로 키우고, 좌/우는 너무 커지지 않게 캡
                    gridTemplateColumns: "minmax(220px, 340px) minmax(420px, 520px) minmax(240px, 360px)",
                    justifyContent: "center", // 남는 폭이 생기면 가운데로 모아줌(옆으로 너무 길어지는 느낌 완화)
                    gap: 12,
                    alignItems: "start",
                }}
            >
                {/* LEFT: Gauge */}
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <div className="card" style={{ background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.12)" }}>
                        {(() => {
                            const scoreTotal = Math.round(
                                Math.max(0, Math.min(100, Number((preview as any)?.uiScoreTotal ?? (preview as any)?.scoreTotal ?? 0)))
                            );

                            const riskLevelRaw = String((preview as any)?.riskLevel || "").toLowerCase().trim();
                            const uiRiskLevelRaw = String((preview as any)?.uiRiskLevel || "").toLowerCase().trim();

                            const riskLevel = riskLevelRaw || "n/a";
                            const uiRiskLevel = uiRiskLevelRaw || (riskLevelRaw || "n/a");

                            const stagePeak = String((preview as any)?.stagePeak || (preview as any)?.stage || "n/a");

                            const gateMode = triggerGateEnabled
                                ? autoAnalyzeOnTrigger
                                    ? ((triggerState as any)?.mode === "auto" ? ((triggerState as any)?.ok ? "TRIGGERED" : "IDLE") : "MANUAL")
                                    : "MANUAL"
                                : "OFF";

                            const topSignals: any[] = Array.isArray((preview as any)?.signalsTop) ? ((preview as any)?.signalsTop as any[]) : [];

                            return (
                                <>
                                    <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
                                        <div>
                                            <div className="card-title">Risk</div>
                                            <div className="card-desc">prefilter → full analysis → warning</div>
                                        </div>
                                        <span className="pill">THREAT {String(riskLevel).toUpperCase()} · UI {String(uiRiskLevel).toUpperCase()} · {stagePeak}</span>
                                    </div>

                                    <div style={{ height: 12 }} />

                                    <div className="row-between" style={{ gap: 10, alignItems: "flex-end" }}>
                                        <div style={{ fontSize: 56, fontWeight: 800, lineHeight: 1 }}>
                                            {scoreTotal}
                                        </div>
                                        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-end" }}>
                                            <span className="pill">Gate: {gateMode}</span>
                                            <span
                                                className="pill"
                                                title={(Array.isArray(prefilterReasons) && prefilterReasons.length) ? prefilterReasons.join(" · ") : undefined}
                                            >
                                                Prefilter: {triggerGateEnabled ? prefilterScore : 0} / {triggerThreshold}
                                                {" · "}{String((triggerState as any)?.why || "n/a")}
                                                {" · "}E64 +{Number(embedGateBoost || 0)}
                                            </span>
                                            <span className="pill">SIM gate: {simMinSim} · topK: {simTopK}</span>
                                        </div>
                                    </div>

                                    <div style={{ height: 10 }} />

                                    <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.10)", overflow: "hidden" }}>
                                        <div
                                            style={{
                                                height: 8,
                                                width: `${scoreTotal}%`,
                                                background:
                                                    String(uiRiskLevel) === "high" ? "rgba(255,60,60,0.75)" :
                                                        String(uiRiskLevel) === "medium" ? "rgba(255,200,60,0.70)" :
                                                            "rgba(90,220,120,0.65)",
                                            }}
                                        />
                                    </div>

                                    <div style={{ height: 12 }} />

                                    <div className="pill">Top signals</div>
                                    <div style={{ height: 8 }} />

                                    {topSignals.length === 0 ? (
                                        <div className="muted" style={{ fontSize: 12 }}>no signals</div>
                                    ) : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                            {topSignals.slice(0, 6).map((s: any, i: number) => {
                                                const lab = String(s?.label || s?.id || `sig_${i + 1}`);
                                                const w = Math.round(Number(s?.weightSum || s?.weight || 0));
                                                const c = Number(s?.count || 0);
                                                return (
                                                    <div key={`${lab}-${i}`} className="row-between" style={{ gap: 8 }}>
                                                        <span
                                                            className="muted"
                                                            style={{
                                                                fontSize: 12,
                                                                overflow: "hidden",
                                                                textOverflow: "ellipsis",
                                                                whiteSpace: "nowrap",
                                                                maxWidth: 220,
                                                            }}
                                                            title={lab}
                                                        >
                                                            {lab}
                                                        </span>
                                                        <span className="pill">
                                                            +{w}{c ? ` · ${c}` : ""}
                                                        </span>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}

                                    <div style={{ height: 12 }} />

                                    <div className="pill">Status</div>
                                    <div style={{ height: 8 }} />
                                    <div className="muted" style={{ fontSize: 12, lineHeight: 1.5 }}>
                                        {String(uiRiskLevel) === "high" ? "⚠️ HIGH: warning should show" : String(uiRiskLevel) === "medium" ? "⚠️ MED: caution zone" : "OK: low zone"}
                                        <br />
                                        {triggerGateEnabled ? "prefilter always-on" : "gate OFF"}
                                        {autoAnalyzeOnTrigger ? " · auto analyze" : " · manual analyze"}
                                    </div>
                                </>
                            );
                        })()}
                    </div>

                    {/* Timeline / Progress (with recent events) */}
                    <div className="card" style={{ background: "rgba(255,255,255,0.06)" }}>
                        {(() => {
                            const now = new Date();
                            const tSec = demoRunning || demoIndex > 0 ? Math.max(0, (demoIndex - 1) * (Number(demoSpeedMs || 0) / 1000)) : 0;

                            const gateMode = triggerGateEnabled
                                ? autoAnalyzeOnTrigger
                                    ? ((triggerState as any)?.mode === "auto" ? ((triggerState as any)?.ok ? "TRIGGERED" : "IDLE") : "MANUAL")
                                    : "MANUAL"
                                : "OFF";

                            const pf = triggerGateEnabled ? prefilterScore : 0;
                            const pfOk = !triggerGateEnabled ? true : pf >= triggerThreshold;

                            const scoreTotal = Math.round(
                                Math.max(0, Math.min(100, Number((preview as any)?.uiScoreTotal ?? (preview as any)?.scoreTotal ?? 0)))
                            );
                            const stagePeak = String((preview as any)?.stagePeak || (preview as any)?.stage || "n/a");

                            const riskLevelRaw = String((preview as any)?.riskLevel || "").toLowerCase().trim();
                            const uiRiskLevelRaw = String((preview as any)?.uiRiskLevel || "").toLowerCase().trim();

                            const riskLevel = riskLevelRaw || "n/a";
                            const uiRiskLevel = uiRiskLevelRaw || (riskLevelRaw || "n/a");

                            const simArr: any[] = Array.isArray((preview as any)?.similarityTop) ? ((preview as any).similarityTop as any[]) : [];
                            const simTop = simArr?.[0] || null;
                            const simPct = simTop ? Math.round(Math.max(0, Math.min(1, Number(simTop?.similarity || 0))) * 100) : null;

                            const emb: any = embedSignals as any;
                            const embLabel = String(emb?.top?.[0]?.label || "n/a");
                            const embPct = Math.round(Math.max(0, Math.min(1, Number(emb?.maxSim || 0))) * 100);

                            const why = String((triggerState as any)?.why || "n/a");
                            const trigOk = !!(triggerState as any)?.ok;

                            const lines: Array<{ k: string; v: string; tone?: "good" | "warn" | "bad" }> = [
                                {
                                    k: "t",
                                    v: (demoRunning || demoIndex > 0) ? `T+${tSec.toFixed(1)}s · DEMO ${demoIndex}/${demoTurns.length}` : `${now.toLocaleTimeString()} · LIVE`,
                                },
                                { k: "prefilter", v: `${pf}/${triggerThreshold} · ${pfOk ? "pass" : "wait"}`, tone: pfOk ? "good" : "warn" },
                                { k: "trigger", v: `auto: ${trigOk ? "pass" : "wait"} · ${why}`, tone: trigOk ? "good" : "warn" },
                                { k: "e64", v: `E64 +${Number(embedGateBoost || 0)} (light embed boost)`, tone: Number(embedGateBoost || 0) > 0 ? "good" : undefined },

                                { k: "gate", v: `Gate: ${gateMode}`, tone: gateMode === "TRIGGERED" ? "good" : gateMode === "IDLE" ? "warn" : undefined },
                                { k: "analysis", v: preview ? `score ${scoreTotal} · THREAT ${String(riskLevel).toUpperCase()} · UI ${String(uiRiskLevel).toUpperCase()} · ${stagePeak}` : "no full analysis", tone: preview ? (String(uiRiskLevel) === "high" ? "bad" : String(uiRiskLevel) === "medium" ? "warn" : "good") : undefined },
                                { k: "hash64", v: deepEnabled ? `HASH64 ${embLabel} · ${embPct}%${emb?.triggered ? " · TRIGGER" : ""}` : "HASH64 OFF" },
                                { k: "sim", v: deepEnabled ? (simPct == null ? `SIM n/a · gate ${simMinSim}` : `SIM ${simPct}% · gate ${simMinSim}`) : "SIM OFF" },
                                { k: "reasons", v: (Array.isArray(prefilterReasons) && prefilterReasons.length) ? `reasons: ${prefilterReasons.slice(0, 4).join(" · ")}` : "reasons: n/a" },
                            ];

                            const dot = (tone?: "good" | "warn" | "bad") => {
                                const bg =
                                    tone === "bad" ? "rgba(255,70,70,0.80)" :
                                        tone === "warn" ? "rgba(255,200,60,0.80)" :
                                            tone === "good" ? "rgba(90,220,120,0.80)" :
                                                "rgba(255,255,255,0.35)";
                                return <span style={{ width: 8, height: 8, borderRadius: 999, background: bg, display: "inline-block" }} />;
                            };

                            const toneOfEvent = (type: string) => {
                                const t = String(type || "").toLowerCase();
                                if (t.includes("err")) return "bad" as const;
                                if (t.includes("wait")) return "warn" as const;
                                if (t.includes("blocked")) return "warn" as const;
                                if (t.includes("run")) return "good" as const;
                                if (t.includes("schedule")) return "good" as const;
                                return undefined;
                            };

                            const tlRoot: any = (globalThis as any).__phishTimeline;
                            const evs: any[] = Array.isArray(tlRoot?.events) ? tlRoot.events : [];
                            const recent = evs.slice(-8).reverse();

                            return (
                                <>
                                    <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
                                        <div>
                                            <div className="card-title">Timeline</div>
                                            <div className="card-desc">progress snapshot + recent events</div>
                                        </div>
                                        <span className="pill">{preview ? "ANALYZED" : (triggerGateEnabled && autoAnalyzeOnTrigger ? "WAIT" : "READY")}</span>
                                    </div>

                                    <div style={{ height: 10 }} />

                                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                        {lines.map((x) => (
                                            <div key={x.k} className="row-between" style={{ gap: 10, alignItems: "flex-start" }}>
                                                <div className="row" style={{ gap: 8, alignItems: "center" }}>
                                                    {dot(x.tone)}
                                                    <span className="muted" style={{ fontSize: 12, minWidth: 78 }}>{x.k}</span>
                                                </div>
                                                <div style={{ flex: 1, textAlign: "right" }}>
                                                    <span className="muted" style={{ fontSize: 12, lineHeight: 1.35 }}>{x.v}</span>
                                                </div>
                                            </div>
                                        ))}

                                        <div className="row" style={{ gap: 12, flexWrap: "wrap", marginTop: 4 }}>
                                            <span className="row" style={{ gap: 6, alignItems: "center" }}>
                                                {dot()}
                                                <span className="muted" style={{ fontSize: 11 }}>neutral/info</span>
                                            </span>
                                            <span className="row" style={{ gap: 6, alignItems: "center" }}>
                                                {dot("good")}
                                                <span className="muted" style={{ fontSize: 11 }}>ok/pass/run</span>
                                            </span>
                                            <span className="row" style={{ gap: 6, alignItems: "center" }}>
                                                {dot("warn")}
                                                <span className="muted" style={{ fontSize: 11 }}>wait/blocked</span>
                                            </span>
                                            <span className="row" style={{ gap: 6, alignItems: "center" }}>
                                                {dot("bad")}
                                                <span className="muted" style={{ fontSize: 11 }}>err/high</span>
                                            </span>
                                        </div>
                                    </div>

                                    <div style={{ height: 12 }} />
                                    <div className="pill">Events</div>
                                    <div style={{ height: 8 }} />

                                    {recent.length === 0 ? (
                                        <div className="muted" style={{ fontSize: 12 }}>no events</div>
                                    ) : (
                                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                            {recent.map((e: any, i: number) => {
                                                const type = String(e?.type || "evt");
                                                const msg = String(e?.msg || "");
                                                const t = String(e?.t || "");
                                                const ts = t ? t.replace("T", " ").replace("Z", "") : "";
                                                const tone = toneOfEvent(type);
                                                return (
                                                    <div key={`${type}-${i}-${t}`} className="row-between" style={{ gap: 10, alignItems: "flex-start" }}>
                                                        <div className="row" style={{ gap: 8, alignItems: "center" }}>
                                                            {dot(tone)}
                                                            <span className="muted" style={{ fontSize: 12, minWidth: 78 }}>{type}</span>
                                                        </div>
                                                        <div style={{ flex: 1, textAlign: "right" }}>
                                                            <span className="muted" style={{ fontSize: 12, lineHeight: 1.35 }}>
                                                                {msg}{ts ? ` · ${ts}` : ""}
                                                            </span>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </>
                            );
                        })()}
                    </div>
                </div>

                {/* CENTER: Phone */}
                <div
                    style={{
                        position: "relative",
                        justifySelf: "center",
                        width: "100%",
                        maxWidth: 520,   // 너무 가로로 퍼지지 않게(폰 비율 유지)
                        minWidth: 420,   // 영상에서 작아 보이지 않게
                        borderRadius: 28,
                        background: "#0b0c0f",
                        border: "2px solid rgba(255,255,255,0.90)", // 흰 테두리 강조
                        boxShadow: "0 12px 34px rgba(0,0,0,0.45)",
                        overflow: "hidden",
                    }}
                >
                    {null /* PhoneCenterToast disabled: TopAlertBar only */}

                    <div
                        style={{
                            height: 62,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            padding: "0 14px",
                            background: "rgba(255,255,255,0.06)",
                            borderBottom: "1px solid rgba(255,255,255,0.10)",
                        }}
                    >
                        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                            <div
                                style={{
                                    fontSize: 14,
                                    fontWeight: 900,
                                    color: "rgba(255,255,255,0.92)",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                }}
                                title="sender"
                            >
                                {(() => {
                                    const p0 = String(phoneHeaderNumber || "").trim();
                                    if (!p0) return "알 수 없는 번호";

                                    const norm = normalizePhone(p0);
                                    const disp = norm ? formatPhoneDisplay(norm) : p0;
                                    return disp || p0;
                                })()}
                            </div>

                            <div
                                style={{
                                    fontSize: 11,
                                    color: "rgba(255,255,255,0.70)",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    userSelect: "none",
                                    display: "flex",
                                    alignItems: "center",
                                    gap: 8,
                                    minWidth: 0,
                                }}
                            >
                                {(() => {
                                    const p0 = String(phoneHeaderNumber || "").trim();
                                    if (!p0) return <>{demoRunning ? "typing..." : "idle"}</>;

                                    const norm = normalizePhone(p0);
                                    const isKnown = !!norm && Array.isArray(knownNumbers) && knownNumbers.includes(norm);
                                    const status = isKnown ? "저장된 연락처" : "미등록 번호";

                                    return (
                                        <div
                                            style={{
                                                flex: 1,
                                                minWidth: 0,
                                                whiteSpace: "nowrap",
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                            }}
                                            title={`발신번호 · ${status}`}
                                        >
                                            {`발신번호 · ${status}`}
                                        </div>
                                    );
                                })()}
                            </div>
                        </div>

                        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                            <span className="pill">
                                {(() => {
                                    const scoreTotal = Math.round(Math.max(0, Math.min(100, Number((preview as any)?.scoreTotal || 0))));
                                    return `score ${scoreTotal}`;
                                })()}
                            </span>
                        </div>
                    </div>

                    <PhoneTopAlertBar
                        alert={
                            (phoneAlert as any) || {
                                level: "none",
                                title: "",
                                detail: "",
                                chips: [],
                                toast: false,
                            }
                        }
                    />

                    <div
                        style={{
                            paddingLeft: 12,
                            paddingRight: 12,
                            paddingBottom: 12,
                            paddingTop: ((phoneAlert as any)?.level && (phoneAlert as any).level !== "none") ? 74 : 12,
                            // 화면 높이에 맞춰 늘어나되 과하게 커지진 않게
                            height: "clamp(520px, 70vh, 740px)",
                            overflowY: "auto",
                            display: "flex",
                            flexDirection: "column",
                            gap: 10,
                            backgroundImage: `
            linear-gradient(180deg, rgba(244,246,248,1) 0%, rgba(236,240,245,1) 100%),
            radial-gradient(circle at 18% 22%, rgba(0,0,0,0.025), transparent 42%),
            radial-gradient(circle at 82% 28%, rgba(0,0,0,0.020), transparent 48%),
            radial-gradient(circle at 35% 78%, rgba(0,0,0,0.018), transparent 50%)
        `,
                            color: "rgba(15,20,30,0.96)",
                        }}
                    >
                        {(() => {
                            const raw = String(displayText || "");
                            const lines = raw.split("\n").map((x) => x.trim()).filter(Boolean);

                            // 1) 본문에서 “전화번호 후보” 추출 (근거용 표시 + 하이라이트 term에도 넣기)
                            const extractPhoneCandidates = (text: string): { display: string; rawForms: string[] }[] => {
                                const hits: string[] = [];
                                const pushAll = (re: RegExp) => {
                                    const ms = text.match(re);
                                    if (ms && ms.length) for (const m of ms) hits.push(String(m || "").trim());
                                };

                                // ✅ 개인번호만: 01x / 070 (+82 포함, 하이픈/공백 허용)
                                pushAll(/(?:\+82[-\s]?)?(?:0?1[016789])[-\s]?\d{3,4}[-\s]?\d{4}\b/g);
                                pushAll(/(?:\+82[-\s]?)?(?:0?70)[-\s]?\d{3,4}[-\s]?\d{4}\b/g);
                                // 하이픈 없이 붙은 케이스
                                pushAll(/\b(?:01[016789]\d{7,8}|070\d{7,8})\b/g);

                                const seenDisp = new Set<string>();
                                const out: { display: string; rawForms: string[] }[] = [];

                                const fmt = (digits0: string): string => {
                                    let digits = digits0;
                                    if (digits.startsWith("82") && digits.length >= 10) {
                                        digits = "0" + digits.slice(2);
                                    }
                                    if (/^010\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
                                    if (/^0\d{2}\d{7}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`; // 070-xxx-xxxx
                                    if (/^0\d{2}\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`; // 070-xxxx-xxxx
                                    return digits;
                                };

                                for (const h of hits) {
                                    const rawOne = String(h || "").trim();
                                    if (!rawOne) continue;

                                    let digits = rawOne.replace(/\D/g, "");
                                    if (!digits) continue;

                                    // +82 → 0 통일 후 개인번호만 통과
                                    if (digits.startsWith("82") && digits.length >= 10) digits = "0" + digits.slice(2);

                                    const ok = /^01[016789]\d{7,8}$/.test(digits) || /^070\d{7,8}$/.test(digits);
                                    if (!ok) continue;

                                    const display = fmt(digits);
                                    if (!display || seenDisp.has(display)) continue;

                                    const rawForms = [rawOne];
                                    if (display !== rawOne) rawForms.push(display);

                                    seenDisp.add(display);
                                    out.push({ display, rawForms });
                                    if (out.length >= 4) break;
                                }

                                return out;
                            };

                            const phoneCandidates = extractPhoneCandidates(raw);

                            const sigs: any[] = Array.isArray((preview as any)?.signalsTop) ? ((preview as any)?.signalsTop as any[]) : [];
                            const terms: string[] = [];

                            // 2) 기존 signalsTop examples → highlight terms
                            for (const s of sigs) {
                                const ex: any[] = Array.isArray(s?.examples) ? s.examples : [];
                                for (const t of ex) {
                                    const st = String(t || "").trim();
                                    if (!st) continue;
                                    if (st.length < 2) continue;
                                    if (st.length > 28) continue;
                                    if (terms.includes(st)) continue;
                                    terms.push(st);
                                    if (terms.length >= 16) break;
                                }
                                if (terms.length >= 16) break;
                            }

                            // 3) 전화번호도 “근거 하이라이트”로 넣기 (원문형/표시형 모두)
                            for (const c of phoneCandidates) {
                                for (const rf of c.rawForms) {
                                    const st = String(rf || "").trim();
                                    if (!st) continue;
                                    if (st.length < 2) continue;
                                    if (st.length > 28) continue;
                                    if (terms.includes(st)) continue;
                                    terms.push(st);
                                    if (terms.length >= 18) break;
                                }
                                if (terms.length >= 18) break;
                            }

                            const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                            const re = terms.length ? new RegExp(`(${terms.map(esc).join("|")})`, "gi") : null;

                            const renderHL = (text: string) => {
                                const src = String(text || "");

                                // 1) 먼저 “전화번호 후보”를 분해해서 토큰화
                                const phoneTokenRe =
                                    /(?:\+?82\s*)?(?:0?1[016789]|0?70)[\s-]?\d{3,4}[\s-]?\d{4}|\b(?:01[016789]\d{7,8}|070\d{7,8})\b/g;

                                const chunks: Array<{ kind: "text" | "phone"; value: string; key?: string; display?: string }> = [];
                                let last = 0;
                                let m: RegExpExecArray | null;

                                while ((m = phoneTokenRe.exec(src)) !== null) {
                                    const s = m.index ?? 0;
                                    const e = s + String(m[0] || "").length;

                                    if (s > last) chunks.push({ kind: "text", value: src.slice(last, s) });

                                    const raw = String(m[0] || "").trim();
                                    const key = normalizePhoneKey(raw);
                                    const display = key ? formatPhoneDisplay(key) : raw;

                                    // ✅ 개인번호로 정규화 실패하면 "phone" 토큰으로 취급하지 않음
                                    if (!key) {
                                        chunks.push({ kind: "text", value: raw });
                                    } else {
                                        chunks.push({ kind: "phone", value: raw, key, display });
                                    }

                                    last = e;
                                }
                                if (last < src.length) chunks.push({ kind: "text", value: src.slice(last) });

                                // 2) 텍스트 chunk에는 기존 “terms 하이라이트(re)” 적용
                                const renderTerms = (t: string) => {
                                    if (!re) return <>{t}</>;
                                    const parts = t.split(re);
                                    return (
                                        <>
                                            {parts.map((p, i) => {
                                                const isHit = i % 2 === 1;
                                                return isHit ? (
                                                    <span
                                                        key={i}
                                                        style={{
                                                            background: "rgba(255,70,70,0.22)",
                                                            border: "1px solid rgba(255,70,70,0.25)",
                                                            borderRadius: 6,
                                                            padding: "0 4px",
                                                        }}
                                                    >
                                                        {p}
                                                    </span>
                                                ) : (
                                                    <span key={i}>{p}</span>
                                                );
                                            })}
                                        </>
                                    );
                                };

                                return (
                                    <>
                                        {chunks.map((c, idx) => {
                                            if (c.kind !== "phone") {
                                                return <span key={`t-${idx}`}>{renderTerms(c.value)}</span>;
                                            }

                                            const display = String(c.display || c.value || "");
                                            if (!display.trim()) return <span key={`p-${idx}`}>{c.value}</span>;

                                            return (
                                                <span
                                                    key={`p-${idx}`}
                                                    title={`탭해서 복사: ${display}`}
                                                    onClick={() => {
                                                        try {
                                                            void copyText(display);
                                                        } catch {
                                                            // ignore
                                                        }
                                                    }}
                                                    style={{
                                                        cursor: "pointer",
                                                        userSelect: "none",
                                                        background: "rgba(30,90,255,0.12)",
                                                        border: "1px solid rgba(30,90,255,0.18)",
                                                        borderRadius: 8,
                                                        padding: "1px 6px",
                                                        margin: "0 1px",
                                                        fontWeight: 800,
                                                    }}
                                                >
                                                    📋 {display}
                                                </span>
                                            );
                                        })}
                                    </>
                                );
                            };

                            if (!lines.length) {
                                return <div className="muted" style={{ fontSize: 12 }}>no messages</div>;
                            }

                            return (
                                <>
                                    {/* 감지된 번호(근거): 스크롤 안에서 sticky로 상단에 고정 */}
                                    {phoneCandidates.length ? (
                                        <div
                                            style={{
                                                position: "sticky",
                                                top: 0,
                                                zIndex: 5,
                                                paddingTop: 2,
                                                paddingBottom: 6,
                                            }}
                                        >
                                            <div
                                                style={{
                                                    background: "rgba(255,255,255,0.88)",
                                                    border: "1px solid rgba(0,0,0,0.08)",
                                                    borderRadius: 14,
                                                    padding: "8px 10px",
                                                    boxShadow: "0 10px 24px rgba(0,0,0,0.10)",
                                                    backdropFilter: "blur(6px)",
                                                }}
                                            >
                                                <div style={{ fontSize: 11, color: "rgba(60,70,85,0.72)", marginBottom: 6, fontWeight: 700 }}>
                                                    감지된 번호(근거)
                                                </div>
                                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                                    {phoneCandidates.map((c) => (
                                                        <button
                                                            key={c.display}
                                                            className="btn"
                                                            onClick={() => void copyText(c.display)}
                                                            title="복사"
                                                            style={{
                                                                display: "inline-flex",
                                                                alignItems: "center",
                                                                gap: 8,
                                                                padding: "7px 10px",
                                                                borderRadius: 999,
                                                                background: "rgba(0,0,0,0.05)",
                                                                border: "1px solid rgba(0,0,0,0.10)",
                                                                color: "rgba(20,25,35,0.92)",
                                                                fontSize: 12,
                                                                fontWeight: 850,
                                                            }}
                                                        >
                                                            <span style={{ fontSize: 13 }}>☎</span>
                                                            <span>{c.display}</span>
                                                            <span style={{ opacity: 0.65, fontWeight: 800 }}>copy</span>
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                    ) : null}

                                    {lines.map((line, idx) => {
                                        const m = line.match(/^\s*([SR])\s*:\s*(.*)$/i);
                                        const who = m ? String(m[1]).toUpperCase() : "S";
                                        const body = m ? String(m[2] || "") : line;

                                        const mine = who === "R";

                                        const bubbleBg = mine ? "rgba(210,235,255,0.95)" : "rgba(255,255,255,0.94)";
                                        const bubbleBorder = mine ? "1px solid rgba(90,140,255,0.32)" : "1px solid rgba(0,0,0,0.08)";
                                        const bubbleText = mine ? "rgba(10,35,60,0.96)" : "rgba(15,20,30,0.96)";
                                        const metaText = "rgba(70,80,95,0.70)";

                                        // ✅ 앵커/귀결행동요구/추가단서(엔진 기반) 칩
                                        const chips: string[] = [];

                                        // phone bubble 순서가 BLK 순서와 같다는 가정(대부분 케이스에서 일치)
                                        const blkIndex = idx + 1;

                                        const clamp = (s0: any, n: number) => {
                                            const s = String(s0 ?? "").replace(/\s+/g, " ").trim();
                                            if (!s) return "";
                                            return s.length <= n ? s : s.slice(0, Math.max(1, n - 1)).trimEnd() + "…";
                                        };

                                        const ms: any =
                                            preview && Array.isArray((preview as any)?.messageSummaries)
                                                ? (preview as any).messageSummaries.find((m: any) => Number(m?.index || 0) === blkIndex)
                                                : null;

                                        // ✅ URL 변형(우회) 칩(폰 UI 표기용)
                                        const mutChips = detectUrlMutChips(
                                            body,
                                            ms && Array.isArray((ms as any)?.urls) ? ((ms as any).urls as string[]) : undefined
                                        );

                                        if (ms) {
                                            const header = String(ms?.header || "").trim();
                                            const actor = String(ms?.actorHint || "").trim(); // demand/comply/...
                                            const stageTriggers: string[] = Array.isArray(ms?.stageTriggers)
                                                ? ms.stageTriggers.map((x: any) => String(x || "").trim()).filter(Boolean)
                                                : [];
                                            const topRuleLabels: string[] = Array.isArray(ms?.topRules)
                                                ? ms.topRules.map((r: any) => String(r?.label || r || "").trim()).filter(Boolean)
                                                : [];

                                            // MUT 칩은 speaker 관계없이 먼저 추가(있을 때만)
                                            for (const c of mutChips) chips.push(c);

                                            if (!mine) {
                                                // S: 앵커/요구/근거(엔진이 준 라벨 그대로)
                                                if (header) chips.push(`앵커:${clamp(header, 16)}`);
                                                if (actor) chips.push(actor === "demand" ? "요구" : actor.toUpperCase());
                                                for (const t of stageTriggers.slice(0, 2)) chips.push(t);
                                                for (const r of topRuleLabels.slice(0, 2)) chips.push(r);
                                            } else {
                                                // R: 순응/저항/확인요청 등(엔진 라벨 우선)
                                                if (actor) chips.push(actor === "comply" ? "순응" : actor.toUpperCase());
                                                for (const t of stageTriggers.slice(0, 2)) chips.push(t);
                                                for (const r of topRuleLabels.slice(0, 2)) chips.push(r);
                                            }
                                        } else {
                                            // preview가 없을 때만 최소 폴백(하드코딩 확장 금지)
                                            const hasUrl = /(?:https?:\/\/|www\.|hxxp|\[\.\]|xn--)/i.test(body);
                                            const hasOtp = /\b(otp|one[\s-]?time|auth code|verification code|인증번호|보안코드|본인확인)\b/i.test(body);
                                            const hasRemote =
                                                /\b(anydesk|teamviewer|remote|support|원격|제어)\b/i.test(body) || /앱\s*설치|설치해|깔아|받아/i.test(body);
                                            const hasXfer = /계좌|이체|송금|입금|안전\s*계좌|수수료|카드\s*번호|결제|환불|청구/i.test(body);

                                            if (!mine) {
                                                // MUT 칩은 URL 신호가 있거나 변형 패턴이 잡힐 때만
                                                if (hasUrl || mutChips.length) for (const c of mutChips) chips.push(c);

                                                if (hasUrl) chips.push("URL");
                                                if (hasOtp) chips.push("OTP");
                                                if (hasRemote) chips.push("원격/설치");
                                                if (hasXfer) chips.push("이체/결제");
                                            } else {
                                                const rDid =
                                                    /(눌렀|클릭|접속했|열었|들어갔|설치했|깔았|받았|다운받|입력했|보냈|전달했|송금했|이체했|입금했|결제했|캡처|스크린샷)/i.test(body);
                                                const rAbout =
                                                    /(눌러(볼게|보려|볼까요)|열어(볼게|보려)|들어가(볼게|보려)|설치(할게|하려|해볼게)|다운(받을게|받으려)|입력(할게|하려)|보내(줄게|볼게|려)|송금(할게|하려)|이체(할게|하려)|입금(할게|하려)|결제(할게|하려))/i.test(body);
                                                if (rDid) chips.push("순응:완료");
                                                else if (rAbout) chips.push("순응:예정");
                                            }
                                        }

                                        // dedup + cap
                                        const chips2: string[] = [];
                                        for (const c of chips) {
                                            const s = String(c || "").trim();
                                            if (!s) continue;
                                            if (!chips2.includes(s)) chips2.push(s);
                                            if (chips2.length >= 6) break;
                                        }
                                        chips.splice(0, chips.length, ...chips2);

                                        const chipStyle: React.CSSProperties = {
                                            display: "inline-flex",
                                            alignItems: "center",
                                            padding: "1px 8px",
                                            borderRadius: 999,
                                            fontSize: 10,
                                            fontWeight: 850,
                                            background: "rgba(0,0,0,0.06)",
                                            border: "1px solid rgba(0,0,0,0.08)",
                                            color: "rgba(40,50,65,0.85)",
                                        };

                                        return (
                                            <div
                                                key={`${idx}-${who}`}
                                                style={{
                                                    display: "flex",
                                                    justifyContent: mine ? "flex-end" : "flex-start",
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        maxWidth: "86%",
                                                        padding: "10px 12px",
                                                        borderRadius: 18,
                                                        background: bubbleBg,
                                                        border: bubbleBorder,
                                                        color: bubbleText,
                                                        fontSize: 13,
                                                        lineHeight: 1.45,
                                                        whiteSpace: "pre-wrap",
                                                        boxShadow: "0 8px 18px rgba(0,0,0,0.10)",
                                                    }}
                                                >
                                                    <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                                                        <span style={{ fontSize: 11, color: metaText, fontWeight: 800 }}>
                                                            {mine ? "me" : "sender"}
                                                        </span>
                                                        {chips.slice(0, 6).map((c) => (
                                                            <span key={c} style={chipStyle}>{c}</span>
                                                        ))}
                                                    </div>

                                                    {renderHL(body)}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </>
                            );
                        })()}
                    </div>

                    <div
                        style={{
                            padding: 10,
                            borderTop: "1px solid rgba(255,255,255,0.10)",
                            background: "rgba(255,255,255,0.04)",
                        }}
                    >
                        <div style={{ display: "flex", gap: 8 }}>
                            <input
                                value={""}
                                onChange={() => { }}
                                placeholder="(demo) input disabled"
                                style={{
                                    flex: 1,
                                    height: 38,
                                    padding: "0 12px",
                                    borderRadius: 14,
                                    border: "1px solid rgba(255,255,255,0.12)",
                                    background: "rgba(0,0,0,0.25)",
                                    color: "rgba(255,255,255,0.85)",
                                    outline: "none",
                                }}
                                disabled
                            />
                            <button className="btn" disabled>
                                Send
                            </button>
                        </div>
                    </div>
                </div>

                {/* RIGHT: Controls */}
                <div className="card" style={{ background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.12)" }}>
                    <div className="row-between">
                        <div>
                            <div className="card-title">Controls</div>
                            <div className="card-desc">gate / demo / checks</div>
                        </div>
                        <span className="pill">{demoRunning ? `DEMO ${demoIndex}/${demoTurns.length}` : "LIVE"}</span>
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="card" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="card-title">Trigger gate</div>
                        <div style={{ height: 8 }} />
                        <ToggleRow label="Enable trigger gate (prefilter)" checked={triggerGateEnabled} onChange={setTriggerGateEnabled} />
                        <ToggleRow label="Auto analyze when threshold met" checked={autoAnalyzeOnTrigger} onChange={setAutoAnalyzeOnTrigger} />
                        <div style={{ height: 8 }} />
                        <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
                            <span className="pill">Threshold: {triggerThreshold}</span>
                            <span className="pill">Prefilter: {triggerGateEnabled ? prefilterScore : 0}</span>
                            {triggerGateEnabled && triggerState?.ok ? (
                                <span
                                    className="pill"
                                    title={triggerState?.why || ""}
                                    style={{
                                        background: "rgba(255,170,40,0.16)",
                                        borderColor: "rgba(255,170,40,0.28)",
                                        color: "rgba(255,220,170,0.95)",
                                    }}
                                >
                                    TRIGGERED
                                </span>
                            ) : null}
                        </div>
                        <div style={{ height: 8 }} />
                        <input
                            type="range"
                            min={0}
                            max={60}
                            value={triggerThreshold}
                            onChange={(e) => setTriggerThreshold(Number(e.target.value || 0))}
                            style={{ width: "100%" }}
                            disabled={!triggerGateEnabled || !autoAnalyzeOnTrigger}
                        />
                        <div style={{ height: 10 }} />
                        <button className="btn" onClick={() => runAnalyze()} disabled={!canAnalyze} title="manual trigger">
                            Analyze now
                        </button>
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="card" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="card-title">Demo</div>
                        <div style={{ height: 8 }} />
                        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                            <button
                                className="btn"
                                onClick={() => {
                                    if (demoRunning) setDemoRunning(false);
                                    else {
                                        if (demoTurns.length) setDemoRunning(true);
                                        else startDemo(threadText);
                                    }
                                }}
                                disabled={!threadText.trim()}
                            >
                                {demoRunning ? "Pause" : "Play"}
                            </button>

                            <button
                                className="btn"
                                onClick={() => {
                                    if (!demoTurns.length) startDemo(threadText);
                                    else {
                                        const next = Math.min(demoTurns.length, demoIndex + 1);
                                        setDemoIndex(next);
                                        setDisplayText(turnsToText(demoTurns, next));
                                    }
                                }}
                                disabled={!threadText.trim()}
                            >
                                Step
                            </button>

                            <button className="btn" onClick={() => startDemo(threadText)} disabled={!threadText.trim()}>
                                Restart
                            </button>

                            <button className="btn" onClick={stopDemo} disabled={!demoRunning && !demoTurns.length}>
                                Live
                            </button>
                        </div>

                        <div style={{ height: 10 }} />

                        <div className="row-between" style={{ gap: 10 }}>
                            <span className="muted" style={{ fontSize: 12 }}>speed</span>
                            <span className="pill">{demoSpeedMs}ms</span>
                        </div>
                        <input
                            type="range"
                            min={120}
                            max={4000}
                            value={demoSpeedMs}
                            onChange={(e) => setDemoSpeedMs(Number(e.target.value || 900))}
                            style={{ width: "100%", marginTop: 8 }}
                        />
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="card" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="card-title">Call context</div>
                        <div style={{ height: 8 }} />
                        <ToggleRow label="OTP requested" checked={otpAsked} onChange={setOtpAsked} />
                        <ToggleRow label="Remote control / app install" checked={remoteAsked} onChange={setRemoteAsked} />
                        <ToggleRow label="Urgent / pressured" checked={urgentPressured} onChange={setUrgentPressured} />
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="card" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="card-title">Turn split</div>
                        <div style={{ height: 8 }} />
                        <div className="muted" style={{ fontSize: 12, lineHeight: 1.45 }}>
                            phone bubble은 "S:"(발신) / "R:"(나) 프리픽스 기준으로 좌/우 정렬됨
                        </div>
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="card" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="card-title">Preview toggle</div>
                        <div style={{ height: 8 }} />
                        <label className="row" style={{ gap: 8 }}>
                            <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                            <span className="muted" style={{ fontSize: 12 }}>라이브 미리보기</span>
                        </label>
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="card" style={{ background: "rgba(255,255,255,0.06)" }}>
                        <div className="row-between" style={{ gap: 10, flexWrap: "wrap" }}>
                            <div>
                                <div className="card-title">Embedding / Similarity candidates</div>
                                <div className="card-desc">risk에 직접 반영되지 않아도 “구조적으로 닮은” 후보</div>

                                <div className="muted" style={{ fontSize: 11, lineHeight: 1.35, marginTop: 4, maxWidth: 320 }}>
                                    {(() => {
                                        const t = String(inboundText || "").replace(/\s+/g, " ").trim();
                                        const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");
                                        return `엔진 문장(S만): ${t ? cut(t, 140) : "—"}`;
                                    })()}
                                </div>
                            </div>
                            <span className="pill">
                                {(() => {
                                    const nSim = Array.isArray(simIndexItems) ? simIndexItems.length : 0;
                                    const nSem = Array.isArray(semIndexItems) ? semIndexItems.length : 0;

                                    const simArr: any[] = Array.isArray((preview as any)?.similarityTop)
                                        ? (((preview as any).similarityTop as any[]) || [])
                                        : [];

                                    const semArr: any[] = Array.isArray((preview as any)?.semanticTop)
                                        ? (((preview as any).semanticTop as any[]) || [])
                                        : [];

                                    const pct = (v0: any) => {
                                        let v = Number(v0 ?? 0);
                                        if (!Number.isFinite(v)) v = 0;
                                        if (v > 1) v = v / 100; // 혹시 0~100 스케일이면 방어
                                        return Math.round(Math.max(0, Math.min(1, v)) * 100);
                                    };

                                    const topSim = simArr.length ? pct(simArr[0]?.similarity ?? simArr[0]?.sim ?? simArr[0]?.score) : null;
                                    const topSem = semArr.length ? pct(semArr[0]?.similarity ?? semArr[0]?.sim ?? semArr[0]?.score) : null;

                                    const left = nSim <= 0 ? "SIM 0" : topSim == null ? "SIM n/a" : `SIM ${topSim}%`;
                                    const right = nSem <= 0 ? "SEM 0" : topSem == null ? "SEM n/a" : `SEM ${topSem}%`;

                                    return `${left} · ${right}`;
                                })()}
                            </span>
                        </div>

                        <div style={{ height: 8 }} />

                        {(() => {
                            if (!deepEnabled) return <div className="muted">OFF (Deep disabled)</div>;
                            if (gateLocked) return <div className="muted">LOCKED until trigger (auto gate)</div>;

                            const pct = (v0: any) => {
                                let v = Number(v0 ?? 0);
                                if (!Number.isFinite(v)) v = 0;
                                if (v > 1) v = v / 100;
                                return Math.round(Math.max(0, Math.min(1, v)) * 100);
                            };

                            const nSim = Array.isArray(simIndexItems) ? simIndexItems.length : 0;
                            const nSem = Array.isArray(semIndexItems) ? semIndexItems.length : 0;

                            const simArr: any[] = Array.isArray((preview as any)?.similarityTop)
                                ? (((preview as any).similarityTop as any[]) || [])
                                : [];

                            const semArr: any[] = Array.isArray((preview as any)?.semanticTop)
                                ? (((preview as any).semanticTop as any[]) || [])
                                : [];

                            const sigArr: any[] = Array.isArray((preview as any)?.signals) ? ((preview as any).signals as any[]) : [];
                            const sigLabelById: Record<string, string> = {};
                            for (const s of sigArr) {
                                const id = String(s?.id ?? "").trim();
                                const lab = String(s?.label ?? "").trim();
                                if (id && lab) sigLabelById[id] = lab;
                            }

                            // ✅ simIndexItems에서 후보 원문(sample) lookup (engine result에 sample이 없어도 UI에서 표시 가능)
                            const simSampleById: Record<string, string> = {};
                            for (const it of (Array.isArray(simIndexItems) ? (simIndexItems as any[]) : [])) {
                                const id = String((it as any)?.id ?? "").trim();
                                if (!id) continue;
                                const sample = String((it as any)?.sample ?? "").replace(/\s+/g, " ").trim();
                                if (sample) simSampleById[id] = sample;
                            }

                            const fmtSub = (x: any) => {
                                const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…");

                                const ids: any[] = Array.isArray(x?.sharedSignals) ? (x.sharedSignals as any[]) : [];
                                const labs = ids
                                    .map((k) => String(k ?? "").trim())
                                    .filter(Boolean)
                                    .map((k) => sigLabelById[k] || k);

                                const sample0 = String(
                                    x?.sample ??
                                    (x as any)?.candidate?.sample ??
                                    (x as any)?.item?.sample ??
                                    ""
                                )
                                    .replace(/\s+/g, " ")
                                    .trim();

                                // ✅ 엔진 결과에 sample이 없으면(similarityTop 경로/타입 차이) simIndexItems에서 id로 fallback
                                const id0 = String(x?.id ?? "").trim();
                                const sampleUse = sample0 || (id0 ? String(simSampleById[id0] || "").trim() : "");

                                const parts: { short: string; full: string }[] = [];

                                if (labs.length) {
                                    const fullRules = labs.join(" · ");
                                    const shortRules = labs.slice(0, 4).join(" · ");
                                    parts.push({ short: `유사 규칙: ${shortRules}`, full: `유사 규칙: ${fullRules}` });
                                }

                                if (sampleUse) {
                                    parts.push({ short: `유사 문장: ${cut(sampleUse, 60)}`, full: `유사 문장: ${sampleUse}` });
                                }

                                if (!parts.length) return "";
                                return {
                                    short: parts.map((p) => p.short).join(" / "),
                                    full: parts.map((p) => p.full).join(" / "),
                                };
                            };

                            const row = (lab: string, scorePct: number, exp?: string, sub?: { short: string; full: string } | "", keySeed?: string) => (
                                <div key={`${keySeed || lab}-${scorePct}-${exp || ""}`} className="row-between" style={{ gap: 8 }}>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                                        <span
                                            className="muted"
                                            style={{
                                                fontSize: 12,
                                                overflow: "hidden",
                                                textOverflow: "ellipsis",
                                                whiteSpace: "nowrap",
                                                maxWidth: 180,
                                            }}
                                            title={lab}
                                        >
                                            {lab}
                                        </span>

                                        {sub ? (
                                            <span
                                                className="muted"
                                                style={{
                                                    fontSize: 11,
                                                    opacity: 0.9,
                                                    overflow: "hidden",
                                                    textOverflow: "ellipsis",
                                                    whiteSpace: "nowrap",
                                                    maxWidth: 180,
                                                }}
                                                title={(sub as any).full || String(sub)}
                                            >
                                                {(sub as any).short || String(sub)}
                                            </span>
                                        ) : null}
                                    </div>

                                    <span className="pill">
                                        {scorePct}%{exp ? ` ${exp}` : ""}
                                    </span>
                                </div>
                            );

                            return (
                                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                        <div className="muted" style={{ fontSize: 11, fontWeight: 800 }}>SEM (embedding)</div>

                                        {nSem <= 0 ? (
                                            <div className="muted">Semantic index not loaded (0 items)</div>
                                        ) : !semArr.length ? (
                                            <div className="muted">no SEM candidates</div>
                                        ) : (
                                            <>
                                                {semArr.slice(0, 5).map((x: any, i: number) => {
                                                    const lab = String(x?.category || x?.id || x?.label || `#${i + 1}`);
                                                    const sim = pct(x?.similarity ?? x?.sim ?? x?.score);
                                                    const exp = String(x?.expectedRisk || "").toUpperCase();
                                                    const keySeed = String(x?.id || `${lab}-${i}`);
                                                    return row(lab, sim, exp, "" as any, keySeed);
                                                })}
                                                <div className="muted" style={{ fontSize: 11 }}>
                                                    semGate(minSim): {semMinSim} · topK: {semTopK} · index: {nSem}
                                                </div>
                                            </>
                                        )}

                                        <div style={{ height: 8 }} />

                                        <div className="muted" style={{ fontSize: 11, fontWeight: 800 }}>LITE (on-device)</div>

                                        {!deepEnabled || !(embedSignals as any)?.enabled ? (
                                            <div className="muted">Lite embedding disabled</div>
                                        ) : !(embedSignals as any)?.top?.length ? (
                                            <div className="muted">no LITE candidates</div>
                                        ) : (
                                            <>
                                                {(embedSignals as any).top.slice(0, 5).map((x: any, i: number) => {
                                                    const lab = String(x?.label || `#${i + 1}`);
                                                    const sim = pct(x?.sim ?? 0);
                                                    const keySeed = `lite-${lab}-${i}`;
                                                    return row(lab, sim, "" as any, "" as any, keySeed);
                                                })}

                                                <div className="muted" style={{ fontSize: 11 }}>
                                                    th(block/novel/trigger): {(embedSignals as any).thBlock} / {(embedSignals as any).thNovel} / {(embedSignals as any).thTrigger}
                                                    {(Array.isArray((embedSignals as any)?.novelTop) && (embedSignals as any).novelTop.length)
                                                        ? ` · novel: ${(embedSignals as any).novelTop.length}`
                                                        : ""}
                                                    {(Array.isArray((embedSignals as any)?.mismatchTop) && (embedSignals as any).mismatchTop.length)
                                                        ? ` · mismatch: ${(embedSignals as any).mismatchTop.length}`
                                                        : ""}
                                                    {(Array.isArray((embedSignals as any)?.hybridTop) && (embedSignals as any).hybridTop.length)
                                                        ? ` · hybrid: ${(embedSignals as any).hybridTop.length}`
                                                        : ""}
                                                </div>

                                                {(Array.isArray((embedSignals as any)?.mismatchTop) && (embedSignals as any).mismatchTop.length) ||
                                                    (Array.isArray((embedSignals as any)?.hybridTop) && (embedSignals as any).hybridTop.length) ? (
                                                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
                                                        {Array.isArray((embedSignals as any)?.mismatchTop)
                                                            ? (embedSignals as any).mismatchTop.slice(0, 3).map((x: any, i: number) => {
                                                                const kind = String(x?.kind || "MISMATCH");
                                                                const lab = `${kind} · BLK ${x?.index ?? "?"} · A:${String(x?.anchorLabel || "n/a")} / X:${String(x?.actionLabel || "n/a")}`;
                                                                const sim = pct(Math.max(Number(x?.anchorSim || 0), Number(x?.actionSim || 0)));
                                                                const keySeed = `lite-mis-${x?.index ?? "x"}-${i}`;
                                                                return row(lab, sim, "" as any, "" as any, keySeed);
                                                            })
                                                            : null}

                                                        {Array.isArray((embedSignals as any)?.hybridTop)
                                                            ? (embedSignals as any).hybridTop.slice(0, 3).map((x: any, i: number) => {
                                                                const lab = `HYBRID · BLK ${x?.index ?? "?"} · A:${String(x?.anchorLabel || "n/a")} / X:${String(x?.actionLabel || "n/a")}`;
                                                                const sim = pct(Math.max(Number(x?.anchorSim || 0), Number(x?.actionSim || 0)));
                                                                const keySeed = `lite-hyb-${x?.index ?? "x"}-${i}`;
                                                                return row(lab, sim, "" as any, "" as any, keySeed);
                                                            })
                                                            : null}
                                                    </div>
                                                ) : null}
                                            </>
                                        )}
                                    </div>

                                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                        <div className="muted" style={{ fontSize: 11, fontWeight: 800 }}>SEM (embedding)</div>

                                        {nSem <= 0 ? (
                                            <div className="muted">Semantic index not loaded (0 items)</div>
                                        ) : !semArr.length ? (
                                            <div className="muted">no SEM candidates</div>
                                        ) : (
                                            <>
                                                {semArr.slice(0, 5).map((x: any, i: number) => {
                                                    const lab = String(x?.category || x?.id || x?.label || `#${i + 1}`);
                                                    const sim = pct(x?.similarity ?? x?.sim ?? x?.score);
                                                    const exp = String(x?.expectedRisk || "").toUpperCase();
                                                    const keySeed = String(x?.id || `${lab}-${i}`);
                                                    return row(lab, sim, exp, "" as any, keySeed);
                                                })}
                                                <div className="muted" style={{ fontSize: 11 }}>
                                                    semGate(minSim): {semMinSim} · topK: {semTopK} · index: {nSem}
                                                </div>
                                            </>
                                        )}
                                    </div>
                                </div>
                            );
                        })()}
                    </div>
                </div>
            </div>
        </div>
    ) : null;

    return (
        <div className="card">
            <div className="card-header">
                <div>
                    <div className="card-title">대화/문자 전체 입력</div>
                    <div className="card-desc">BLK 클릭 → 원문 카드 펼침 + 정확 점프</div>
                </div>
                <span className="pill">Input · Thread</span>
            </div>

            <div style={{ height: 10 }} />

            <div className="row-between">
                <ExamplePicker
                    examples={EXAMPLES}
                    onPick={(ex) => {
                        const v = String(ex?.text || "").replace(/\r\n/g, "\n");
                        const meta: any = (ex as any)?.meta || {};

                        const cc: any = meta.callChecks || {};
                        setOtpAsked(typeof cc.otpAsked === "boolean" ? cc.otpAsked : false);
                        setRemoteAsked(typeof cc.remoteAsked === "boolean" ? cc.remoteAsked : false);
                        setUrgentPressured(typeof cc.urgentPressured === "boolean" ? cc.urgentPressured : false);

                        const autoFrom =
                            typeof meta.fromNumber === "string" && meta.fromNumber.trim()
                                ? meta.fromNumber
                                : (() => {
                                    // meta에 없을 때도 thread에서 한 번 더 파싱 (예: "[ 발신 010 - ... ]")
                                    const m = v.match(/\[\s*발신\s*([^\]]+?)\s*\]/);
                                    if (m && m[1]) {
                                        return String(m[1])
                                            .replace(/\s+/g, " ")
                                            .replace(/\s*-\s*/g, "-")
                                            .trim();
                                    }
                                    return /\bhttps?:\/\//i.test(v) ? "010-0000-0000" : "";
                                })();

                        setFromNumber(autoFrom);

                        const norm = normalizePhone(String(autoFrom || ""));
                        if (norm && norm.length >= 6) {
                            if (meta.isSavedContact === true) {
                                setKnownNumbers((prev) => (prev.includes(norm) ? prev : [norm, ...prev].slice(0, 200)));
                            } else if (meta.isSavedContact === false) {
                                setKnownNumbers((prev) => prev.filter((x) => x !== norm));
                            }
                        }

                        if (typeof meta.demoSpeedMs === "number" && meta.demoSpeedMs > 0) {
                            setDemoSpeedMs(meta.demoSpeedMs);
                        }

                        setThreadText(v);
                        startDemo(v);

                        const ea: any = meta.explicitActions;
                        if (ea && typeof ea === "object") setExplicitActions(ea);
                    }}
                />

                <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button
                        type="button"
                        className="pill"
                        title="앵커(택배) + 귀결(송금) 조합이 비정상 → HYBRID 후보"
                        onClick={() => {
                            const v = [
                                "S: [택배] 반송 처리. 주소 확인을 위해 아래 계좌로 3,000원 송금 바랍니다.",
                                "R: 무슨 소리예요?",
                                "S: OO은행 123-45-678901 지금 바로 이체해 주세요.",
                            ].join("\n");
                            setExplicitActions({});
                            setThreadText(v);
                            startDemo(v);
                            window.setTimeout(() => {
                                try {
                                    runAnalyze();
                                } catch {
                                    // ignore
                                }
                            }, 60);
                        }}
                    >
                        LITE:HYBRID
                    </button>

                    <button
                        type="button"
                        className="pill"
                        title="귀결(송금) 강함 + 앵커 약함 → ANCHOR_MISS 후보"
                        onClick={() => {
                            const v = [
                                "S: 지금 123-45-678901 계좌로 30만원 즉시 이체해. 확인되면 연락할게.",
                                "R: 왜요?",
                            ].join("\n");
                            setExplicitActions({});
                            setThreadText(v);
                            startDemo(v);
                            window.setTimeout(() => {
                                try {
                                    runAnalyze();
                                } catch {
                                    // ignore
                                }
                            }, 60);
                        }}
                    >
                        LITE:ACTION→ANCHOR
                    </button>

                    <button
                        type="button"
                        className="pill"
                        title="앵커(택배/계정 등) 강함 + 귀결 약함 → ACTION_MISS 후보"
                        onClick={() => {
                            const v = [
                                "S: 택배가 반송 처리되었습니다. 주소 확인 바랍니다.",
                                "R: 네?",
                            ].join("\n");
                            setExplicitActions({});
                            setThreadText(v);
                            startDemo(v);
                            window.setTimeout(() => {
                                try {
                                    runAnalyze();
                                } catch {
                                    // ignore
                                }
                            }, 60);
                        }}
                    >
                        LITE:ANCHOR→ACTION
                    </button>
                </div>

                <label className="row" style={{ gap: 8 }}>
                    <input type="checkbox" checked={previewEnabled} onChange={(e) => setPreviewEnabled(e.target.checked)} />
                    <span className="muted" style={{ fontSize: 12 }}>
                        라이브 미리보기
                    </span>
                </label>
            </div>

            <div style={{ height: 10 }} />

            {phoneUx}

            <div style={{ height: 10 }} />

            <TextArea
                ref={taRef}
                value={threadText}
                onChange={(v) => {
                    setThreadText(v);
                    if (!demoRunning) setDisplayText(String(v || "").replace(/\r\n/g, "\n"));
                }}
                onKeyDown={(e) => {
                    const isEnter = e.key === "Enter";
                    const isMeta = e.metaKey || e.ctrlKey;
                    if (isEnter && isMeta) {
                        e.preventDefault();
                        runAnalyze();
                        return;
                    }
                    if (e.key === "Escape") {
                        setSelectedBlock(null);
                        return;
                    }
                }}
            />

            <div style={{ height: 10 }} />
            <div className="row-between">
                <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                    <span className="pill">
                        Preview:{" "}
                        {(() => {
                            if (preview)
                                return `${String((preview as any).uiRiskLevel ?? preview.riskLevel).toUpperCase()} · ${(preview as any).uiScoreTotal ?? preview.scoreTotal
                                    }/100`;
                            if (!previewEnabled) return "disabled";
                            if (!canAnalyze) return "n/a";
                            if (triggerGateEnabled && autoAnalyzeOnTrigger) {
                                const why = String((triggerState as any)?.why || "gate");
                                const rs = Array.isArray(prefilterReasons) ? prefilterReasons.slice(0, 2).join(" · ") : "";
                                const extra = rs ? ` · ${rs}` : "";
                                return `waiting · ${why} · prefilter ${prefilterScore}/${triggerThreshold}${extra}`;
                            }
                            return "n/a";
                        })()}
                    </span>

                    <span className="pill">Blocks: {preview ? preview.messageCount : 0}</span>

                    {/* 트리거 게이트(자동) 대기중이면 LOCKED, 그 외엔 EMB 표시 */}
                    <span
                        className="pill"
                        title={(() => {
                            const emb: any = embedSignals as any;

                            const gateLocked =
                                !!deepEnabled &&
                                !!triggerGateEnabled &&
                                !!autoAnalyzeOnTrigger &&
                                (triggerState as any)?.mode === "auto" &&
                                !(triggerState as any)?.ok &&
                                !preview;

                            if (!deepEnabled) return "Embedding OFF (Deep disabled)";
                            if (gateLocked) return "Embedding locked until trigger";

                            const top = (Array.isArray(emb?.top) ? emb.top : []).slice(0, 3);
                            const parts =
                                top.length > 0
                                    ? top.map((x: any) => `${x.label} ${Math.round(Math.max(0, Math.min(1, Number(x.sim || 0))) * 100)}%`)
                                    : ["n/a"];

                            const trig = emb?.triggered ? "YES" : "NO";
                            return `Embedding top: ${parts.join(" | ")} (triggered: ${trig})`;
                        })()}
                    >
                        EMB:{" "}
                        {(() => {
                            const emb: any = embedSignals as any;

                            const gateLocked =
                                !!deepEnabled &&
                                !!triggerGateEnabled &&
                                !!autoAnalyzeOnTrigger &&
                                (triggerState as any)?.mode === "auto" &&
                                !(triggerState as any)?.ok &&
                                !preview;

                            if (!deepEnabled) return "OFF";
                            if (gateLocked) return "LOCKED";

                            const label = String(emb?.top?.[0]?.label || "n/a");
                            const pct = Math.round(Math.max(0, Math.min(1, Number(emb?.maxSim || 0))) * 100);
                            return `${label} · ${pct}%${emb?.triggered ? " · TRIGGER" : ""}`;
                        })()}
                    </span>

                    {/* ✅ Similarity(simIndex) 표시 */}
                    <span
                        className="pill"
                        title={(() => {
                            const gateLocked =
                                !!deepEnabled &&
                                !!triggerGateEnabled &&
                                !!autoAnalyzeOnTrigger &&
                                (triggerState as any)?.mode === "auto" &&
                                !(triggerState as any)?.ok &&
                                !preview;

                            if (!deepEnabled) return "Similarity OFF (Deep disabled)";
                            if (gateLocked) return "Similarity locked until trigger";

                            const n = Array.isArray(simIndexItems) ? simIndexItems.length : 0;
                            if (n <= 0) return "Similarity index not loaded (0 items)";

                            const arr: any[] = Array.isArray((preview as any)?.similarityTop) ? ((preview as any).similarityTop as any[]) : [];
                            const top3 = arr.slice(0, 3).map((x: any) => {
                                const lab = String(x?.category || x?.id || "n/a");
                                const sim = Math.round(Math.max(0, Math.min(1, Number(x?.similarity || 0))) * 100);
                                const exp = String(x?.expectedRisk || "").toUpperCase();
                                return `${lab} ${sim}%${exp ? ` (${exp})` : ""}`;
                            });

                            return `SimIndex: ${n} items · Top: ${top3.length ? top3.join(" | ") : "n/a"}`;
                        })()}
                    >
                        SIM:{" "}
                        {(() => {
                            const gateLocked =
                                !!deepEnabled &&
                                !!triggerGateEnabled &&
                                !!autoAnalyzeOnTrigger &&
                                (triggerState as any)?.mode === "auto" &&
                                !(triggerState as any)?.ok &&
                                !preview;

                            if (!deepEnabled) return "OFF";
                            if (gateLocked) return "LOCKED";

                            const n = Array.isArray(simIndexItems) ? simIndexItems.length : 0;
                            if (n <= 0) return "INDEX 0";

                            const top: any = Array.isArray((preview as any)?.similarityTop) ? (preview as any).similarityTop?.[0] : null;
                            if (!top) return "n/a";

                            const lab = String(top?.category || top?.id || "n/a");
                            const sim = Math.round(Math.max(0, Math.min(1, Number(top?.similarity || 0))) * 100);
                            const exp = String(top?.expectedRisk || "").toUpperCase();
                            return `${lab} · ${sim}%${exp ? ` · ${exp}` : ""}`;
                        })()}
                    </span>
                </div>

                <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                    <button className="btn" onClick={() => setPhoneUxEnabled((v) => !v)}>
                        {phoneUxEnabled ? "Hide Phone UX" : "Show Phone UX"}
                    </button>

                    <button
                        className="btn"
                        onClick={() => {
                            const v = [
                                "S: 고객센터 support 입니다. 원격 제어 필요합니다.",
                                "S: anydesk teamviewer remote control 설치 앱 실행 후 연결해주세요.",
                                "S: 계정 잠김 suspicious login 감지. verification code 인증번호 확인 필요합니다.",
                                "S: 아래 링크로 접속 후 본인확인 진행: https://example.com/verify",
                            ].join("\n");

                            setThreadText(v);
                            startDemo(v);

                            // SEM 후보(=E5)까지 보려면 runAnalyze를 한 번 태워야 함
                            setTimeout(() => {
                                runAnalyze();
                            }, 0);
                        }}
                        title="E5(SEM) 후보가 뜨는 샘플을 로드하고 즉시 Analyze"
                    >
                        Load EMB demo
                    </button>

                    <ActionButtons
                        primaryLabel="Analyze"
                        onPrimary={() => {
                            runAnalyze();
                        }}
                        primaryFeedback={false}
                        secondaryLabel="Copy input"
                        onSecondary={async () => {
                            return await copyText(String(threadText || "").normalize("NFC"));
                        }}
                        tertiaryLabel="Copy package"
                        onTertiary={async () => {
                            return await copyReportPackage();
                        }}
                    />
                </div>
            </div>

            {preview ? (
                <>
                    <div style={{ height: 10 }} />
                    <div className="card" style={{ background: "var(--panel2)" }}>
                        <div className="row-between">
                            <div>
                                <div className="card-title">Top risky blocks</div>
                                <div className="card-desc">클릭하면 해당 BLK로 점프 + 상세 카드 열림</div>
                            </div>

                            <div className="row" style={{ gap: 8, flexWrap: "wrap", justifyContent: "flex-end" }}>
                                {deepEnabled && embedSignals.enabled ? (
                                    <span
                                        className="pill"
                                        title={
                                            embedSignals.top?.length
                                                ? embedSignals.top.map((x) => `${x.label} ${Math.round(Math.max(0, Math.min(1, Number(x.sim || 0))) * 100)}%`).join(" | ")
                                                : undefined
                                        }
                                    >
                                        {(() => {
                                            const pct = Math.round(Math.max(0, Math.min(1, Number(embedSignals.maxSim || 0))) * 100);
                                            const best = embedSignals.top?.length ? embedSignals.top[0].label : "n/a";
                                            const trig = embedSignals.triggered ? " · TRIGGER" : "";
                                            return `EMB: ${best} · ${pct}%${trig}`;
                                        })()}
                                    </span>
                                ) : null}

                                <span className="pill">Top 6</span>
                            </div>
                        </div>

                        <div style={{ height: 10 }} />

                        <ul className="list">
                            {(() => {
                                const base = blocksTop.slice(0, 6);
                                const head = base.slice(0, 4);
                                const used = new Set<number>(head.map((x) => x.index));

                                const extra = (embedSignals as any)?.blockTop ? (embedSignals as any).blockTop : [];
                                const picks: any[] = [];

                                if (preview && Array.isArray(preview.messageSummaries)) {
                                    for (const e of extra) {
                                        const idx = Number((e as any)?.index || 0);
                                        if (!idx || used.has(idx)) continue;

                                        const mm = preview.messageSummaries.find((x) => x.index === idx);
                                        if (mm) {
                                            picks.push(mm);
                                            used.add(idx);
                                        }
                                        if (picks.length >= 2) break;
                                    }
                                }

                                const tail: any[] = [];
                                for (const m of base) {
                                    if (used.has(m.index)) continue;
                                    tail.push(m);
                                    used.add(m.index);
                                    if (head.length + picks.length + tail.length >= 6) break;
                                }

                                const list = [...head, ...picks, ...tail].slice(0, 6);

                                return list.map((m: any) => {
                                    const actor = String((m as any)?.actorHint || "").trim();
                                    const speaker = String((m as any)?.speakerLabel || "").trim();

                                    const stageTriggers: string[] = Array.isArray((m as any)?.stageTriggers)
                                        ? (m as any).stageTriggers.map((x: any) => String(x || "").trim()).filter(Boolean)
                                        : [];

                                    const topRuleLabels: string[] = Array.isArray((m as any)?.topRules)
                                        ? (m as any).topRules
                                            .map((r: any) => String(r?.label || "").trim())
                                            .filter(Boolean)
                                        : [];

                                    const whyParts: string[] = [];
                                    if (stageTriggers.length) whyParts.push(`Triggers: ${stageTriggers.slice(0, 2).join(" · ")}`);
                                    if (topRuleLabels.length) whyParts.push(`Rules: ${topRuleLabels.slice(0, 2).join(" · ")}`);
                                    const whyText = whyParts.join(" · ");

                                    const emb = (embedSignals as any)?.byIndex?.[m.index] || null;
                                    const embPct = emb ? Math.round(Math.max(0, Math.min(1, Number(emb.sim || 0))) * 100) : 0;
                                    const embTitle = emb?.top?.length
                                        ? emb.top.map((x: any) => `${x.label} ${Math.round(Number(x.sim || 0) * 100)}%`).join(" | ")
                                        : "";

                                    // ✅ “룰/트리거 0인데도 임베딩만으로 후보” 표시
                                    const embOnly = !!emb && stageTriggers.length === 0 && topRuleLabels.length === 0;

                                    // ✅ URL 변형(MUT) 표기(있을 때만)
                                    const mutTags = detectUrlMutChips(
                                        String((m as any)?.text || (m as any)?.content || (m as any)?.preview || ""),
                                        Array.isArray((m as any)?.urls) ? ((m as any).urls as string[]) : undefined
                                    );
                                    const mutTitle = mutTags.length ? mutTags.join(" | ") : "";

                                    return (
                                        <li
                                            key={m.index}
                                            className={`click-row preview-block ${scoreCls(m.score)}`}
                                            role="button"
                                            tabIndex={0}
                                            onClick={() => onJumpBlock(m.index)}
                                        >
                                            <div className="row-between">
                                                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                                    <span className={`badge ${scoreCls(m.score)}`}>
                                                        BLK {m.index} · {m.score}/100
                                                    </span>
                                                    <span className={`badge ${stageBadge(m.stage).cls}`}>{stageBadge(m.stage).label}</span>

                                                    {actor ? (
                                                        <span
                                                            className={`badge ${actor === "demand" ? "bad" : actor === "comply" ? "warn" : "good"}`}
                                                        >
                                                            {actor.toUpperCase()}
                                                        </span>
                                                    ) : null}

                                                    {speaker ? <span className="pill">Speaker: {speaker}</span> : null}

                                                    {emb ? (
                                                        <span className="pill" title={embTitle || undefined}>
                                                            {embOnly ? "EMB-only" : "EMB"}: {String(emb.label || "n/a")} · {embPct}%
                                                        </span>
                                                    ) : null}

                                                    {mutTags.length ? (
                                                        <span className="pill" title={mutTitle || undefined}>
                                                            MUT: {mutTags.join(" · ")}
                                                        </span>
                                                    ) : null}
                                                </div>
                                            </div>

                                            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                                <div>{m.preview}</div>
                                                {whyText ? <div style={{ marginTop: 6 }}>{whyText}</div> : null}
                                            </div>
                                        </li>
                                    );
                                });
                            })()}
                        </ul>
                    </div>
                </>
            ) : null}

            {selected && (
                <>
                    <div style={{ height: 12 }} />
                    <div className="card detail-card">
                        <div className="row-between">
                            <div className="row" style={{ gap: 10 }}>
                                <span className={`badge ${scoreCls(selected.score)}`}>
                                    BLK {selected.index} · {selected.score}/100
                                </span>
                                <span className={`badge ${stageBadge(selected.stage).cls}`}>{stageBadge(selected.stage).label}</span>
                                {selected.stageTriggers.length ? (
                                    <span className="pill">Triggers: {selected.stageTriggers.join(" · ")}</span>
                                ) : (
                                    <span className="pill">Triggers: n/a</span>
                                )}

                                {(() => {
                                    const emb = (embedSignals as any)?.byIndex?.[selected.index] || null;
                                    if (!emb) return null;

                                    const pct = Math.round(Math.max(0, Math.min(1, Number(emb.sim || 0))) * 100);
                                    const title = emb?.top?.length
                                        ? emb.top.map((x: any) => `${x.label} ${Math.round(Number(x.sim || 0) * 100)}%`).join(" | ")
                                        : "";

                                    return (
                                        <span className="pill" title={title || undefined}>
                                            EMB: {String(emb.label || "n/a")} · {pct}%
                                        </span>
                                    );
                                })()}

                                {(() => {
                                    const mut = detectUrlMutChips(
                                        String(selectedRawText || selected.text || ""),
                                        Array.isArray(selected.urls) ? (selected.urls as string[]) : undefined
                                    );
                                    if (!mut.length) return null;
                                    const title = mut.join(" | ");
                                    return (
                                        <span className="pill" title={title || undefined}>
                                            MUT: {mut.join(" · ")}
                                        </span>
                                    );
                                })()}
                            </div>


                            <div className="row" style={{ gap: 8 }}>
                                <button className="btn" onClick={() => setSelectedBlock(null)}>
                                    Close
                                </button>
                                <button
                                    className="btn"
                                    onClick={() => {
                                        if (!taRef.current || !selectedRange) return;
                                        jumpByRange(taRef.current, selectedRange.start, selectedRange.end);
                                    }}
                                    disabled={!selectedRange}
                                >
                                    Jump
                                </button>
                            </div>
                        </div>

                        <div style={{ height: 10 }} />

                        <div className="grid2">
                            <div className="card" style={{ background: "var(--panel2)" }}>
                                <div className="card-title">원문</div>
                                <div className="card-desc">선택 블록 전체 텍스트</div>
                                <div style={{ height: 10 }} />
                                <div className="copybox detail-box">{selectedRawText || selected.text}</div>

                                <div style={{ height: 10 }} />
                                <div className="row">
                                    <button className="btn" onClick={() => void copyText(String(selectedRawText || selected.text || ""))}>
                                        Copy text
                                    </button>
                                    <button
                                        className="btn"
                                        onClick={() => {
                                            const t = selected.topRules
                                                .slice(0, 6)
                                                .map((r) => `- ${r.label} [${r.stage}] +${r.weight}`)
                                                .join("\n");
                                            void copyText(t || "n/a");
                                        }}
                                    >
                                        Copy top rules
                                    </button>
                                </div>
                            </div>

                            <div className="card" style={{ background: "var(--panel2)" }}>
                                <div className="card-title">메타</div>
                                <div className="card-desc">룰/URL 요약</div>
                                <div style={{ height: 10 }} />

                                <div className="pill">Top rules</div>
                                <div style={{ height: 8 }} />
                                {selected.topRules.length === 0 ? (
                                    <div className="muted">없음</div>
                                ) : (
                                    <ul className="list">
                                        {selected.topRules.slice(0, 6).map((r, i) => (
                                            <li key={`${r.label}-${i}`}>
                                                <b>{r.label}</b> <span className="muted">[{r.stage}] +{r.weight}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                <div style={{ height: 12 }} />

                                <div className="pill">URLs</div>
                                <div style={{ height: 8 }} />
                                {selected.urls.length === 0 ? (
                                    <div className="muted">없음</div>
                                ) : (
                                    <ul className="list">
                                        {selected.urls.slice(0, 10).map((u) => (
                                            <li key={u}>
                                                <a
                                                    href={u}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    onMouseEnter={() => setHoverUrl(u)}
                                                    onMouseLeave={() => setHoverUrl("")}
                                                    onClick={(ev) => {
                                                        ev.preventDefault();
                                                        ev.stopPropagation();
                                                        emitExplicitAction("openUrl", u);
                                                    }}
                                                    title="openUrl 이벤트(실제 이동 차단)"
                                                >
                                                    {u}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                <div style={{ height: 10 }} />
                                <div className="row">
                                    <button
                                        className="btn"
                                        onClick={() => void copyText((selected.urls || []).join("\n") || "n/a")}
                                        disabled={selected.urls.length === 0}
                                    >
                                        Copy URLs
                                    </button>
                                    <button
                                        className="btn"
                                        onClick={() => {
                                            const r = selectedRange;
                                            if (!r) return;
                                            void copyText(`BLK ${selected.index}\nrange: ${r.start}-${r.end}`);
                                        }}
                                        disabled={!selectedRange}
                                    >
                                        Copy range
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </>
            )}

            <div style={{ height: 12 }} />

            <div className="card" style={{ background: "var(--panel2)" }}>
                <div className="row-between">
                    <div>
                        <div className="card-title">Shortcuts</div>
                        <div className="card-desc">키보드로 빠르게 실행/닫기</div>
                    </div>
                    <span className="pill">Ctrl/Cmd+Enter · Analyze</span>
                </div>

                <div style={{ height: 10 }} />

                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                    <span className="pill">Esc · Close selected BLK</span>
                    <span className="pill">Click BLK · Jump + open detail</span>
                </div>
            </div>

            <div style={{ height: 12 }} />
        </div>
    );
}


