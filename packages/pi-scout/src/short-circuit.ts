/**
 * Short-circuit layer — skip the side model on trivial prompts.
 *
 * Borrowed from OpenHuman's hybrid-gate pattern (PR #775): cheap signals
 * short-circuit the obvious cases, the model only handles the ambiguous
 * middle. There is no quality loss — the short-circuit fires only when the
 * routing decision is already certain, everything else falls through to the
 * side model.
 *
 * One rule, multilingual by construction:
 *
 * **Trivial acknowledgment** — a short prompt that is *entirely* an ack
 * ("好的" / "ok" / "はい" / "네"). Matched against a built-in 中/英/日/韓
 * phrase table. A trivial ack means "no skills, don't switch models" — both
 * module answers are certain, so skipping the side model is always safe, even
 * with model-router on. Long prompts are never treated as acks even if they
 * start with an ack word, so "好的，那我们重构整个模块" always reaches the model.
 */

import type { ShortCircuitConfig } from "./types.ts";

/** Result of a successful short-circuit. */
export interface ShortCircuitResult {
  /** Short human-readable reason, surfaced in the status bar. */
  reasoning: string;
}

/**
 * Built-in trivial-acknowledgment phrases, 中/英/日/韓.
 *
 * High-precision only — every entry is unambiguously a pure ack. When unsure,
 * prefer omission: a missed ack simply reaches the model, while a false ack
 * would silently drop routing. User-supplied `ackPhrases` are merged on top.
 */
const DEFAULT_ACK_PHRASES: string[] = [
  // 中文
  "好的",
  "好",
  "嗯",
  "嗯嗯",
  "嗯呢",
  "行",
  "可以",
  "对",
  "对的",
  "是",
  "是的",
  "继续",
  "继续吧",
  "往下",
  "没问题",
  "明白",
  "收到",
  "了解",
  "知道了",
  "晓得",
  "中",
  "成",
  "行吧",
  "可以的",
  "好的呀",
  "好嘞",
  "妥",
  "妥了",
  "嗯哼",
  // English
  "ok",
  "okay",
  "oki",
  "okie",
  "okk",
  "k",
  "sure",
  "yes",
  "yeah",
  "yep",
  "yup",
  "continue",
  "go",
  "ahead",
  "go ahead",
  "sounds good",
  "got it",
  "understood",
  "will do",
  "agreed",
  "roger",
  "proceed",
  "ack",
  "acknowledged",
  "fine",
  // 日本語
  "はい",
  "うん",
  "おk",
  "続けて",
  "了解",
  "承知",
  "わかった",
  "分かった",
  "ええ",
  "継続",
  "進めて",
  "いいよ",
  "いいです",
  "オッケー",
  "おけ",
  // 한국어
  "네",
  "응",
  "응응",
  "계속",
  "알겠어",
  "알겠음",
  "좋아",
  "그래",
  "오키",
];

/**
 * Normalize a prompt/phrase for ack matching: trim, lowercase, strip
 * leading/trailing punctuation. Internal punctuation is preserved so that
 * non-ack content keeps the string out of the ack set.
 * @internal — exported for testing.
 */
export function normalizeAckPrompt(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^[。！？.!?,，、~～…·\s]+/, "")
    .replace(/[。！？.!?,，、~～…·\s]+$/, "");
}

/**
 * Build the full ack-phrase set: built-in defaults plus user extras,
 * all normalized. Deduplicated via Set.
 * @internal — exported for testing.
 */
export function buildAckSet(extra: string[]): Set<string> {
  const all = [...DEFAULT_ACK_PHRASES, ...extra];
  const set = new Set<string>();
  for (const phrase of all) {
    const n = normalizeAckPrompt(phrase);
    if (n.length > 0) set.add(n);
  }
  return set;
}

/**
 * Evaluate whether a prompt can be short-circuited as a trivial ack.
 * Returns the decision when it can, `null` when the prompt must reach the
 * side model.
 *
 * @param prompt - The user's prompt text
 * @param config - Short-circuit tuning
 */
export function evaluateShortCircuit(
  prompt: string,
  config: ShortCircuitConfig,
): ShortCircuitResult | null {
  if (!config.trivialAck) return null;

  const normalized = normalizeAckPrompt(prompt);
  if (normalized.length === 0 || normalized.length > config.maxAckLength) {
    return null;
  }

  const ackSet = buildAckSet(config.ackPhrases);
  return ackSet.has(normalized) ? { reasoning: "trivial ack" } : null;
}
