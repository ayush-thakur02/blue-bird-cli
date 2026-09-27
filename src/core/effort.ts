import { EFFORT_INDEX, type Effort, type EffortSetting } from "../config/schema.ts";

export interface EffortSignals {
  prompt: string;
  /** Number of prior messages in the session. */
  historyLength: number;
  /** Tools the user has enabled. */
  toolCount: number;
  planMode: boolean;
  /** True when the agent is continuing after tool results. */
  continuation: boolean;
  /** Failures seen for the same tool in this turn. */
  repeatedFailures: number;
  /** Files already touched this session. */
  touchedFiles: number;
}

export interface EffortDecision {
  effort: Effort;
  reason: string;
}

const HIGH_SIGNALS = [
  /\brefactor\b/i,
  /\barchitect/i,
  /\bmigrat(e|ion)\b/i,
  /\bredesign\b/i,
  /\bwhy\b.*\b(fail|break|crash|wrong)\b/i,
  /\broot cause\b/i,
  /\brace condition\b/i,
  /\bdeadlock\b/i,
  /\bmemory leak\b/i,
  /\bsecurity\b/i,
  /\bperformance\b.*\b(profil|optimi|regress)/i,
  /\bmulti[- ]file\b/i,
  /\bend[- ]to[- ]end\b/i,
  /\bdesign\b/i,
  /\breview\b/i,
  /\baudit\b/i,
  /\bconcurren/i,
  /\bdistributed\b/i,
  /\bfix the bug\b/i,
  /\bdebug\b/i,
];

const XHIGH_SIGNALS = [
  /\bxhigh\b/i,
  /\bbe (very )?careful\b/i,
  /\bthoroughly\b/i,
  /\bproduction\b.*\bincident\b/i,
  /\bpost[- ]mortem\b/i,
];

/** Asking for the top of the range in words is the only way auto reaches `max`. */
const MAX_SIGNALS = [
  /\bmax(imum)?\b[^.]{0,24}\b(effort|reasoning|thinking|budget)\b/i,
  /\bthink as hard as you can\b/i,
];

const LOOKUP_SIGNALS = [
  /^\s*(what|where|which|who|show|list|print|cat|find|grep|search|tell me|explain|summarize|summarise|describe|why is|how does)\b/i,
  /^\s*(\/help|\/status|\/cost|\/model|\/context)\b/i,
];

const SMALL_CHANGE_SIGNALS = [
  /^\s*(rename|typo|tweak|bump|format|lint|reformat)\b/i,
  /^\s*(add|update|adjust|fix)\s+(a\s+)?(comment|typo|log|logging line|docstring)\b/i,
];

export const EFFORT_ESCALATION_CAP: Effort = "xhigh";

export function classifyEffort(signals: EffortSignals): EffortDecision {
  const prompt = signals.prompt.trim();
  const length = prompt.length;

  if (!prompt) return { effort: "minimal", reason: "empty prompt" };

  if (signals.repeatedFailures >= 2) {
    return { effort: "high", reason: "repeated tool failures, escalating to think harder" };
  }

  if (MAX_SIGNALS.some((pattern) => pattern.test(prompt))) {
    return { effort: "max", reason: "the request asks for the largest reasoning budget" };
  }

  if (XHIGH_SIGNALS.some((pattern) => pattern.test(prompt))) {
    return { effort: "xhigh", reason: "the request explicitly asks for maximum care" };
  }

  if (signals.planMode) return { effort: "high", reason: "planning work benefits from deeper reasoning" };

  const highHits = HIGH_SIGNALS.filter((pattern) => pattern.test(prompt)).length;
  if (highHits >= 2 || (highHits >= 1 && length > 400) || length > 2200) {
    return { effort: "high", reason: "multi-step or design-heavy request" };
  }

  const questionOnly = /\?\s*$/.test(prompt) && length < 160 && !/\b(fix|add|implement|write|create|update|refactor)\b/i.test(prompt);
  if (questionOnly || LOOKUP_SIGNALS.some((pattern) => pattern.test(prompt))) {
    return { effort: "minimal", reason: "lookup-style question" };
  }

  if (length < 200 && (SMALL_CHANGE_SIGNALS.some((pattern) => pattern.test(prompt)) || /\b(fix|add|rename|tweak|adjust|update)\b/i.test(prompt))) {
    return { effort: "low", reason: "small, well-scoped change" };
  }

  if (signals.touchedFiles > 8) return { effort: "high", reason: "the session already spans many files" };

  return { effort: "medium", reason: "default balanced effort" };
}

export function resolveEffort(setting: EffortSetting, signals: EffortSignals): EffortDecision {
  if (setting !== "auto") return { effort: setting, reason: "configured explicitly" };
  return classifyEffort(signals);
}

export function shiftEffort(effort: Effort, delta: number): Effort {
  const top = Math.max(...Object.values(EFFORT_INDEX));
  const target = Math.min(top, Math.max(0, EFFORT_INDEX[effort] + delta));
  const entry = Object.entries(EFFORT_INDEX).find(([, index]) => index === target);
  return (entry?.[0] as Effort) ?? effort;
}

export function maxEffort(a: Effort, b: Effort): Effort {
  return EFFORT_INDEX[a] >= EFFORT_INDEX[b] ? a : b;
}

export function onBadge(effort: Effort): string {
  return effort === "none" ? "off" : effort;
}
