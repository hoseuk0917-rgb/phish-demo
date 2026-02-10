// src/components/RiskBadge.tsx
import React from "react";
import type { RiskLevel } from "../types/analysis";

type Props = {
    level: RiskLevel;
    score: number;
    // UI에서만 쓰는 약가산 표시(옵션)
    delta?: number;
    // 게이트/가산 출처 태그(옵션) - 예: "SIM", "COMPLY"
    tag?: string;
};

export function RiskBadge({ level, score, delta = 0, tag }: Props) {
    const lv: RiskLevel = level === "high" || level === "medium" || level === "low" ? level : "low";
    const cls = lv === "high" ? "bad" : lv === "medium" ? "warn" : "good";

    const s = Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0;
    const d = Number.isFinite(delta) ? Math.max(0, Math.min(100, Math.round(delta))) : 0;

    return (
        <span className={`badge ${cls}`} title={tag ? `Boost: ${tag}` : undefined}>
            {String(lv).toUpperCase()} · {s}/100
            {d > 0 ? (
                <span className="pill" style={{ marginLeft: 6 }}>
                    +{d}
                </span>
            ) : null}
            {tag ? (
                <span className="pill" style={{ marginLeft: 6 }}>
                    {String(tag)}
                </span>
            ) : null}
        </span>
    );
}
