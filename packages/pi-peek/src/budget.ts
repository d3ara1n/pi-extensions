import type { Context, Message } from "@earendil-works/pi-ai";

/** @internal Heuristic only: ASCII / 3, other code points / 0.5; not a tokenizer. */
export function estimateTextTokens(text: string): number {
  let units = 0;
  for (const char of text) units += char.codePointAt(0)! < 128 ? 1 : 6;
  return Math.ceil(units / 3);
}

/** @internal Count serialized request content, including internal tool declarations. */
export function estimateRequestTokens(context: Context): number {
  return (
    estimateTextTokens(context.systemPrompt ?? "") +
    estimateTextTokens(JSON.stringify(context.tools ?? [])) +
    context.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0) +
    128
  );
}

/** @internal Metadata is counted conservatively alongside message content. */
export function estimateMessageTokens(message: Message): number {
  return estimateTextTokens(JSON.stringify(message)) + 32;
}
