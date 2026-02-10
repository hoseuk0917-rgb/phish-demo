import React from "react";

type Props = {
    label: string;
    checked: boolean;
    onChange: (v: boolean) => void;
};

export function ToggleRow({ label, checked, onChange }: Props) {
    return (
        <label className="row-between">
            <span className="muted">{label}</span>
            <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        </label>
    );
}
