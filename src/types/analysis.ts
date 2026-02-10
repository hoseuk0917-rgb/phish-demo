// src/types/analysis.ts
export type RiskLevel = "low" | "medium" | "high";

export type StageId = "info" | "verify" | "install" | "payment";

export type EvidenceKind = "thread" | "message" | "call" | "link";

export interface EvidenceItem {
  kind: EvidenceKind;
  text: string;
  severity: RiskLevel;
}

export interface ActionItem {
  id: string;
  label: string;
  kind: "call" | "link" | "info";
  href?: string;
  note?: string;
}

export interface CallChecks {
  otpAsked: boolean;
  remoteAsked: boolean;
  urgentPressured: boolean;
  firstContact?: boolean;
}

export interface AnalysisInput {
  threadText: string;
  callChecks: CallChecks;
}

export interface SignalSummary {
  id: string;
  label: string;
  weightSum: number;
  count: number;
  examples: string[];
  stage?: StageId;
}

export interface HitItem {
  ruleId: string;
  label: string;
  stage: StageId;
  weight: number;
  matched: string[];
  sample: string;
}

export type ActorHint = "demand" | "comply" | "neutral" | "unknown";

export type SpeakerTag = "S" | "R" | "U";

export interface MessageSummary {
  index: number;

  // 원본 블록(헤더 포함 가능)
  text: string;

  // ✅ split 단계에서 잡힌 speaker(S/R/U)
  speaker?: SpeakerTag;

  // 헤더/화자/본문/맥락 힌트(있을 때만)
  header?: string;
  speakerLabel?: string;
  content?: string;
  actorHint?: ActorHint;

  preview: string;
  score: number;
  urls: string[];
  stage: StageId;
  stageTriggers: string[];
  topRules: { label: string; stage: StageId; weight: number }[];
}

export interface StageEvent {
  blockIndex: number;
  stage: StageId;
  score: number;
  triggers: string[];
  preview: string;
}

/**
 * Lightweight prefilter / trigger result
 * - full analysis 전에 “가볍게” 의심 신호만 스캔해서
 *   action(none/soft/auto)을 결정하기 위한 구조
 */
export type PrefilterAction = "none" | "soft" | "auto";

export type PrefilterSignal = {
  id: string;
  label: string;
  points: number;
  matches?: string[];
  evidence?: string;
};

export type PrefilterResult = {
  score: number;
  action: PrefilterAction;
  thresholdSoft: number;
  thresholdAuto: number;
  signals: PrefilterSignal[];
  combos: PrefilterSignal[];
  window: {
    blocksConsidered: number;
    charsConsidered: number;
  };
};

export type SimilarityTopItem = {
  id: string;
  label: string;
  similarity: number;
  category?: string;
  expectedRisk?: string;
  sharedSignals?: string[];
};

export type SimilarityMatch = {
  id: string;
  label: string;
  similarity: number;
  category?: string;
  expectedRisk?: string;
  sharedSignals?: string[];
};

export interface AnalysisResult {
  // base(Threat=S 기반) 결과
  riskLevel: RiskLevel;
  scoreTotal: number;

  // UI용(개입 타이밍/긴급도 반영) — Threat 점수는 그대로 두고 표시만 약하게 끌어올림
  uiRiskLevel?: RiskLevel;
  uiScoreTotal?: number;
  rGateTag?: string;

  // stage(표시/디버그용)
  stagePeak?: string;
  stageTriggers?: string[];

  messageCount: number;
  evidenceTop3: EvidenceItem[];
  signalsTop: SignalSummary[];
  actions: ActionItem[];
  packageText: string;

  hitsTop: HitItem[];
  urls: string[];

  messageSummaries: MessageSummary[];
  stageTimeline: StageEvent[];

  // optional: prefilter 결과(트리거/가벼운 실시간 감지용)
  prefilter?: PrefilterResult;

  // optional: similarity top-k (sparse simindex; signals 기반)
  similarityTop?: SimilarityMatch[];

  // optional: semantic similarity top-k (sentence embedding; dense)
  semanticTop?: SimilarityMatch[];

  triggered?: boolean;
}


