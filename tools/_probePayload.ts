import { analyzeThread } from "../src/engine/index";

function toInput(p: any): any {
  if (typeof p === "string") return { threadText: p };

  if (p && typeof p === "object") {
    if (typeof p.threadText === "string") return { threadText: p.threadText };
    if (typeof p.thread === "string") return { threadText: p.thread };
    if (typeof p.rawThread === "string") return { threadText: p.rawThread };
    if (typeof p.rawThreadText === "string") return { threadText: p.rawThreadText };
    if (typeof p.text === "string") return { threadText: p.text };
    if (typeof p.prompt === "string") return { threadText: p.prompt };
    if (typeof p.input === "string") return { threadText: p.input };

    // messages 형태도 최소 지원(합쳐서 threadText로)
    if (Array.isArray(p.messages)) {
      const joined = p.messages
        .map((m: any) => String(m?.text ?? m?.content ?? "").trim())
        .filter(Boolean)
        .join("\n");
      return { threadText: joined };
    }
  }

  return { threadText: "" };
}

function errMsg(e: any): string {
  return String(e?.message ?? e);
}

const payloads: Record<string, any> = {
  string: "S: 계정 확인 필요합니다. 링크로 진행하세요.",
  threadText: { threadText: "S: 계정 확인 필요합니다. 링크로 진행하세요." },
  thread: { thread: "S: 계정 확인 필요합니다. 링크로 진행하세요." },
  rawThread: { rawThread: "S: 계정 확인 필요합니다. 링크로 진행하세요." },
  rawThreadText: { rawThreadText: "S: 계정 확인 필요합니다. 링크로 진행하세요." },
  text: { text: "S: 계정 확인 필요합니다. 링크로 진행하세요." },
  prompt: { prompt: "S: 계정 확인 필요합니다. 링크로 진행하세요." },
  input: { input: "S: 계정 확인 필요합니다. 링크로 진행하세요." },
  messages: {
    messages: [
      { role: "user", text: "S: 확인 필요" },
      { role: "assistant", text: "R: 뭐가요?" },
      { role: "user", text: "S: 링크 클릭" },
    ],
  },
};

for (const [name, p] of Object.entries(payloads)) {
  try {
    const res = await analyzeThread(toInput(p) as any);
    console.log(name, {
      scoreTotal: (res as any)?.scoreTotal,
      risk: (res as any)?.riskLevel,
      triggered: Boolean((res as any)?.triggered),
      hitsTopLen: ((res as any)?.hitsTop ?? []).length,
    });
  } catch (e: any) {
    console.log(name, "ERR", errMsg(e));
  }
}
