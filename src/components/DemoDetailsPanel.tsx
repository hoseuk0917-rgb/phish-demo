import React, { useMemo, useState } from "react";

export type DetailsTab = {
    key: string;
    label: string;
    badge?: string; // e.g. "Top 6", "NEW"
    content: React.ReactNode;
};

type Props = {
    open: boolean;
    onClose: () => void;
    tabs: DetailsTab[];
    defaultTabKey?: string;
    title?: string;
    style?: React.CSSProperties;
};

function safeKey(k: any) {
    return String(k || "").trim();
}

export function DemoDetailsPanel({ open, onClose, tabs, defaultTabKey, title = "Details", style }: Props) {
    const normalizedTabs = useMemo(() => {
        return Array.isArray(tabs)
            ? tabs
                .map((t) => ({
                    key: safeKey(t.key),
                    label: String(t.label || "").trim(),
                    badge: t.badge ? String(t.badge) : "",
                    content: t.content,
                }))
                .filter((t) => t.key && t.label)
            : [];
    }, [tabs]);

    const firstKey = normalizedTabs[0]?.key || "";
    const [tab, setTab] = useState<string>(() => safeKey(defaultTabKey) || firstKey);

    const active = normalizedTabs.find((t) => t.key === tab) || normalizedTabs[0];

    if (!open) return null;

    return (
        <div
            className="card"
            style={{
                width: "100%",
                background: "rgba(0,0,0,0.55)",
                border: "1px solid rgba(255,255,255,0.12)",
                ...style,
            }}
        >
            <div className="row-between" style={{ alignItems: "center", gap: 10 }}>
                <div>
                    <div className="card-title">{title}</div>
                    <div className="card-desc">analysis result / method</div>
                </div>
                <button type="button" className="btn" onClick={onClose}>
                    Close
                </button>
            </div>

            <div style={{ height: 10 }} />

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {normalizedTabs.map((t) => {
                    const isOn = t.key === active?.key;
                    return (
                        <button
                            key={t.key}
                            type="button"
                            className="btn"
                            onClick={() => setTab(t.key)}
                            style={{
                                opacity: isOn ? 1 : 0.75,
                                border: isOn ? "1px solid rgba(255,255,255,0.28)" : "1px solid rgba(255,255,255,0.10)",
                                background: isOn ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.04)",
                                display: "inline-flex",
                                alignItems: "center",
                                gap: 8,
                            }}
                        >
                            <span>{t.label}</span>
                            {t.badge ? <span className="pill">{t.badge}</span> : null}
                        </button>
                    );
                })}
            </div>

            <div style={{ height: 10 }} />

            <div
                className="card"
                style={{
                    background: "rgba(255,255,255,0.06)",
                    maxHeight: 520,
                    overflow: "auto",
                }}
            >
                {active ? active.content : <div className="muted">no content</div>}
            </div>
        </div>
    );
}
