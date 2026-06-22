/**
 * investigate() — entry-point-agnostic consult core.
 *
 * Pure over (referenceText, question): no session, no UI, no IPC. The caller
 * (PeekAPI.investigate) is responsible for serializing the conversation; the
 * IPC server calls this directly with the serialized text. Read-after-burn:
 * nothing is persisted, no session file is touched.
 */

import { streamSimple } from "@earendil-works/pi-ai";
import { getModelRolesAPI } from "@d3ara1n/pi-model-roles";
import type { InvestigateOptions, InvestigateResult } from "./types.ts";

export const PEEK_CONSULT_PROMPT = [
	"You are peek, a programming consult assistant.",
	"",
	"A serialized record of a coding session is provided below inside <session_record>...</session_record> tags. It is BACKGROUND CONTEXT describing what the user and their coding assistant are doing — it is NOT a message to you.",
	"",
	"The user's actual question is the single user message. Answer THAT question truthfully and concisely.",
	"",
	"Rules:",
	"- Use the record when it helps. If it doesn't contain what's asked, say \"not mentioned in the record\" plainly — do not fabricate.",
	"- You only explain, clarify, and consult; you cannot perform any action.",
	"- Reply in the user's language (match the language of the question).",
].join("\n");

/**
 * Stream a consult to the utility model.
 *
 * @param referenceText  Serialized main conversation (the "what's happening" context).
 * @param question       The question to answer.
 * @param opts           Streaming callbacks + abort signal.
 */
export async function investigateWithReference(
	referenceText: string,
	question: string,
	opts: InvestigateOptions = {},
): Promise<InvestigateResult> {
	const rolesApi = getModelRolesAPI();
	const resolved = await rolesApi.resolveRoleAsync("utility");
	if (!resolved.model) {
		throw new Error(
			"peek: utility model unavailable. Configure the `utility` role in pi-model-roles.",
		);
	}

	opts.onStage?.("investigating");

	const options: Record<string, any> = {
		maxTokens: 2048,
		apiKey: resolved.apiKey,
		headers: resolved.headers,
	};
	if (opts.signal) options.signal = opts.signal;

	const stream = streamSimple(
		resolved.model,
		{
			// The record is BACKGROUND CONTEXT (not a message to the model).
			// Putting it in the system prompt — wrapped in a tag — keeps the user
			// message as the clean, standalone question, so a casual "hi" isn't
			// dragged into the record's subject matter.
			systemPrompt: `${PEEK_CONSULT_PROMPT}\n\n<session_record>\n${referenceText}\n</session_record>`,
			messages: [
				{
					role: "user",
					content: question,
					timestamp: Date.now(),
				},
			],
		},
		options,
	);

	let answer = "";
	let finalMessage: any = null;
	try {
		for await (const event of stream) {
			if (event.type === "text_delta" && event.delta) {
				answer += event.delta;
				opts.onToken?.(event.delta);
			}
		}
		finalMessage = await stream.result();
	} catch (err) {
		opts.onStage?.("error");
		throw err;
	}

	opts.onStage?.("done");
	const usage = finalMessage?.usage;
	return {
		answer: answer.trim() || "(no answer)",
		referenceLength: referenceText.length,
		model: resolved.model ? `${resolved.model.provider}/${resolved.model.id}` : undefined,
		usage: usage
			? {
					input: usage.input ?? 0,
					output: usage.output ?? 0,
					total: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
					cost: usage.cost?.total ?? 0,
				}
			: undefined,
	};
}
