import React from "react";
import type { EvidenceItem } from "../types/analysis";

type Props = {
    items: EvidenceItem[];
};

export function EvidenceList({ items }: Props) {
    if (!items || items.length === 0) {
        return <div className="muted">표시할 증거가 없습니다.</div>;
    }

    return (
        <ul className="list">
            {items.map((it, idx) => (
                <li key={idx}>
                    <span className="pill" style={{ marginRight: 8 }}>
                        {it.kind} · {it.severity}
                    </span>
                    {it.text}
                </li>
            ))}
        </ul>
    );
}