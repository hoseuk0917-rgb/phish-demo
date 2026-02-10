import type { ActionItem } from "../types/analysis";

export function buildDefaultActions(): ActionItem[] {
  return [
    {
      id: "call-112",
      label: "Call 112 (Police)",
      kind: "call",
      href: "tel:112",
      note: "If money transfer or install happened, call immediately.",
    },
    {
      id: "call-1332",
      label: "Call 1332 (FSS)",
      kind: "call",
      href: "tel:1332",
      note: "Financial scam 상담/제보",
    },
    {
      id: "call-118",
      label: "Call 118 (KISA)",
      kind: "call",
      href: "tel:118",
      note: "Malicious link / hacking incident 상담",
    },
    {
      id: "freeze",
      label: "Freeze account / card",
      kind: "info",
      note: "Bank/issuer official channel only. Stop OTP sharing.",
    },
    {
      id: "device",
      label: "Check device for remote app",
      kind: "info",
      note: "Uninstall unknown apps, revoke accessibility/administrator permissions.",
    },
    {
      id: "copy-pack",
      label: "Copy report package",
      kind: "info",
      note: "Use the package in Result page templates (112/1332/carrier).",
    },
  ];
}
