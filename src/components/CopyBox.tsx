import React, { useEffect, useMemo, useRef, useState } from "react";
import { copyText } from "../utils/clipboard";

type Props = {
    text: string;
    copyable?: boolean;
    copyLabel?: string;
    copiedLabel?: string;
    failedLabel?: string;
};

export function CopyBox({
    text,
    copyable = true,
    copyLabel = "Copy",
    copiedLabel = "Copied",
    failedLabel = "Copy failed",
}: Props) {
    const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
    const timerRef = useRef<number | null>(null);

    const canCopy = useMemo(() => !!String(text || "").trim(), [text]);

    useEffect(() => {
        return () => {
            if (timerRef.current) window.clearTimeout(timerRef.current);
        };
    }, []);

    const runCopy = async () => {
        if (!canCopy) return;
        const ok = await copyText(text);
        setStatus(ok ? "copied" : "failed");

        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setStatus("idle"), 1400);
    };

    const statusText =
        status === "copied" ? copiedLabel : status === "failed" ? failedLabel : "";

    return (
        <div className="copybox">
            <div className="row-between" style={{ gap: 10, alignItems: "center", marginBottom: 8 }}>
                <span className="muted" style={{ fontSize: 12 }}>
                    {statusText}
                </span>

                {copyable ? (
                    <button
                        className={`btn ${status === "copied" ? "btn-primary" : ""}`}
                        disabled={!canCopy}
                        onClick={() => void runCopy()}
                    >
                        {status === "copied" ? copiedLabel : copyLabel}
                    </button>
                ) : null}
            </div>

            <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{text}</div>
        </div>
    );
}
