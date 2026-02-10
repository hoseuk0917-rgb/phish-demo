// src/pages/ResultPage.tsx
import React, { useMemo, useState } from "react";
import type { AnalysisInput, AnalysisResult, StageId } from "../types/analysis";
import { analyzeThread } from "../engine";
import { RiskBadge } from "../components/RiskBadge";
import { EvidenceList } from "../components/EvidenceList";
import { CopyBox } from "../components/CopyBox";
import { ActionButtons } from "../components/ActionButtons";
import { copyText } from "../utils/clipboard";
import { shareText } from "../utils/share";

type TemplateId = "base" | "police112" | "fss1332" | "carrier";

const STAGE_RANK: Record<StageId, number> = {
    info: 0,
    verify: 1,
    install: 2,
    payment: 3,
};

function msgLevel(score: number): "good" | "warn" | "bad" {
    if (score >= 60) return "bad";
    if (score >= 30) return "warn";
    return "good";
}

function stageBadge(stage: StageId): { cls: "good" | "warn" | "bad"; label: string } {
    if (stage === "payment") return { cls: "bad", label: "PAYMENT" };
    if (stage === "install") return { cls: "warn", label: "INSTALL" };
    if (stage === "verify") return { cls: "warn", label: "VERIFY" };
    return { cls: "good", label: "INFO" };
}

function clampText(s: string, max = 600) {
    const t = (s || "").replace(/\r\n/g, "\n").trim();
    if (t.length <= max) return t;
    return t.slice(0, max) + " …";
}

function nowStampKstLike() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

function getThreatScore(r: any): number {
    const n = Number(r?.scoreTotal ?? 0);
    return Number.isFinite(n) ? n : 0;
}
function getThreatRisk(r: any): string {
    return String(r?.riskLevel ?? "").toUpperCase();
}

function getUiScore(r: any): number {
    const n = Number(r?.uiScoreTotal ?? r?.scoreTotal ?? 0);
    return Number.isFinite(n) ? n : 0;
}
function getUiRisk(r: any): string {
    return String(r?.uiRiskLevel ?? r?.riskLevel ?? "").toUpperCase();
}
function getUiDelta(r: any): number {
    const base = getThreatScore(r);
    const ui = getUiScore(r);
    const d = ui - base;
    return d > 0 ? Math.round(d) : 0;
}
function getUiTag(r: any): string {
    return String(r?.rGateTag ?? "").trim();
}

function pickFocusBlock(r: any, selected: any | null) {
    if (selected) return selected;
    const arr = Array.isArray(r.messageSummaries) ? r.messageSummaries : [];
    if (!arr.length) return null;
    const top = [...arr].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    return top || null;
}

function resolveBlockIndex(r: any, idx: number) {
    const arr = Array.isArray(r.messageSummaries) ? r.messageSummaries : [];
    if (arr.some((m: any) => m?.index === idx)) return idx;
    if (arr.some((m: any) => m?.index === idx + 1)) return idx + 1;
    if (arr.some((m: any) => m?.index === idx - 1)) return idx - 1;
    return idx;
}

function findBlock(r: any, selectedBlock: number | null) {
    if (selectedBlock == null) return null;
    const arr = Array.isArray(r.messageSummaries) ? r.messageSummaries : [];
    if (!arr.length) return null;
    return (
        arr.find((m: any) => m?.index === selectedBlock) ||
        arr.find((m: any) => m?.index === selectedBlock + 1) ||
        arr.find((m: any) => m?.index === selectedBlock - 1) ||
        null
    );
}

