/**
 * pi-provider-sensenova
 *
 * Registers "sensenova-plan" provider for SenseNova (商汤日日新) Token Plan.
 *
 * Registered as a complete pi-ai `Provider` (the canonical form for
 * extensions that own discovery and stored credentials): standard
 * `envApiKeyAuth` authentication and a hand-written `refreshModels` that
 * keeps the model catalog in sync with the live API (`GET /v1/models`).
 * A stored `/login` credential owns the channel; the ambient
 * `SENSENOVA_API_KEY` env var is consulted only when nothing is stored
 * (pi-ai's standard auth resolution). An unconfigured channel resolves to
 * undefined, so model refresh silently skips it instead of reporting an
 * error.
 *
 * The catalog is refreshed when the persisted snapshot is stale (4-hour
 * window, matching pi's built-in remote catalog) and restored from the
 * snapshot on offline startups, so newly published models appear without a
 * plugin update. `pi update --models` forces an immediate refresh. The
 * static `FALLBACK_MODELS` list below is only used until the first
 * successful network refresh (or when refresh keeps failing).
 *
 * Chat-completions models are registered; image-generation-only models are
 * filtered out via `output_modalities`.
 *
 * Usage quota/balance reporting is not yet implemented — SenseNova does not
 * currently expose a public quota or balance API. Free during public beta.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	envApiKeyAuth,
	type Model,
	type Provider,
	type ProviderStreamOptions,
	type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";

type ChatModel = Model<"openai-completions">;

// ── Constants ─────────────────────────────────────────────────────────────

const PROVIDER_ID = "sensenova-plan";
const PROVIDER_NAME = "SenseNova (Token Plan)";
const BASE_URL = "https://token.sensenova.cn/v1";
const API_KEY_ENV = "SENSENOVA_API_KEY";
const REFRESH_TIMEOUT_MS = 10_000;
/** Freshness window matching pi's built-in remote catalog (4 hours). */
const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

const REASONING = {
	// Gateway-default enum, live-verified for every model except glm-5.3:
	// SenseNova rejects pi's `minimal` level. The API accepts low/medium/high/none.
	off: "none",
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
} as const;

// glm-5.3 deviates: live-verified 2026-11-06, its reasoning_effort enum is
// low/high/max only — `none` and `medium` are rejected with HTTP 400 — so
// thinking cannot be turned off (off: null). Matches zai.json native and
// Unisound's per-model docs for the same model.
const REASONING_GLM_53 = {
	off: null,
	minimal: null,
	low: "low",
	medium: null,
	high: "high",
	xhigh: null,
	max: "max",
} as const;

const CHAT_COMPAT = {
	supportsDeveloperRole: false, // uses `system` role, not `developer`
	supportsReasoningEffort: true, // required for thinkingLevelMap to emit reasoning_effort
} as const;

