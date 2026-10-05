/**
 * AI Gateway provider with model autodiscovery.
 *
 * This registers `ai-gateway` separately from Pi's built-in `openai` provider.
 * It discovers chat models from the OpenAI-compatible GET <baseUrl>/v1/models
 * endpoint and delegates requests to Pi's built-in transports.
 *
 * Configuration sources, in normal Pi precedence order:
 *   - auth.json: { "ai-gateway": { "type": "api_key", "key": "..." } }
 *   - models.json: providers.ai-gateway.baseUrl / openaiBaseUrl / anthropicBaseUrl / apiKey
 *   - PI_AI_GATEWAY_BASE_URL and AI_GATEWAY_BASE_URL
 *   - AI_GATEWAY_API_KEY
 *
 * The configured OpenAI route must expose `/v1/models` and
 * `/v1/responses`; the unified Anthropic route must expose `/v1/models`
 * and `/v1/messages` (with its host root used as the base URL).
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { anthropicMessagesApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
	Api,
	AnyModel,
	AssistantMessageEventStream,
	Model,
	RefreshModelsContext,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { mergeModelRefresh } from "./model-refresh.ts";

export const PROVIDER_ID = "ai-gateway";
export const ANTHROPIC_PROVIDER_ID = "ai-gateway-anthropic";
export const OPENAI_API = "openai-responses" as const;
/** @deprecated Use OPENAI_API; retained as a source-compatible name. */
export const RESPONSES_API = OPENAI_API;
export const ANTHROPIC_API = "anthropic-messages" as const;
export const DEFAULT_BASE_URL = "https://api.openai.com/v1";

const BASE_URL_ENV_VARS = ["PI_AI_GATEWAY_BASE_URL", "AI_GATEWAY_BASE_URL"] as const;
const OPENAI_BASE_URL_ENV_VARS = ["PI_AI_GATEWAY_OPENAI_BASE_URL", "AI_GATEWAY_OPENAI_BASE_URL"] as const;
const ANTHROPIC_BASE_URL_ENV_VARS = ["PI_AI_GATEWAY_ANTHROPIC_BASE_URL", "AI_GATEWAY_ANTHROPIC_BASE_URL"] as const;
const API_KEY_ENV_VAR = "AI_GATEWAY_API_KEY";
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const INCLUDE_NON_CHAT_MODELS_ENV_VAR = "PI_AI_GATEWAY_INCLUDE_NON_CHAT_MODELS";
const OBVIOUSLY_NON_CHAT_MODEL = /(?:^|[-_.:/])(embed(?:ding)?|moderation|whisper|transcri(?:be|ption)?|speech|tts|dall-e|image|realtime)(?:$|[-_.:/])/i;
const REASONING_MODEL = /(?:^|[-_.:/])(?:o[134](?:-mini)?|gpt-5|reason(?:ing)?|thinking)(?:$|[-_.:/])/i;

type JsonRecord = Record<string, unknown>;
type ChatProviderModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

interface ModelReference {
	model: Model<Api>;
	score: number;
}

const modelReferences = new Map<string, ModelReference>();

interface ModelsJsonProvider {
	apiKey?: string;
	baseUrl?: string;
	openaiBaseUrl?: string;
	anthropicBaseUrl?: string;
	models?: JsonRecord[];
}

function asRecord(value: unknown): JsonRecord | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function nonEmptyString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return undefined;
}

function positiveNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		const candidate = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
		if (Number.isFinite(candidate) && candidate > 0) return candidate;
	}
	return undefined;
}

function nonNegativeNumber(...values: unknown[]): number | undefined {
	for (const value of values) {
		const candidate = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
		if (Number.isFinite(candidate) && candidate >= 0) return candidate;
	}
	return undefined;
}

function booleanValue(...values: unknown[]): boolean | undefined {
	for (const value of values) {
		if (typeof value === "boolean") return value;
	}
	return undefined;
}

function thinkingLevelMap(value: unknown): Model<Api>["thinkingLevelMap"] | undefined {
	const record = asRecord(value);
	if (!record) return undefined;

	const result: NonNullable<Model<Api>["thinkingLevelMap"]> = {};
	let found = false;
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
		const mapped = record[level];
		const mappedValue = mapped === null ? null : typeof mapped === "string" ? mapped : undefined;
		if (mappedValue !== undefined) {
			result[level] = mappedValue;
			found = true;
		}
	}
	return found ? result : undefined;
}