function buildPackageWithSelected(base: string, selected: any) {
    const lines: string[] = [];
    lines.push((base || "").trim());
    lines.push("");
    lines.push("----");
    lines.push("[Selected Block]");
    lines.push(`BLK ${selected.index} · ${selected.score}/100 · ${String(selected.stage).toUpperCase()}`);
    lines.push(
        `Triggers: ${(selected.stageTriggers || []).length ? selected.stageTriggers.join(" / ") : "n/a"}`
    );

    const urls: string[] = Array.isArray(selected.urls) ? selected.urls : [];
    lines.push(`URLs: ${urls.length ? urls.join(" ") : "n/a"}`);

    const speaker = String(selected.speakerLabel || "").trim();
    const actor = String(selected.actorHint || "").trim();
    const header = String(selected.header || "").trim();

    lines.push(`Speaker: ${speaker || "n/a"}`);
    lines.push(`Actor: ${actor ? actor.toUpperCase() : "n/a"}`);
    lines.push(`Header: ${header || "n/a"}`);

    lines.push("");
    lines.push("[Block Text]");
    lines.push(clampText(String(selected.content || selected.text || ""), 900));

    return lines.join("\n").trim() + "\n";
}

function buildReportTemplate(
    template: TemplateId,
    input: AnalysisInput,
    r: any,
    basePack: string,
    selected: any | null
) {
    if (template === "base") return basePack;

    const focus = pickFocusBlock(r, selected);
    const urls = Array.isArray(r.urls) ? r.urls : [];
    const hitsTop = Array.isArray(r.hitsTop) ? r.hitsTop : [];
    const stageTimeline = Array.isArray(r.stageTimeline) ? r.stageTimeline : [];
    const evidenceTop3 = Array.isArray(r.evidenceTop3) ? r.evidenceTop3 : [];

    const uiRisk = getUiRisk(r);
    const uiScore = getUiScore(r);
    const baseRisk = getThreatRisk(r);
    const baseScore = getThreatScore(r);
    const delta = getUiDelta(r);
    const tag = getUiTag(r);
    const deltaLabel = delta > 0 ? ` +${delta}${tag ? ` ${tag}` : ""}` : tag ? ` ${tag}` : "";

    const call = input.callChecks || { otpAsked: false, remoteAsked: false, urgentPressured: false };
    const callFlags = [
        call.otpAsked ? "OTP요구" : null,
        call.remoteAsked ? "원격유도" : null,
        call.urgentPressured ? "긴급/압박" : null,
    ].filter(Boolean);

    const focusLine = focus
        ? `BLK ${focus.index} · ${focus.score}/100 · ${String(focus.stage).toUpperCase()} · Triggers: ${(focus.stageTriggers || []).length ? focus.stageTriggers.join(" / ") : "n/a"
        }`
        : "BLK: n/a";

    const focusBody = focus ? String(focus.content || focus.text || "") : "";
    const focusText = focus ? clampText(focusBody, 700) : "n/a";
    const focusUrls = focus && Array.isArray(focus.urls) && focus.urls.length ? focus.urls : [];

    const timelineMini = stageTimeline
        .slice(0, 8)
        .map((e: any) => `- ${String(e.stage).toUpperCase()} @ BLK ${e.blockIndex} · ${e.score}/100`)
        .join("\n");

    const rulesMini = hitsTop
        .slice(0, 10)
        .map((h: any) => `- ${h.label} [${h.stage}] +${h.weight}`)
        .join("\n");

    const evidenceMini = evidenceTop3
        .slice(0, 3)
        .map((ev: any, i: number) => `- (${i + 1}) [${String(ev.kind).toUpperCase()}] ${clampText(ev.text, 220)}`)
        .join("\n");

    const lines: string[] = [];
    const stamp = nowStampKstLike();

    if (template === "police112") {
        lines.push("[112 신고 요약 템플릿]");
        lines.push(`작성시각: ${stamp}`);
        lines.push("");
        lines.push("1) 상황 요약");
        lines.push(`- 의심유형: 스미싱/보이스피싱 의심`);
        lines.push(`- 위험도(UI): ${uiRisk} (${uiScore}/100)${deltaLabel ? ` · Δ${deltaLabel}` : ""}`);
        lines.push(`- 위험도(Threat): ${baseRisk} (${baseScore}/100)`);
        lines.push(`- 통화/대화 신호: ${callFlags.length ? callFlags.join(", ") : "없음/미확인"}`);
        lines.push("");
        lines.push("2) 핵심 근거(원문 일부)");
        lines.push(`- 포커스: ${focusLine}`);
        lines.push(focusText ? `- 원문: ${focusText}` : "- 원문: n/a");
        lines.push("");
        lines.push("3) URL/링크");
        lines.push(`- 스레드 전체 URL: ${urls.length ? urls.join("\n  ") : "없음"}`);
        lines.push(`- 포커스 URL: ${focusUrls.length ? focusUrls.join("\n  ") : "없음"}`);
        lines.push("");
        lines.push("4) 피해 여부");
        lines.push("- 금전이체/인증정보 제공/원격앱 설치 여부: (작성자가 체크)");
        lines.push("- 계좌번호/수취인/이체시간: (있으면 기재)");
        lines.push("");
        lines.push("5) 추가 참고(자동 추출)");
        lines.push(evidenceMini ? evidenceMini : "- n/a");
        lines.push("");
        lines.push("6) 타임라인(요약)");
        lines.push(timelineMini ? timelineMini : "- n/a");
        lines.push("");
        lines.push("7) 원문 전체(필요 시 첨부)");
        lines.push("- 아래 텍스트/캡처/통화기록 등을 함께 제출");
        lines.push("");
        lines.push("----");
        lines.push("[Base Package]");
        lines.push((basePack || "").trim());
        return lines.join("\n").trim() + "\n";
    }

    if (template === "fss1332") {
        lines.push("[금감원 1332 제보/상담 템플릿]");
        lines.push(`작성시각: ${stamp}`);
        lines.push("");
        lines.push("1) 요약");
        lines.push(`- 유형: 금융사칭/대출/투자/결제 유도 등 보이스피싱·스미싱 의심`);
        lines.push(`- 위험도(UI): ${uiRisk} (${uiScore}/100)${deltaLabel ? ` · Δ${deltaLabel}` : ""}`);
        lines.push(`- 위험도(Threat): ${baseRisk} (${baseScore}/100)`);
        lines.push(`- 통화/대화 신호: ${callFlags.length ? callFlags.join(", ") : "없음/미확인"}`);
        lines.push("");
        lines.push("2) 사칭/유도 내용(원문 일부)");
        lines.push(`- 포커스: ${focusLine}`);
        lines.push(focusText ? `- 원문: ${focusText}` : "- 원문: n/a");
        lines.push("");
        lines.push("3) 링크/앱 설치 유도 여부");
        lines.push(`- URL: ${urls.length ? urls.join("\n  ") : "없음"}`);
        lines.push(`- 원격앱/설치유도 체크: ${call.remoteAsked ? "예(의심)" : "아니오/미확인"}`);
        lines.push("");
        lines.push("4) 금전·개인정보 제공 여부");
        lines.push("- 계좌이체/카드정보/인증번호/신분증 등 제공 여부: (작성자가 체크)");
        lines.push("");
        lines.push("5) 자동 요약(룰 히트)");
        lines.push(rulesMini ? rulesMini : "- n/a");
        lines.push("");
        lines.push("6) 타임라인(요약)");
        lines.push(timelineMini ? timelineMini : "- n/a");
        lines.push("");
        lines.push("----");
        lines.push("[Base Package]");
        lines.push((basePack || "").trim());
        return lines.join("\n").trim() + "\n";
    }

    // carrier
    lines.push("[통신사/스팸 신고 템플릿]");
    lines.push(`작성시각: ${stamp}`);
    lines.push("");
    lines.push("1) 신고 목적");
    lines.push("- 스미싱/악성 URL 포함 메시지 차단·분석 요청");
    lines.push("");
    lines.push("2) 발신 정보");
    lines.push("- 발신번호(있으면):");
    lines.push("- 수신일시(대략):");
    lines.push("");
    lines.push("3) 메시지 원문(핵심 부분)");
    lines.push(`- 포커스: ${focusLine}`);
    lines.push(focusText ? `- 원문: ${focusText}` : "- 원문: n/a");
    lines.push("");
    lines.push("4) 포함된 URL");
    lines.push(`- URL: ${urls.length ? urls.join("\n  ") : "없음"}`);
    lines.push("");
    lines.push("5) 참고");
    lines.push(`- 위험도(UI): ${uiRisk} (${uiScore}/100)${deltaLabel ? ` · Δ${deltaLabel}` : ""}`);
    lines.push(`- 위험도(Threat): ${baseRisk} (${baseScore}/100)`);
    lines.push(evidenceMini ? evidenceMini : "- n/a");
    lines.push("");
    lines.push("6) 타임라인(요약)");
    lines.push(timelineMini ? timelineMini : "- n/a");
    lines.push("");
    lines.push("----");
    lines.push("[Base Package]");
    lines.push((basePack || "").trim());
    return lines.join("\n").trim() + "\n";
}