// Fallback catalog: used before the first network refresh succeeds and kept
// whenever the live catalog cannot be fetched (offline, HTTP errors, aborts).
const FALLBACK_MODELS: ChatModel[] = [
	{
		// In the live catalog since 2026-10 (re-checked 2026-11-06).
		id: "sensenova-6.8-flash-lite",
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: "SenseNova 6.8 Flash Lite",
		reasoning: true,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 65_536,
		thinkingLevelMap: REASONING,
		compat: CHAT_COMPAT,
	},
	{
		// New in the live catalog (first seen 2026-11); same family contract
		// as 6.8-flash-lite (text+image, 256K/64K, gateway effort enum
		// verified live — none/low accepted).
		id: "sensenova-6.8-flash",
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: "SenseNova 6.8 Flash",
		reasoning: true,
		input: ["text", "image"],
		cost: ZERO_COST,
		contextWindow: 262_144,
		maxTokens: 65_536,
		thinkingLevelMap: REASONING,
		compat: CHAT_COMPAT,
	},
	{
		id: "deepseek-v4-flash",
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: "DeepSeek V4 Flash",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		thinkingLevelMap: REASONING,
		compat: CHAT_COMPAT,
	},
	{
		// New in the live catalog (first seen 2026-10).
		id: "deepseek-flash",
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: "DeepSeek Flash",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		thinkingLevelMap: REASONING,
		compat: CHAT_COMPAT,
	},
	{
		id: "glm-5.2",
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: "GLM-5.2",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: REASONING,
		compat: CHAT_COMPAT,
	},
	{
		// New in the live catalog (first seen 2026-11). Per-model effort enum
		// low/high/max (see REASONING_GLM_53); catalog 1M/128K.
		id: "glm-5.3",
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: "GLM-5.3",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 131_072,
		thinkingLevelMap: REASONING_GLM_53,
		compat: CHAT_COMPAT,
	},
	{
		// Catalog (2026-10) now reports text-only input and 64K max output;
		// earlier specs advertised text+image / 1M output — catalog wins.
		id: "kimi-k3",
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: "Kimi K3",
		reasoning: true,
		input: ["text"],
		cost: ZERO_COST,
		contextWindow: 1_048_576,
		maxTokens: 65_536,
		thinkingLevelMap: REASONING,
		compat: CHAT_COMPAT,
	},
	// sensenova-6.7-flash-lite, deepseek-v4-pro and deepseek-v4.1-flash are
	// delisted (absent from the live catalog since 2026-10/2026-11) — removed;
	// they re-register automatically if they return.
];

/** Shipped specs by model id, used to fill gaps in live catalog entries. */
const KNOWN_MODELS = new Map(FALLBACK_MODELS.map((model) => [model.id, model]));

// ── Remote catalog ────────────────────────────────────────────────────────

/** OpenAI-compatible `GET /v1/models` catalog entry. */
interface RemoteModel {
	id: string;
	name?: string;
	input_modalities?: string[];
	output_modalities?: string[];
	context_length?: number;
	max_output_length?: number;
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		image?: string | number;
		request?: string | number;
		input_cache_read?: string | number;
	};
	supported_features?: string[];
	businesses?: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────

