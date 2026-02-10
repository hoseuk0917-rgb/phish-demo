// src/components/SimilarityPanel.tsx
import React from "react";
import type { AnalysisResult } from "../types/analysis";

type Match = NonNullable<AnalysisResult["similarityTop"]>[number];

function pct(x: number) {
    const n = Number.isFinite(x) ? x : 0;
    return `${Math.round(n * 100)}%`;
}

function riskBadge(r?: string) {
    const v = String(r || "").toLowerCase();
    if (v === "high") return { txt: "HIGH", cls: "badge bad" };
    if (v === "medium") return { txt: "MED", cls: "badge warn" };
    if (v === "low") return { txt: "LOW", cls: "badge good" };
    return { txt: "N/A", cls: "badge" };
}

export function SimilarityPanel(props: {
    enabled: boolean;
    loading?: boolean;
    error?: string | null;
    similarityTop?: Match[] | null;
}) {
    const enabled = !!props.enabled;
    const loading = !!props.loading;
    const err = props.error ? String(props.error) : "";
    const arr: Match[] = Array.isArray(props.similarityTop) ? props.similarityTop : [];

    if (!enabled) {
        return <div className="muted" style={{ fontSize: 12 }}>locked · waiting trigger</div>;
    }

    if (loading) {
        return <div className="muted" style={{ fontSize: 12 }}>loading simindex…</div>;
    }

    if (err) {
        return <div className="muted" style={{ fontSize: 12 }}>simindex error: {err}</div>;
    }

    if (!arr.length) {
        return <div className="muted" style={{ fontSize: 12 }}>no match</div>;
    }

    const maxSim = Math.max(...arr.map((x) => Number(x.similarity) || 0), 0);

    return (
        <div style={{ display: "grid", gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                <div className="muted" style={{ fontSize: 12 }}>top match: {pct(maxSim)}</div>
                <div style={{ width: 110 }}>
                    <div style={{ height: 8, borderRadius: 999, background: "rgba(255,255,255,0.10)", overflow: "hidden" }}>
                        <div style={{ height: 8, width: `${Math.max(0, Math.min(100, Math.floor(maxSim * 100)))}%`, background: "rgba(255,255,255,0.70)" }} />
                    </div>
                </div>
            </div>

            <div style={{ display: "grid", gap: 8 }}>
                {arr.slice(0, 6).map((m, i) => {
                    const b = riskBadge(m.expectedRisk);
                    return (
                        <div
                            key={`${m.id}-${i}`}
                            style={{
                                border: "1px solid rgba(255,255,255,0.14)",
                                background: "rgba(0,0,0,0.20)",
                                borderRadius: 12,
                                padding: "8px 10px",
                            }}
                        >
                            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                                    <div style={{ fontWeight: 900, letterSpacing: 0.2, whiteSpace: "nowrap" }}>{m.id}</div>
                                    {m.category ? <div className="muted" style={{ fontSize: 12, whiteSpace: "nowrap" }}>{m.category}</div> : null}
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span className={b.cls}>{b.txt}</span>
                                    <span className="pill">{pct(m.similarity)}</span>
                                </div>
                            </div>

                            {Array.isArray(m.sharedSignals) && m.sharedSignals.length ? (
                                <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                                    {m.sharedSignals.slice(0, 6).map((s, j) => (
                                        <span
                                            key={j}
                                            style={{
                                                fontSize: 11,
                                                padding: "3px 8px",
                                                borderRadius: 999,
                                                border: "1px solid rgba(255,255,255,0.14)",
                                                background: "rgba(255,255,255,0.06)",
                                                color: "rgba(255,255,255,0.85)",
                                            }}
                                        >
                                            {s}
                                        </span>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