function modelThinkingLevelMap(entry: JsonRecord): Model<Api>["thinkingLevelMap"] | undefined {
	const capabilities = asRecord(entry.capabilities);
	return (
		thinkingLevelMap(entry.thinkingLevelMap) ??
		thinkingLevelMap(entry.thinking_level_map) ??
		thinkingLevelMap(capabilities?.thinkingLevelMap) ??
		thinkingLevelMap(capabilities?.thinking_level_map)
	);
}

function inputTypes(value: unknown): ("text" | "image")[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const hasImage = value.some((item) => typeof item === "string" && item.toLowerCase().includes("image"));
	return hasImage ? ["text", "image"] : ["text"];
}

function modelInputMetadataPresent(entry: JsonRecord): boolean {
	const capabilities = asRecord(entry.capabilities);
	return [entry.input_modalities, entry.input, capabilities?.input_modalities, capabilities?.input].some(
		(value) => inputTypes(value) !== undefined,
	);
}

function modelReasoningMetadataPresent(entry: JsonRecord): boolean {
	const capabilities = asRecord(entry.capabilities);
	return (
		booleanValue(
			entry.reasoning,
			entry.supports_reasoning,
			capabilities?.reasoning,
			capabilities?.supports_reasoning,
		) !== undefined
	);
}

function modelContextWindow(entry: JsonRecord): number | undefined {
	const capabilities = asRecord(entry.capabilities);
	return positiveNumber(
		entry.context_window,
		entry.contextWindow,
		entry.context_length,
		entry.max_context_length,
		capabilities?.context_window,
		capabilities?.contextWindow,
		capabilities?.context_length,
	);
}

function modelMaxTokens(entry: JsonRecord): number | undefined {
	const capabilities = asRecord(entry.capabilities);
	return positiveNumber(
		entry.max_output_tokens,
		entry.maxTokens,
		entry.max_completion_tokens,
		capabilities?.max_output_tokens,
		capabilities?.maxTokens,
		capabilities?.max_completion_tokens,
	);
}

function modelCost(entry: JsonRecord): ChatProviderModelConfig["cost"] {
	const cost = asRecord(entry.cost) ?? asRecord(entry.pricing);
	if (!cost) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

	const tiers = Array.isArray(cost.tiers)
		? cost.tiers
			.map((tier) => asRecord(tier))
			.filter((tier): tier is JsonRecord => tier !== undefined)
			.map((tier) => ({
				input: nonNegativeNumber(tier.input) ?? 0,
				output: nonNegativeNumber(tier.output) ?? 0,
				cacheRead: nonNegativeNumber(tier.cacheRead) ?? 0,
				cacheWrite: nonNegativeNumber(tier.cacheWrite) ?? 0,
				inputTokensAbove: nonNegativeNumber(tier.inputTokensAbove) ?? 0,
			}))
		: undefined;

	return {
		input: nonNegativeNumber(cost.input, cost.inputCost, cost.input_cost) ?? 0,
		output: nonNegativeNumber(cost.output, cost.outputCost, cost.output_cost) ?? 0,
		cacheRead: nonNegativeNumber(cost.cacheRead, cost.cacheReadCost, cost.cache_read) ?? 0,
		cacheWrite: nonNegativeNumber(cost.cacheWrite, cost.cacheWriteCost, cost.cache_write) ?? 0,
		...(tiers && tiers.length > 0 ? { tiers } : {}),
	};
}

function modelCostMetadataPresent(entry: JsonRecord): boolean {
	return asRecord(entry.cost) !== undefined || asRecord(entry.pricing) !== undefined;
}

function modelInputLimits(entry: JsonRecord): ChatProviderModelConfig["inputLimits"] | undefined {
	const value = asRecord(entry.inputLimits) ?? asRecord(entry.input_limits);
	return value as ChatProviderModelConfig["inputLimits"] | undefined;
}

function modelPromptCache(entry: JsonRecord): ChatProviderModelConfig["promptCache"] | undefined {
	const value = asRecord(entry.promptCache) ?? asRecord(entry.prompt_cache);
	return value as ChatProviderModelConfig["promptCache"] | undefined;
}

function modelSamplingParams(entry: JsonRecord): Record<string, unknown> | undefined {
	return asRecord(entry.samplingParams) ?? asRecord(entry.sampling_params);
}

function modelReferenceScore(model: Model<Api>, source: "builtin" | "runtime"): number {
	let score = source === "runtime" ? 1_000 : 0;
	if (model.provider === "openai") score += 100;
	else if (model.api === RESPONSES_API || model.api === ANTHROPIC_API) score += 80;
	return score;
}