function toNumber(value: string | number | undefined | null): number {
	if (value === undefined || value === null) return 0;
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

/** Chat models output text. Image-generation models (e.g. `sensenova-u1.5-lite`) output `image` and are excluded. */
function isChatModel(model: RemoteModel): boolean {
	const output = model.output_modalities;
	if (Array.isArray(output)) return output.includes("text");
	// Older catalogs may omit modalities; exclude the known image-gen families.
	return !/^sensenova-u1(\.|$|-)/.test(model.id);
}

function remoteToChatModel(model: RemoteModel): ChatModel {
	// Prefer shipped specs for known ids when the live entry omits fields.
	const known = KNOWN_MODELS.get(model.id);
	const knownCost = known?.cost ?? ZERO_COST;
	return {
		id: model.id,
		provider: PROVIDER_ID,
		api: "openai-completions",
		baseUrl: BASE_URL,
		name: model.name || known?.name || model.id,
		reasoning: model.supported_features?.includes("reasoning") ?? known?.reasoning ?? true,
		input: (model.input_modalities ?? known?.input ?? ["text"]).filter((m) => m === "text" || m === "image") as (
			| "text"
			| "image"
		)[],
		cost: {
			input: model.pricing?.prompt !== undefined ? toNumber(model.pricing.prompt) : knownCost.input,
			output: model.pricing?.completion !== undefined ? toNumber(model.pricing.completion) : knownCost.output,
			cacheRead:
				model.pricing?.input_cache_read !== undefined
					? toNumber(model.pricing.input_cache_read)
					: knownCost.cacheRead,
			cacheWrite: knownCost.cacheWrite, // SenseNova reports no cache-write pricing
		},
		contextWindow: model.context_length ?? known?.contextWindow ?? 262_144,
		maxTokens: model.max_output_length ?? known?.maxTokens ?? 65_536,
		thinkingLevelMap: REASONING,
		compat: CHAT_COMPAT,
	};
}

/**
 * Whether a persisted entry is one of this channel's chat models. Entries
 * written before the complete-provider rewrite (no provider/api stamps)
 * fail this check and are dropped by the restore phase.
 */
function isOwnChatModel(raw: unknown): raw is ChatModel {
	if (!raw || typeof raw !== "object") return false;
	const m = raw as Record<string, unknown>;
	return (
		m.provider === PROVIDER_ID &&
		m.api === "openai-completions" &&
		(m.type === undefined || m.type === "chat") &&
		typeof m.id === "string" &&
		m.id !== ""
	);
}

async function fetchRemoteCatalog(signal: AbortSignal, apiKey: string | undefined): Promise<RemoteModel[]> {
	if (!apiKey) throw new Error(`${API_KEY_ENV} is not configured for ${PROVIDER_ID}`);
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	const timer = setTimeout(() => controller.abort(), REFRESH_TIMEOUT_MS);
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", onAbort, { once: true });
	try {
		const response = await fetch(`${BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`SenseNova ${BASE_URL}/models returned HTTP ${response.status}`);
		}
		const body = (await response.json()) as { data?: RemoteModel[] };
		if (!Array.isArray(body?.data)) {
			throw new Error(`SenseNova ${BASE_URL}/models returned an unexpected response shape`);
		}
		return body.data;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}

// ── Provider ──────────────────────────────────────────────────────────────

/**
 * Refresh contract for pi-ai dynamic providers:
 *
 * - Restore phase (both passes): reinstall the persisted snapshot when
 *   present; a snapshot with no readable entries is dropped (`persist:
 *   null`) so this pass refetches instead of idling out the window.
 * - Network phase: skip the fetch while the snapshot is younger than
 *   `REFRESH_INTERVAL_MS` unless `force` (e.g. `pi update --models`);
 *   otherwise fetch, persist a snapshot for offline startups, and replace
 *   the live list. On failure throw — pi keeps the previous list and
 *   reports the failed provider.
 */
let dynamicModels: readonly ChatModel[] | undefined;

const provider: Provider<"openai-completions"> = {
	id: PROVIDER_ID,
	name: PROVIDER_NAME,
	baseUrl: BASE_URL,
	// Standard pi-ai auth: a stored (/login) credential wins; otherwise the
	// ambient env var; unconfigured resolves to undefined so refresh skips
	// this channel silently.
	auth: { apiKey: envApiKeyAuth(`${PROVIDER_NAME} API key`, [API_KEY_ENV]) },
	getModels: () => dynamicModels ?? FALLBACK_MODELS,
	refreshModels: async (context: RefreshModelsContext) => {
		const stored = context.stored;
		const restored = (stored?.models ?? []).filter(isOwnChatModel);
		const usable = restored.length > 0;
		if (
			stored &&
			!(await context.publish({ update: () => {
				dynamicModels = usable ? restored : FALLBACK_MODELS;
			} }))
		) {
			return;
		}
		if (stored?.models.length && !usable) {
			// Pre-rewrite snapshot shape: nothing readable — drop it so this
			// pass refetches instead of idling out the freshness window.
			if (!(await context.publish({ persist: null }))) return;
		}
		if (!context.allowNetwork || context.signal.aborted) return;
		if (
			!context.force &&
			usable &&
			typeof stored?.checkedAt === "number" &&
			Date.now() - stored.checkedAt < REFRESH_INTERVAL_MS
		) {
			return;
		}

		const apiKey = context.credential?.type === "api_key" ? context.credential.key : undefined;
		const remote = await fetchRemoteCatalog(context.signal, apiKey);
		if (context.signal.aborted) return;

		const models = remote.filter(isChatModel).map(remoteToChatModel);
		if (models.length === 0) {
			// A chat-empty catalog is almost certainly an API anomaly; rejecting
			// it lets pi keep the previous list instead of registering nothing.
			throw new Error(`SenseNova ${BASE_URL}/models returned no chat models`);
		}

		await context.publish({
			persist: { models, checkedAt: Date.now() },
			update: () => {
				dynamicModels = models;
			},
		});
	},
	stream: (model, context, options) => stream(model, context, options as ProviderStreamOptions),
	streamSimple: (model, context, options) => streamSimple(model, context, options),
};

// ── Entry point ───────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	pi.registerProvider(provider);
}
