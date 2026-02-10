import React, { useEffect, useRef, useState } from "react";

type ActionResult = void | boolean;

type Props = {
    primaryLabel: string;
    onPrimary: () => ActionResult | Promise<ActionResult>;
    primaryDisabled?: boolean;
    primaryBusyLabel?: string;

    primaryFeedback?: boolean;
    primaryFeedbackOk?: string;
    primaryFeedbackFail?: string;

    secondaryLabel?: string;
    onSecondary?: () => ActionResult | Promise<ActionResult>;
    secondaryDisabled?: boolean;
    secondaryBusyLabel?: string;

    secondaryFeedback?: boolean;
    secondaryFeedbackOk?: string;
    secondaryFeedbackFail?: string;

    tertiaryLabel?: string;
    onTertiary?: () => ActionResult | Promise<ActionResult>;
    tertiaryDisabled?: boolean;
    tertiaryBusyLabel?: string;

    tertiaryFeedback?: boolean;
    tertiaryFeedbackOk?: string;
    tertiaryFeedbackFail?: string;
};

type Flash = { kind: "ok" | "fail"; text: string };

export function ActionButtons({
    primaryLabel,
    onPrimary,
    primaryDisabled,
    primaryBusyLabel = "Working…",
    primaryFeedback,
    primaryFeedbackOk = "복사됨",
    primaryFeedbackFail = "실패",

    secondaryLabel,
    onSecondary,
    secondaryDisabled,
    secondaryBusyLabel = "Working…",
    secondaryFeedback,
    secondaryFeedbackOk = "복사됨",
    secondaryFeedbackFail = "실패",

    tertiaryLabel,
    onTertiary,
    tertiaryDisabled,
    tertiaryBusyLabel = "Working…",
    tertiaryFeedback,
    tertiaryFeedbackOk = "복사됨",
    tertiaryFeedbackFail = "실패",
}: Props) {
    const [busyPrimary, setBusyPrimary] = useState(false);
    const [busySecondary, setBusySecondary] = useState(false);
    const [busyTertiary, setBusyTertiary] = useState(false);
    const [flash, setFlash] = useState<Flash | null>(null);

    const timerRef = useRef<number | null>(null);

    useEffect(() => {
        return () => {
            if (timerRef.current) window.clearTimeout(timerRef.current);
        };
    }, []);

    const showFlash = (kind: "ok" | "fail", text: string) => {
        setFlash({ kind, text });
        if (timerRef.current) window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(() => setFlash(null), 1200);
    };

    const autoOn = (label: string) => /copy|복사/i.test(label);

    const shouldFeedbackPrimary = primaryFeedback ?? autoOn(primaryLabel);
    const shouldFeedbackSecondary =
        secondaryLabel && onSecondary ? (secondaryFeedback ?? autoOn(secondaryLabel)) : false;
    const shouldFeedbackTertiary =
        tertiaryLabel && onTertiary ? (tertiaryFeedback ?? autoOn(tertiaryLabel)) : false;

    return (
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            <button
                type="button"
                className="btn btn-primary"
                disabled={!!primaryDisabled || busyPrimary}
                aria-busy={busyPrimary}
                onClick={async () => {
                    if (busyPrimary || primaryDisabled) return;
                    setBusyPrimary(true);
                    try {
                        const r = await onPrimary();
                        if (shouldFeedbackPrimary) {
                            const ok = r !== false;
                            showFlash(ok ? "ok" : "fail", ok ? primaryFeedbackOk : primaryFeedbackFail);
                        }
                    } catch {
                        if (shouldFeedbackPrimary) showFlash("fail", primaryFeedbackFail);
                    } finally {
                        setBusyPrimary(false);
                    }
                }}
            >
                {busyPrimary ? primaryBusyLabel : primaryLabel}
            </button>

            {secondaryLabel && onSecondary ? (
                <button
                    type="button"
                    className="btn"
                    disabled={!!secondaryDisabled || busySecondary}
                    aria-busy={busySecondary}
                    onClick={async () => {
                        if (busySecondary || secondaryDisabled) return;
                        setBusySecondary(true);
                        try {
                            const r = await onSecondary();
                            if (shouldFeedbackSecondary) {
                                const ok = r !== false;
                                showFlash(ok ? "ok" : "fail", ok ? secondaryFeedbackOk : secondaryFeedbackFail);
                            }
                        } catch {
                            if (shouldFeedbackSecondary) showFlash("fail", secondaryFeedbackFail);
                        } finally {
                            setBusySecondary(false);
                        }
                    }}
                >
                    {busySecondary ? secondaryBusyLabel : secondaryLabel}
                </button>
            ) : null}

            {tertiaryLabel && onTertiary ? (
                <button
                    type="button"
                    className="btn"
                    disabled={!!tertiaryDisabled || busyTertiary}
                    aria-busy={busyTertiary}
                    onClick={async () => {
                        if (busyTertiary || tertiaryDisabled) return;
                        setBusyTertiary(true);
                        try {
                            const r = await onTertiary();
                            if (shouldFeedbackTertiary) {
                                const ok = r !== false;
                                showFlash(ok ? "ok" : "fail", ok ? tertiaryFeedbackOk : tertiaryFeedbackFail);
                            }
                        } catch {
                            if (shouldFeedbackTertiary) showFlash("fail", tertiaryFeedbackFail);
                        } finally {
                            setBusyTertiary(false);
                        }
                    }}
                >
                    {busyTertiary ? tertiaryBusyLabel : tertiaryLabel}
                </button>
            ) : null}

            {flash ? <span className={`badge ${flash.kind === "ok" ? "good" : "warn"}`}>{flash.text}</span> : null}
        </div>
    );
}