function rememberModelReferences(models: readonly Model<Api>[], source: "builtin" | "runtime"): void {
	for (const model of models) {
		// A discovered gateway model is not an independent metadata source. It may
		// already contain the fallback metadata we are trying to improve.
		if (model.provider === PROVIDER_ID || model.provider === ANTHROPIC_PROVIDER_ID) continue;
		const score = modelReferenceScore(model, source);
		const existing = modelReferences.get(model.id);
		if (!existing || score >= existing.score) modelReferences.set(model.id, { model, score });
	}
}

rememberModelReferences(builtinModels().getModels(), "builtin");

function normalizeBaseUrl(value: string): string {
	const trimmed = value.trim().replace(/\/+$/, "");
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error("AI Gateway baseUrl must be an absolute http(s) URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("AI Gateway baseUrl must use http or https");
	}
	return trimmed;
}

function tryNormalizeBaseUrl(value: unknown): string | undefined {
	const candidate = nonEmptyString(value);
	if (!candidate) return undefined;
	try {
		return normalizeBaseUrl(candidate);
	} catch {
		return undefined;
	}
}

function modelsJsonPath(): string {
	const agentDir = nonEmptyString(process.env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent");
	return join(agentDir, "models.json");
}

async function readModelsJsonProvider(providerId: string = PROVIDER_ID): Promise<ModelsJsonProvider | undefined> {
	try {
		const contents = await readFile(modelsJsonPath(), "utf8");
		const root = asRecord(JSON.parse(contents));
		const providers = asRecord(root?.providers);
		const provider = asRecord(providers?.[providerId]);
		const fallback = providerId === ANTHROPIC_PROVIDER_ID ? asRecord(providers?.[PROVIDER_ID]) : undefined;
		if (!provider && !fallback) return undefined;

		const configuredModels = provider?.models ?? fallback?.models;
		const models = Array.isArray(configuredModels)
			? configuredModels.map((model) => asRecord(model)).filter((model): model is JsonRecord => model !== undefined)
			: undefined;

		return {
			apiKey: nonEmptyString(provider?.apiKey, fallback?.apiKey),
			baseUrl: nonEmptyString(provider?.baseUrl, fallback?.baseUrl),
			openaiBaseUrl: nonEmptyString(provider?.openaiBaseUrl, fallback?.openaiBaseUrl),
			anthropicBaseUrl: nonEmptyString(provider?.anthropicBaseUrl, fallback?.anthropicBaseUrl),
			models,
		};
	} catch (error) {
		if (asRecord(error)?.code === "ENOENT") return undefined;
		// Pi reports malformed models.json separately. Discovery can still use an
		// environment/default endpoint, so do not duplicate that startup error.
		return undefined;
	}
}

function resolveConfiguredValue(value: unknown, environment: Record<string, string | undefined> = process.env): string | undefined {
	if (typeof value !== "string" || value.startsWith("!")) return undefined;

	let missing = false;
	const resolved = value.replace(
		/\$\$|\$!|\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
		(match, bracedName: string | undefined, bareName: string | undefined) => {
			if (match === "$$") return "$";
			if (match === "$!") return "!";
			const name = bracedName ?? bareName;
			if (!name) {
				missing = true;
				return "";
			}
			const replacement = environment[name];
			if (replacement === undefined) missing = true;
			return replacement ?? "";
		},
	);
	return missing || !resolved ? undefined : resolved;
}

async function readStoredApiKey(providerId: string = PROVIDER_ID): Promise<string | undefined> {
	try {
		const contents = await readFile(join(nonEmptyString(process.env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent"), "auth.json"), "utf8");
		const root = asRecord(JSON.parse(contents));
		const credentials = [root?.[providerId], ...(providerId === ANTHROPIC_PROVIDER_ID ? [root?.[PROVIDER_ID]] : [])];
		for (const value of credentials) {
			const credential = asRecord(value);
			if (credential?.type !== "api_key") continue;
			const environment = {
				...process.env,
				...Object.fromEntries(
					Object.entries(asRecord(credential.env) ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
				),
			};
			const key = resolveConfiguredValue(credential.key, environment);
			if (key) return key;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function resolveBaseUrl(providerId: string = PROVIDER_ID): Promise<string> {
	const transportEnvVars = providerId === PROVIDER_ID ? OPENAI_BASE_URL_ENV_VARS : ANTHROPIC_BASE_URL_ENV_VARS;
	for (const envVar of [...transportEnvVars, ...BASE_URL_ENV_VARS]) {
		const value = nonEmptyString(process.env[envVar]);
		if (value) return normalizeBaseUrl(value);
	}

	const configured = await readModelsJsonProvider(providerId);
	const transportBaseUrl = providerId === PROVIDER_ID ? configured?.openaiBaseUrl : configured?.anthropicBaseUrl;
	const configuredTransportBaseUrl = tryNormalizeBaseUrl(transportBaseUrl);
	if (configuredTransportBaseUrl) return configuredTransportBaseUrl;
	const configuredBaseUrl = tryNormalizeBaseUrl(configured?.baseUrl);
	if (configuredBaseUrl) return configuredBaseUrl;
	for (const model of configured?.models ?? []) {
		const modelBaseUrl = tryNormalizeBaseUrl(model.baseUrl);
		if (modelBaseUrl) return modelBaseUrl;
	}

	return DEFAULT_BASE_URL;
}

function endpointUrl(baseUrl: string, endpoint: string): string {
	return `${baseUrl.replace(/\/+$/, "")}/${endpoint}`;
}

function requestBaseUrl(baseUrl: string, api: Api): string {
	// Pi's Anthropic adapter passes model.baseUrl to the Anthropic SDK, which
	// appends `/v1/messages` itself. The catalog is still discovered at
	// `<baseUrl>/v1/models`, so keep the two URL shapes separate.
	if (api === ANTHROPIC_API) return baseUrl.replace(/\/v1$/i, "");
	return /\/v1$/i.test(baseUrl) ? baseUrl : endpointUrl(baseUrl, "v1");
}

function discoveryBaseUrls(baseUrl: string): string[] {
	if (/\/v1$/i.test(baseUrl)) return [baseUrl];
	// Prefer the OpenAI-compatible catalog. Some gateway roots expose a
	// different internal `/models` route, while `/v1/models` is the authenticated
	// OpenAI model-list endpoint used by both transports.
	return [endpointUrl(baseUrl, "v1"), baseUrl];
}

function modelInput(entry: JsonRecord): ("text" | "image")[] {
	const capabilities = asRecord(entry.capabilities);
	const modalities = [entry.input_modalities, entry.input, capabilities?.input_modalities, capabilities?.input];
	for (const value of modalities) {
		const parsed = inputTypes(value);
		if (parsed) return parsed;
	}
	return ["text"];
}

function modelReasoning(entry: JsonRecord, id: string): boolean {
	const capabilities = asRecord(entry.capabilities);
	return booleanValue(
		entry.reasoning,
		entry.supports_reasoning,
		capabilities?.reasoning,
		capabilities?.supports_reasoning,
	) ?? REASONING_MODEL.test(id);
}

function modelDefinition(entry: unknown, baseUrl: string, api: Api = RESPONSES_API): ChatProviderModelConfig | undefined {
	const record = asRecord(entry);
	if (!record) return undefined;
	const id = nonEmptyString(record?.id);
	if (!id) return undefined;

	return {
		type: "chat",
		id,
		name: nonEmptyString(record?.name, record?.display_name, record?.label) ?? id,
		api,
		baseUrl: requestBaseUrl(tryNormalizeBaseUrl(record?.baseUrl) ?? baseUrl, api),
		input: modelInput(record),
		reasoning: modelReasoning(record, id),
		thinkingLevelMap: modelThinkingLevelMap(record),
		inputLimits: modelInputLimits(record),
		cost: modelCost(record),
		promptCache: modelPromptCache(record),
		samplingParams: modelSamplingParams(record),
		compat: asRecord(record.compat) as ChatProviderModelConfig["compat"] | undefined,
		contextWindow: modelContextWindow(record) ?? DEFAULT_CONTEXT_WINDOW,
		maxTokens: Math.max(16, modelMaxTokens(record) ?? DEFAULT_MAX_TOKENS),
	};
}

function enrichModelFromReference(model: ChatProviderModelConfig, entry: JsonRecord): ChatProviderModelConfig {
	const reference = modelReferences.get(model.id)?.model;
	if (!reference) return model;

	const hasName = nonEmptyString(entry.name, entry.display_name, entry.label) !== undefined;
	const hasThinkingLevelMap = modelThinkingLevelMap(entry) !== undefined;
	const hasInputLimits = modelInputLimits(entry) !== undefined;
	const hasPromptCache = modelPromptCache(entry) !== undefined;
	const hasSamplingParams = modelSamplingParams(entry) !== undefined;
	const hasCompat = asRecord(entry.compat) !== undefined;

	return {
		...model,
		name: hasName ? model.name : reference.name,
		input: modelInputMetadataPresent(entry) ? model.input : reference.input,
		reasoning: modelReasoningMetadataPresent(entry) ? model.reasoning : reference.reasoning,
		thinkingLevelMap: hasThinkingLevelMap ? model.thinkingLevelMap : reference.thinkingLevelMap,
		inputLimits: hasInputLimits ? model.inputLimits : reference.inputLimits,
		cost: modelCostMetadataPresent(entry) ? model.cost : reference.cost,
		promptCache: hasPromptCache ? model.promptCache : reference.promptCache,
		samplingParams: hasSamplingParams ? model.samplingParams : reference.samplingParams,
		compat: hasCompat ? model.compat : reference.compat,
		contextWindow: modelContextWindow(entry) ?? reference.contextWindow,
		maxTokens: modelMaxTokens(entry) !== undefined ? model.maxTokens : reference.maxTokens,
	};
}

type ModelIdFilter = (id: string, entry?: JsonRecord) => boolean;

function configuredModelDefinitions(
	configured: ModelsJsonProvider | undefined,
	baseUrl: string,
	api: Api,
	filter: ModelIdFilter,
): ChatProviderModelConfig[] {
	const seen = new Set<string>();
	const definitions: ChatProviderModelConfig[] = [];
	for (const entry of configured?.models ?? []) {
		const id = nonEmptyString(entry.id);
		if (!id || !filter(id, entry) || seen.has(id)) continue;
		const model = modelDefinition(entry, baseUrl, api);
		if (model) {
			seen.add(id);
			definitions.push(enrichModelFromReference(model, entry));
		}
	}
	return definitions;
}

function mergeModels(...sources: ChatProviderModelConfig[][]): ChatProviderModelConfig[] {
	const models = new Map<string, ChatProviderModelConfig>();
	for (const source of sources) {
		for (const model of source) models.set(model.id, model);
	}
	return [...models.values()];
}

function storedModelDefinitionsFromEntries(
	stored: readonly unknown[],
	providerId: string,
	api: Api,
	filter: ModelIdFilter,
	defaultBaseUrl: string,
): ChatProviderModelConfig[] {
	const seen = new Set<string>();
	const definitions: ChatProviderModelConfig[] = [];

	for (const entry of stored) {
		const record = asRecord(entry);
		const provider = nonEmptyString(record?.provider);
		if (provider && provider !== providerId) continue;
		const id = nonEmptyString(record?.id);
		if (!id || !filter(id, record) || seen.has(id)) continue;
		const model = modelDefinition(entry, tryNormalizeBaseUrl(record?.baseUrl) ?? defaultBaseUrl, api);
		if (model) {
			seen.add(id);
			definitions.push(enrichModelFromReference(model, record ?? {}));
		}
	}

	return definitions;
}

function storedModelDefinitions(
	context: RefreshModelsContext,
	providerId: string,
	api: Api,
	filter: ModelIdFilter,
	defaultBaseUrl: string,
): ChatProviderModelConfig[] {
	return storedModelDefinitionsFromEntries(context.stored?.models ?? [], providerId, api, filter, defaultBaseUrl);
}

function catalogEntries(payload: unknown): unknown[] {
	if (Array.isArray(payload)) return payload;
	const data = asRecord(payload)?.data;
	if (Array.isArray(data)) return data;
	throw new Error("AI Gateway model discovery returned no data array");
}

function includeModel(id: string): boolean {
	return process.env[INCLUDE_NON_CHAT_MODELS_ENV_VAR] === "1" || !OBVIOUSLY_NON_CHAT_MODEL.test(id);
}

function isClaudeModel(id: string): boolean {
	return /claude/i.test(id);
}

function modelApiSelection(id: string, entry?: JsonRecord): Set<string> | undefined {
	const capabilities = asRecord(entry?.capabilities);
	const plural = entry?.apis ?? capabilities?.apis;
	if (Array.isArray(plural)) {
		const apis = new Set(plural.filter((value): value is string => typeof value === "string"));
		return apis.size > 0 ? apis : new Set();
	}

	const singular = nonEmptyString(entry?.api, capabilities?.api);
	if (singular) return new Set([singular]);

	// A matching Pi registry entry can declare a native transport. Claude IDs
	// are also kept on Anthropic Messages by default because the gateway's
	// OpenAI-compatible endpoint does not accept them.
	const referenceApi = modelReferences.get(id)?.model.api;
	if (referenceApi === RESPONSES_API || referenceApi === ANTHROPIC_API) return new Set([referenceApi]);
	if (isClaudeModel(id)) return new Set([ANTHROPIC_API]);
	return undefined;
}

function includeApi(api: Api): ModelIdFilter {
	return (id, entry) => {
		if (!includeModel(id)) return false;
		const selection = modelApiSelection(id, entry);
		return selection === undefined || selection.has(api);
	};
}

const includeOpenAIModel = includeApi(RESPONSES_API);
const includeAnthropicModel = includeApi(ANTHROPIC_API);

export function modelsFromCatalog(
	payload: unknown,
	baseUrl: string,
	api: Api = RESPONSES_API,
	filter: ModelIdFilter = includeOpenAIModel,
): ChatProviderModelConfig[] {
	const seen = new Set<string>();
	const models: ChatProviderModelConfig[] = [];
	for (const entry of catalogEntries(payload)) {
		const id = nonEmptyString(asRecord(entry)?.id);
		const record = asRecord(entry);
		if (!id || !filter(id, record) || seen.has(id)) continue;
		const model = modelDefinition(record, baseUrl, api);
		if (model) {
			seen.add(id);
			models.push(enrichModelFromReference(model, record ?? {}));
		}
	}
	return models;
}

async function fetchCatalog(
	baseUrl: string,
	apiKey: string | undefined,
	signal: AbortSignal,
	api: Api,
): Promise<{ payload: unknown; baseUrl: string }> {
	const headersFor = (includeGatewayFallback: boolean): Record<string, string> => {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (!apiKey) return headers;

		// OpenAI-compatible discovery is attempted with the standard Bearer
		// credential first. Some gateway deployments still require x-api-key at
		// their edge, so retry with both headers when the primary request is
		// rejected. Anthropic discovery uses x-api-key as its primary convention.
		if (api === RESPONSES_API || includeGatewayFallback) headers.Authorization = `Bearer ${apiKey}`;
		if (api === ANTHROPIC_API || includeGatewayFallback) headers["x-api-key"] = apiKey;
		return headers;
	};
	const headerVariants = apiKey ? [headersFor(false), headersFor(true)] : [headersFor(false)];

	let lastStatus: number | undefined;
	outer: for (const candidateBaseUrl of discoveryBaseUrls(baseUrl)) {
		for (const headers of headerVariants) {
			signal.throwIfAborted();
			const response = await fetch(endpointUrl(candidateBaseUrl, "models"), {
				headers,
				signal,
			});
			if (response.ok) {
				signal.throwIfAborted();
				return { payload: await response.json(), baseUrl: requestBaseUrl(candidateBaseUrl, api) };
			}

			lastStatus = response.status;
			// A gateway may protect an unversioned route before routing it, so try
			// the conventional /v1 prefix and the gateway auth fallback on 401/404.
			if (response.status !== 401 && response.status !== 404) break outer;
		}
	}

	throw new Error(`AI Gateway model discovery failed with HTTP ${lastStatus ?? "unknown"}`);
}

function credentialApiKey(context: RefreshModelsContext): string | undefined {
	const credential = context.credential;
	if (credential?.type !== "api_key") return undefined;
	return resolveConfiguredValue(credential.key, { ...process.env, ...(credential.env ?? {}) });
}

async function configuredApiKey(providerId: string, configured: ModelsJsonProvider | undefined): Promise<string | undefined> {
	return (
		(await readStoredApiKey(providerId)) ??
		resolveConfiguredValue(configured?.apiKey) ??
		nonEmptyString(process.env[API_KEY_ENV_VAR])
	);
}

interface BootstrapModels {
	responses: ChatProviderModelConfig[];
	anthropic: ChatProviderModelConfig[];
}

function isOffline(): boolean {
	return ["1", "true", "yes"].includes((process.env.PI_OFFLINE ?? "").toLowerCase());
}

async function readStoredCatalog(providerId: string): Promise<JsonRecord[]> {
	try {
		const agentDir = nonEmptyString(process.env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent");
		const contents = await readFile(join(agentDir, "models-store.json"), "utf8");
		const root = asRecord(JSON.parse(contents));
		const provider = asRecord(root?.[providerId]);
		const models = provider?.models;
		return Array.isArray(models)
			? models.map((model) => asRecord(model)).filter((model): model is JsonRecord => model !== undefined)
			: [];
	} catch {
		return [];
	}
}

const eagerlyLoadedProviders = new Set<string>();
const freshlyPersistedProviders = new Set<string>();

async function bootstrapModels(): Promise<BootstrapModels> {
	const [responsesConfigured, anthropicConfigured, responsesStored, anthropicStored] = await Promise.all([
		readModelsJsonProvider(PROVIDER_ID),
		readModelsJsonProvider(ANTHROPIC_PROVIDER_ID),
		readStoredCatalog(PROVIDER_ID),
		readStoredCatalog(ANTHROPIC_PROVIDER_ID),
	]);
	const [responsesBaseUrl, anthropicBaseUrl] = await Promise.all([
		resolveBaseUrl(PROVIDER_ID),
		resolveBaseUrl(ANTHROPIC_PROVIDER_ID),
	]);
	const configuredResponses = configuredModelDefinitions(responsesConfigured, responsesBaseUrl, RESPONSES_API, includeOpenAIModel);
	const configuredAnthropic = configuredModelDefinitions(anthropicConfigured, anthropicBaseUrl, ANTHROPIC_API, includeAnthropicModel);
	const cachedResponses = storedModelDefinitionsFromEntries(responsesStored, PROVIDER_ID, RESPONSES_API, includeOpenAIModel, responsesBaseUrl);
	const cachedAnthropic = storedModelDefinitionsFromEntries(anthropicStored, ANTHROPIC_PROVIDER_ID, ANTHROPIC_API, includeAnthropicModel, anthropicBaseUrl);
	// Seed registration with the cached catalog synchronously. Pi may start
	// availability checks and initial model selection while the provider's
	// cache-only refresh is still completing.
	const initialResponses = mergeModelRefresh(configuredResponses, cachedResponses, []);
	const initialAnthropic = mergeModelRefresh(configuredAnthropic, cachedAnthropic, []);
	if (isOffline()) return { responses: initialResponses, anthropic: initialAnthropic };

	const [responsesApiKey, anthropicConfiguredKey] = await Promise.all([
		configuredApiKey(PROVIDER_ID, responsesConfigured),
		configuredApiKey(ANTHROPIC_PROVIDER_ID, anthropicConfigured),
	]);
	const anthropicApiKey = anthropicConfiguredKey ?? responsesApiKey;
	const discover = async (
		providerId: string,
		cached: boolean,
		baseUrl: string,
		apiKey: string | undefined,
		api: Api,
		configured: ChatProviderModelConfig[],
		filter: ModelIdFilter,
	): Promise<ChatProviderModelConfig[]> => {
		if (cached || !apiKey) return configured;
		try {
			const catalog = await fetchCatalog(baseUrl, apiKey, AbortSignal.timeout(10_000), api);
			eagerlyLoadedProviders.add(providerId);
			return mergeModels(configured, modelsFromCatalog(catalog.payload, catalog.baseUrl, api, filter));
		} catch (error) {
			if (!(error instanceof Error && error.name === "AbortError")) {
				console.warn(`[${PROVIDER_ID}] model discovery failed: ${error instanceof Error ? error.message : "unknown error"}`);
			}
			return configured;
		}
	};
	const [responses, anthropic] = await Promise.all([
		discover(PROVIDER_ID, cachedResponses.length > 0, responsesBaseUrl, responsesApiKey, RESPONSES_API, initialResponses, includeOpenAIModel),
		discover(ANTHROPIC_PROVIDER_ID, cachedAnthropic.length > 0, anthropicBaseUrl, anthropicApiKey, ANTHROPIC_API, initialAnthropic, includeAnthropicModel),
	]);
	return { responses, anthropic };
}

let initialResponsesModels: ChatProviderModelConfig[] = [];
let initialAnthropicModels: ChatProviderModelConfig[] = [];

function persistedModels(
	models: ChatProviderModelConfig[],
	providerId: string,
	api: Api,
	baseUrl: string,
): AnyModel[] {
	return models.map((model) => ({
		...model,
		provider: providerId,
		api,
		baseUrl: model.baseUrl ?? baseUrl,
	}));
}

async function refreshProviderModels(
	context: RefreshModelsContext,
	providerId: string,
	api: Api,
	filter: ModelIdFilter,
	initial: ChatProviderModelConfig[],
): Promise<ChatProviderModelConfig[]> {
	const configured = await readModelsJsonProvider(providerId);
	const baseUrl = await resolveBaseUrl(providerId);
	const configuredModels = configuredModelDefinitions(configured, baseUrl, api, filter);
	const stored = storedModelDefinitions(context, providerId, api, filter, baseUrl);
	const availableModels = mergeModels(configuredModels, stored, initial);

	// The first run already fetched this catalog during extension loading. Hand
	// it to Pi's store now instead of issuing the same request a second time.
	if (eagerlyLoadedProviders.delete(providerId)) {
		await context.publish({
			persist: {
				models: persistedModels(availableModels, providerId, api, baseUrl),
			},
		});
		freshlyPersistedProviders.add(providerId);
		return availableModels;
	}
	if (freshlyPersistedProviders.delete(providerId)) return availableModels;
	if (!context.allowNetwork || context.signal.aborted) return availableModels;

	const apiKey = credentialApiKey(context) ?? (await configuredApiKey(providerId, configured));
	const catalog = await fetchCatalog(baseUrl, apiKey, context.signal, api);
	const models = mergeModelRefresh(
		configuredModels,
		mergeModels(stored, initial),
		modelsFromCatalog(catalog.payload, catalog.baseUrl, api, filter),
		context.force !== true,
	);
	await context.publish({
		persist: {
			models: persistedModels(models, providerId, api, catalog.baseUrl),
		},
	});
	return models;
}

export async function refreshModels(context: RefreshModelsContext): Promise<ChatProviderModelConfig[]> {
	return refreshProviderModels(context, PROVIDER_ID, RESPONSES_API, includeOpenAIModel, initialResponsesModels);
}

export async function refreshAnthropicModels(context: RefreshModelsContext): Promise<ChatProviderModelConfig[]> {
	return refreshProviderModels(context, ANTHROPIC_PROVIDER_ID, ANTHROPIC_API, includeAnthropicModel, initialAnthropicModels);
}

const responsesApi = openAIResponsesApi();
const anthropicApi = anthropicMessagesApi();

function hasHeader(headers: Record<string, string | null> | undefined, name: string): boolean {
	return Object.keys(headers ?? {}).some((key) => key.toLowerCase() === name.toLowerCase());
}

function streamWithGatewayApiKey(
	model: Model<Api>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const headers = { ...options?.headers };
	if (options?.apiKey) {
		if (!hasHeader(headers, "x-api-key")) headers["x-api-key"] = options.apiKey;
		if (!hasHeader(headers, "authorization")) headers.Authorization = `Bearer ${options.apiKey}`;
	}
	const api = model.api === ANTHROPIC_API ? anthropicApi : responsesApi;
	return api.streamSimple(model, context, { ...options, headers });
}

export default async function aiGatewayProvider(pi: ExtensionAPI): Promise<void> {
	const initial = await bootstrapModels();
	initialResponsesModels = initial.responses;
	initialAnthropicModels = initial.anthropic;
	const responsesConfigured = await readModelsJsonProvider(PROVIDER_ID);
	const anthropicConfigured = await readModelsJsonProvider(ANTHROPIC_PROVIDER_ID);
	const responsesBaseUrl = await resolveBaseUrl(PROVIDER_ID);
	const anthropicBaseUrl = await resolveBaseUrl(ANTHROPIC_PROVIDER_ID);

	const responsesApiKey = responsesConfigured?.apiKey ?? `$${API_KEY_ENV_VAR}`;
	const anthropicApiKey = anthropicConfigured?.apiKey ?? responsesApiKey;
	pi.registerProvider(PROVIDER_ID, {
		name: "AI Gateway (OpenAI Responses)",
		baseUrl: responsesBaseUrl,
		api: RESPONSES_API,
		// Preserve a models.json apiKey verbatim so arbitrary variable names such
		// as $PRICETAG_KEY work. auth.json credentials still take precedence at
		// request time; AI_GATEWAY_API_KEY is the environment fallback.
		apiKey: responsesApiKey,
		streamSimple: streamWithGatewayApiKey,
		models: initialResponsesModels.length > 0 ? initialResponsesModels : undefined,
		refreshModels,
	});
	pi.registerProvider(ANTHROPIC_PROVIDER_ID, {
		name: "AI Gateway (Anthropic Messages)",
		baseUrl: anthropicBaseUrl,
		api: ANTHROPIC_API,
		apiKey: anthropicApiKey,
		streamSimple: streamWithGatewayApiKey,
		models: initialAnthropicModels.length > 0 ? initialAnthropicModels : undefined,
		refreshModels: refreshAnthropicModels,
	});
	pi.on("session_start", async (_event, context) => {
		// On later starts Pi restores the cached catalog during its local refresh;
		// this network refresh updates it without delaying provider registration.
		rememberModelReferences(context.modelRegistry.getAll(), "runtime");
		if (isOffline()) return;
		try {
			await context.modelRegistry.refresh({
				providers: [PROVIDER_ID, ANTHROPIC_PROVIDER_ID],
				allowNetwork: true,
			});
		} catch {
			// Pi keeps the last published catalog when a refresh fails.
		}
		rememberModelReferences(context.modelRegistry.getAll(), "runtime");
	});
}