export function ResultPage(props: {
    input: AnalysisInput;
    result: AnalysisResult | null;
    onBack: () => void;
    onReanalyze: (input: AnalysisInput, result: AnalysisResult) => void;
}) {
    const { input, result, onBack, onReanalyze } = props;

    const engineOpts: any = (input as any)?.engineOpts;
    const safeResult = useMemo(() => result ?? analyzeThread(input, engineOpts), [result, input, engineOpts]);
    const r: any = safeResult as any;

    const [selectedBlock, setSelectedBlock] = useState<number | null>(null);
    const [template, setTemplate] = useState<TemplateId>("base");

    const selected = useMemo(() => {
        return findBlock(r, selectedBlock);
    }, [r, selectedBlock]);

    const blocksTop = useMemo(() => {
        const arr = Array.isArray(r.messageSummaries) ? r.messageSummaries : [];
        return [...arr].sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 12);
    }, [r]);

    const basePack = useMemo(() => {
        if (!selected) return String(r.packageText || "");
        return buildPackageWithSelected(String(r.packageText || ""), selected);
    }, [r, selected]);

    const packageText = useMemo(() => {
        return buildReportTemplate(template, input, r, basePack, selected);
    }, [template, input, r, basePack, selected]);

    const urls = Array.isArray(r.urls) ? r.urls : [];
    const hitsTop = Array.isArray(r.hitsTop) ? r.hitsTop : [];
    const stageTimeline = Array.isArray(r.stageTimeline) ? r.stageTimeline : [];
    const evidenceTop3 = Array.isArray(r.evidenceTop3) ? r.evidenceTop3 : [];

    const signalsTop = Array.isArray(r.signalsTop)
        ? r.signalsTop
        : Array.isArray(r.signals)
            ? r.signals
            : [];

    const stagePeak = useMemo(() => {
        if (!stageTimeline.length) return null;
        let peak = stageTimeline[0];
        for (const e of stageTimeline) {
            const a = STAGE_RANK[String(e?.stage || "info") as StageId] ?? 0;
            const b = STAGE_RANK[String(peak?.stage || "info") as StageId] ?? 0;
            if (a > b) peak = e;
        }
        return peak || null;
    }, [stageTimeline]);

    const uiRisk = getUiRisk(r);
    const uiScore = getUiScore(r);
    const delta = getUiDelta(r);
    const tag = getUiTag(r);

    return (
        <div className="card">
            <div className="card-header">
                <div>
                    <div className="card-title">분석 결과</div>
                    <div className="card-desc">
                        {selected ? `BLK ${selected.index} 선택됨 · ` : ""}
                        템플릿:{" "}
                        {template === "base"
                            ? "BASE"
                            : template === "police112"
                                ? "112"
                                : template === "fss1332"
                                    ? "1332"
                                    : "통신사"}
                        {stagePeak ? (
                            <>
                                {" "}
                                · Peak: {String(stagePeak.stage).toUpperCase()} @ BLK{" "}
                                {resolveBlockIndex(r, Number(stagePeak.blockIndex))}
                            </>
                        ) : null}
                    </div>
                </div>

                <RiskBadge level={uiRisk as any} score={uiScore as any} delta={delta} tag={tag} />
            </div>

            {selected && (
                <>
                    <div style={{ height: 12 }} />
                    <div className="card detail-card">
                        <div className="row-between">
                            <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
                                <span className={`badge ${msgLevel(selected.score)}`}>
                                    BLK {selected.index} · {selected.score}/100
                                </span>
                                <span className={`badge ${stageBadge(selected.stage).cls}`}>
                                    {stageBadge(selected.stage).label}
                                </span>

                                {selected.actorHint ? (
                                    <span
                                        className={`badge ${selected.actorHint === "demand"
                                            ? "bad"
                                            : selected.actorHint === "comply"
                                                ? "warn"
                                                : "good"
                                            }`}
                                    >
                                        {String(selected.actorHint).toUpperCase()}
                                    </span>
                                ) : null}

                                {selected.speakerLabel ? (
                                    <span className="pill">Speaker: {selected.speakerLabel}</span>
                                ) : null}

                                {selected.stageTriggers?.length ? (
                                    <span className="pill">Triggers: {selected.stageTriggers.join(" · ")}</span>
                                ) : (
                                    <span className="pill">Triggers: n/a</span>
                                )}
                            </div>

                            <div className="row" style={{ gap: 8 }}>
                                <button className="btn" onClick={() => setSelectedBlock(null)}>
                                    Close
                                </button>
                                <button
                                    className="btn"
                                    onClick={() => void copyText(String(selected.content || selected.text || ""))}
                                >
                                    Copy text
                                </button>
                            </div>
                        </div>

                        <div style={{ height: 10 }} />

                        <div className="grid2">
                            <div className="card" style={{ background: "var(--panel2)" }}>
                                <div className="card-title">원문</div>
                                <div className="card-desc">선택 블록 전체 텍스트</div>
                                <div style={{ height: 10 }} />

                                {selected.header ? (
                                    <div className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                                        {selected.header}
                                    </div>
                                ) : null}

                                <div className="copybox detail-box">
                                    {String(selected.content || selected.text || "")}
                                </div>

                                <div style={{ height: 10 }} />

                                <div className="row">
                                    <button
                                        className="btn"
                                        onClick={() => {
                                            const t = (selected.topRules || [])
                                                .slice(0, 8)
                                                .map((rr: any) => `- ${rr.label} [${rr.stage}] +${rr.weight}`)
                                                .join("\n");
                                            void copyText(t || "n/a");
                                        }}
                                    >
                                        Copy top rules
                                    </button>

                                    <button
                                        className="btn"
                                        disabled={!selected.urls?.length}
                                        onClick={() => void copyText((selected.urls || []).join("\n") || "n/a")}
                                    >
                                        Copy URLs
                                    </button>
                                </div>
                            </div>

                            <div className="card" style={{ background: "var(--panel2)" }}>
                                <div className="card-title">메타</div>
                                <div className="card-desc">룰/URL 요약</div>
                                <div style={{ height: 10 }} />

                                <div className="pill">Top rules</div>
                                <div style={{ height: 8 }} />
                                {!selected.topRules?.length ? (
                                    <div className="muted">없음</div>
                                ) : (
                                    <ul className="list">
                                        {(selected.topRules || []).slice(0, 10).map((rr: any, i: number) => (
                                            <li key={`${rr.label}-${i}`}>
                                                <b>{rr.label}</b>{" "}
                                                <span className="muted">[{rr.stage}] +{rr.weight}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}

                                <div style={{ height: 12 }} />

                                <div className="pill">URLs</div>
                                <div style={{ height: 8 }} />
                                {!selected.urls?.length ? (
                                    <div className="muted">없음</div>
                                ) : (
                                    <ul className="list">
                                        {(selected.urls || []).slice(0, 12).map((u: string) => (
                                            <li key={u}>
                                                <a href={u} target="_blank" rel="noreferrer">
                                                    {u}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>
                    </div>
                </>
            )}

            <div style={{ height: 12 }} />

            <div className="grid2">
                <div className="card" style={{ background: "var(--panel2)" }}>
                    <div className="card-title">전환점 타임라인</div>
                    <div className="card-desc">클릭하면 해당 BLK 원문 카드가 펼쳐짐</div>
                    <div style={{ height: 10 }} />

                    {!stageTimeline.length ? (
                        <div className="muted">타임라인 이벤트가 없습니다.</div>
                    ) : (
                        <ul className="list">
                            {stageTimeline.map((e: any, i: number) => {
                                const b = stageBadge(e.stage);
                                const resolved = resolveBlockIndex(r, Number(e.blockIndex));
                                const active = selectedBlock === resolved;

                                return (
                                    <li
                                        key={`${e.blockIndex}-${i}`}
                                        className={`click-row ${active ? "active" : ""}`}
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => setSelectedBlock(resolved)}
                                    >
                                        <span className={`badge ${b.cls}`} style={{ marginRight: 8 }}>
                                            {b.label}
                                        </span>
                                        <span className="muted">
                                            BLK {resolved} · {e.score}/100
                                        </span>

                                        {e.triggers?.length ? (
                                            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                                트리거: {e.triggers.join(" · ")}
                                            </div>
                                        ) : null}

                                        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                            {e.preview}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    )}

                    <div style={{ height: 10 }} />

                    <ActionButtons
                        primaryLabel="Copy timeline"
                        onPrimary={async () => {
                            const t = stageTimeline
                                .map((e: any) => {
                                    const trig = e.triggers?.length ? ` (${e.triggers.join(" / ")})` : "";
                                    const resolved = resolveBlockIndex(r, Number(e.blockIndex));
                                    return `- ${String(e.stage).toUpperCase()} @ BLK ${resolved} · ${e.score}/100${trig}`;
                                })
                                .join("\n");
                            return await copyText(t);
                        }}
                        secondaryLabel="Back"
                        onSecondary={onBack}
                    />
                </div>

                <div className="card" style={{ background: "var(--panel2)" }}>
                    <div className="card-title">핵심 증거(Top 3)</div>
                    <div className="card-desc">가중치가 큰 룰 히트 위주</div>
                    <div style={{ height: 10 }} />
                    <EvidenceList items={evidenceTop3} />

                    <div style={{ height: 14 }} />

                    <div className="card-title">신호 요약</div>
                    <div className="card-desc">히트 묶음(룰ID 단위)</div>
                    <div style={{ height: 10 }} />

                    {!signalsTop.length ? (
                        <div className="muted">없음</div>
                    ) : (
                        <ul className="list">
                            {signalsTop.slice(0, 10).map((s: any) => (
                                <li key={String(s.id || s.label)}>
                                    <b>{s.label}</b>{" "}
                                    <span className="muted">
                                        [{String(s.stage || "info")}] Σ{s.weightSum} · x{s.count}
                                    </span>
                                    {Array.isArray(s.examples) && s.examples.length ? (
                                        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                                            예: {s.examples.slice(0, 3).join(" / ")}
                                        </div>
                                    ) : null}
                                </li>
                            ))}
                        </ul>
                    )}

                    <div style={{ height: 10 }} />

                    <ActionButtons
                        primaryLabel="Copy signals"
                        onPrimary={async () => {
                            const t = signalsTop
                                .slice(0, 12)
                                .map((s: any) => {
                                    const ex =
                                        Array.isArray(s.examples) && s.examples.length
                                            ? ` (${s.examples.slice(0, 3).join(" / ")})`
                                            : "";
                                    return `- ${String(s.label)} [${String(s.stage || "info")}] Σ${s.weightSum} x${s.count
                                        }${ex}`;
                                })
                                .join("\n");
                            return await copyText(t || "n/a");
                        }}
                        secondaryLabel="Copy package"
                        onSecondary={async () => {
                            return await copyText(String(packageText || ""));
                        }}
                    />

                    <div style={{ height: 14 }} />

                    <div className="card-title">추천 조치</div>
                    <div className="card-desc">상황에 따라 버튼을 눌러 바로 이동/전화</div>
                    <div style={{ height: 10 }} />

                    {Array.isArray(r.actions) && r.actions.length ? (
                        <>
                            <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                                {r.actions.slice(0, 8).map((a: any) => {
                                    if (a.href) {
                                        return (
                                            <a
                                                key={a.id || a.href}
                                                className="btn"
                                                href={a.href}
                                                target={String(a.href).startsWith("tel:") ? undefined : "_blank"}
                                                rel={String(a.href).startsWith("tel:") ? undefined : "noreferrer"}
                                            >
                                                {a.label}
                                            </a>
                                        );
                                    }

                                    return (
                                        <button
                                            key={a.id || a.label}
                                            className="btn"
                                            onClick={() => void copyText(String(a.note || a.label || ""))}
                                        >
                                            {a.label}
                                        </button>
                                    );
                                })}
                            </div>

                            <div style={{ height: 10 }} />

                            <ActionButtons
                                primaryLabel="Copy actions"
                                onPrimary={async () => {
                                    const t = r.actions
                                        .slice(0, 12)
                                        .map((a: any) => {
                                            const href = a.href ? ` (${a.href})` : "";
                                            const note = a.note ? ` - ${String(a.note || "")}` : "";
                                            const label = String(a.label || "");
                                            return `- ${label}${href}${note}`;
                                        })
                                        .join("\n");
                                    return await copyText(t || "n/a");
                                }}
                                secondaryLabel="Back"
                                onSecondary={onBack}
                            />
                        </>
                    ) : (
                        <div className="muted">추천 조치가 없습니다.</div>
                    )}
                </div>
            </div>

            <div style={{ height: 12 }} />

            <div className="grid2">
                <div className="card" style={{ background: "var(--panel2)" }}>
                    <div className="card-title">메시지 블록별 위험(상위)</div>
                    <div className="card-desc">클릭하면 해당 BLK 원문 카드가 펼쳐짐</div>
                    <div style={{ height: 10 }} />

                    <ul className="list">
                        {blocksTop.map((m: any) => {
                            const lv = msgLevel(m.score);
                            const sb = stageBadge(m.stage);
                            const active = selectedBlock === m.index;

                            return (
                                <li
                                    key={m.index}
                                    className={`preview-block ${lv} click-row ${active ? "active" : ""}`}
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => setSelectedBlock(m.index)}
                                >
                                    <div className="row-between">
                                        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                                            <span className={`badge ${lv}`}>BLK {m.index} · {m.score}/100</span>
                                            <span className={`badge ${sb.cls}`}>{sb.label}</span>

                                            {m.actorHint ? (
                                                <span
                                                    className={`badge ${m.actorHint === "demand"
                                                        ? "bad"
                                                        : m.actorHint === "comply"
                                                            ? "warn"
                                                            : "good"
                                                        }`}
                                                >
                                                    {String(m.actorHint).toUpperCase()}
                                                </span>
                                            ) : null}

                                            {m.speakerLabel ? (
                                                <span className="pill">Speaker: {m.speakerLabel}</span>
                                            ) : null}
                                        </div>

                                        <button
                                            className="btn"
                                            onClick={(ev) => {
                                                ev.stopPropagation();
                                                void copyText(String(m.content || m.text || ""));
                                            }}
                                        >
                                            Copy
                                        </button>
                                    </div>

                                    {m.topRules?.length ? (
                                        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                            {(m.topRules || [])
                                                .map((rr: any) => `${rr.label}(+${rr.weight})`)
                                                .slice(0, 2)
                                                .join(" / ")}
                                        </div>
                                    ) : null}

                                    <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                        {m.preview}
                                    </div>

                                    {m.urls?.length ? (
                                        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                                            URL: {m.urls.join(" / ")}
                                        </div>
                                    ) : null}
                                </li>
                            );
                        })}
                    </ul>
                </div>

                <div className="card" style={{ background: "var(--panel2)" }}>
                    <div className="row-between">
                        <div>
                            <div className="card-title">복사 패키지</div>
                            <div className="card-desc">
                                {selected ? `선택 BLK ${selected.index} 포함 · ` : ""}
                                템플릿 버튼으로 신고용 포맷 전환
                            </div>
                        </div>
                        {selected ? (
                            <span className={`badge ${msgLevel(selected.score)}`}>BLK {selected.index} attached</span>
                        ) : (
                            <span className="pill">base</span>
                        )}
                    </div>

                    <div style={{ height: 10 }} />

                    <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                        <button
                            className={`btn ${template === "base" ? "btn-primary" : ""}`}
                            onClick={() => setTemplate("base")}
                        >
                            Base
                        </button>
                        <button
                            className={`btn ${template === "police112" ? "btn-primary" : ""}`}
                            onClick={() => setTemplate("police112")}
                        >
                            112
                        </button>
                        <button
                            className={`btn ${template === "fss1332" ? "btn-primary" : ""}`}
                            onClick={() => setTemplate("fss1332")}
                        >
                            1332
                        </button>
                        <button
                            className={`btn ${template === "carrier" ? "btn-primary" : ""}`}
                            onClick={() => setTemplate("carrier")}
                        >
                            통신사
                        </button>
                    </div>

                    <div style={{ height: 10 }} />

                    <CopyBox text={String(packageText || "")} />

                    <div style={{ height: 10 }} />

                    <ActionButtons
                        primaryLabel="Copy"
                        onPrimary={async () => {
                            return await copyText(String(packageText || ""));
                        }}
                        secondaryLabel="Share"
                        onSecondary={async () => {
                            return await shareText(String(packageText || ""), "phish-demo");
                        }}
                        tertiaryLabel="Back"
                        onTertiary={onBack}
                        secondaryFeedback={false}
                    />

                    <div style={{ height: 10 }} />

                    <ActionButtons
                        primaryLabel="Re-run (same input)"
                        onPrimary={() => {
                            const rr = analyzeThread(input, engineOpts);
                            onReanalyze(input, rr);
                        }}
                        secondaryLabel="Copy (again)"
                        onSecondary={async () => {
                            return await copyText(String(packageText || ""));
                        }}
                    />
                </div>
            </div>

            <div style={{ height: 12 }} />

            <div className="grid2">
                <div className="card" style={{ background: "var(--panel2)" }}>
                    <div className="card-title">룰 히트 (Top 30)</div>
                    <div className="card-desc">어떤 룰이 얼마나 강하게 잡혔는지</div>
                    <div style={{ height: 10 }} />

                    <ul className="list">
                        {hitsTop.slice(0, 30).map((h: any, i: number) => (
                            <li key={`${h.ruleId}-${i}`}>
                                <b>{h.label}</b> <span className="muted">[{h.stage}] +{h.weight}</span>
                                {h.matched?.length ? (
                                    <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                                        매칭: {h.matched.slice(0, 6).join(", ")}
                                    </div>
                                ) : null}
                                <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                                    예시: “{h.sample}”
                                </div>
                            </li>
                        ))}
                    </ul>
                </div>

                <div className="card" style={{ background: "var(--panel2)" }}>
                    <div className="card-title">추출된 URL</div>
                    <div className="card-desc">스레드 전체에서 뽑은 URL(중복 제거)</div>
                    <div style={{ height: 10 }} />

                    {!urls.length ? (
                        <div className="muted">URL이 없습니다.</div>
                    ) : (
                        <ul className="list">
                            {urls.map((u: string) => (
                                <li key={u}>
                                    <a href={u} target="_blank" rel="noreferrer">
                                        {u}
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}

                    <div style={{ height: 10 }} />

                    <ActionButtons
                        primaryLabel="Copy URLs"
                        onPrimary={async () => {
                            return await copyText(urls.join("\n"));
                        }}
                        secondaryLabel="Copy Top Hits"
                        onSecondary={async () => {
                            const t = hitsTop
                                .slice(0, 10)
                                .map((h: any) => `- ${h.label} [${h.stage}] +${h.weight}`)
                                .join("\n");
                            return await copyText(t);
                        }}
                    />
                </div>
            </div>
        </div>
    );
}
