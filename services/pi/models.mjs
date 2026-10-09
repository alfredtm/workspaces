// Inference for Pi: one pi-ai provider per LLM_* endpoint (any OpenAI-compatible server) — the same env contract as
// images/workspace/opencode-config.sh, so OpenCode and Pi see the same models under the same ids (llm, llm-2, …):
//
//   endpoint 1: LLM_BASE_URL, LLM_API_KEY, LLM_MODELS (comma list), optional LLM_LABEL (the provider's display name,
//               default "Inference"), LLM_CONTEXT / LLM_OUTPUT (token limits), LLM_REASONING (off|low|medium|high|max:
//               the default `reasoning_effort`), LLM_REASONING_OPTIONS (a JSON object merged into every request body,
//               for server-specific switches), LLM_IMAGES (a regex over model ids: the models that take images)
//   endpoint N: LLM_<N>_BASE_URL, … — discovery stops at the first missing _BASE_URL
//
// The key is read from the environment at request time and never stored or returned (see server.mjs /config).
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { stream, streamSimple } from "@earendil-works/pi-ai/compat";

const LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const list = (s) => String(s || "").split(",").map((x) => x.trim());
/** Does model `id` take images? `setting` = the endpoint's _IMAGES regex; unset or invalid = no model does. */
export const seesImages = (setting, id) => {
	const s = String(setting || "").trim();
	if (!s) return false;
	try { return new RegExp(s, "i").test(id); } catch { return false; }
};
/** Room for a reply when the endpoint sets no _OUTPUT: a thinking model's reasoning counts against it. */
export const DEFAULT_OUTPUT = 65536;

/**
 * _REASONING_OPTIONS as a request-body fragment: a JSON object (anything else is ignored), with OpenCode's
 * `reasoningEffort` option spelled the way it goes over the wire (`reasoning_effort`), like @ai-sdk does for OpenCode.
 */
export function extraBody(raw) {
	if (!raw || !String(raw).trim()) return {};
	try {
		const o = JSON.parse(raw);
		if (!o || typeof o !== "object" || Array.isArray(o)) return {};
		const { reasoningEffort, ...rest } = o;
		return reasoningEffort === undefined ? rest : { ...rest, reasoning_effort: reasoningEffort };
	} catch {
		return {};
	}
}

const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const deepMerge = (a, b) => {
	const out = { ...a };
	for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
	return out;
};

/**
 * The request body for a thinking level, as OpenCode sends it: the endpoint's _REASONING_OPTIONS merged in, then
 * `reasoning_effort` = the level (pi's minimal/xhigh map onto low/high). `off` sends no effort: the model's default.
 */
export function thinkingBody(payload, effort, extra = {}) {
	const p = deepMerge(payload, extra);
	const level = !effort || effort === "off" ? "off" : effort === "minimal" ? "low" : effort === "xhigh" ? "high" : effort;
	if (level !== "off") p.reasoning_effort = level;
	else if (!("reasoning_effort" in extra)) delete p.reasoning_effort;
	return p;
}

/** The endpoints in `env`, in order: [{providerID, label, prefix, baseUrl, keyVar, models, thinkingLevel, extra}]. */
export function endpoints(env = process.env) {
	const out = [];
	for (let n = 1; n <= 32; n++) {
		const prefix = n === 1 ? "LLM" : `LLM_${n}`;
		const baseUrl = env[`${prefix}_BASE_URL`];
		if (!baseUrl) break;
		const keyVar = `${prefix}_API_KEY`;
		const ids = list(env[`${prefix}_MODELS`]).filter(Boolean);
		if (!env[keyVar] || !ids.length) continue;   // incomplete block: skip, keep walking (as opencode-config.sh)
		const contextWindow = Number(env[`${prefix}_CONTEXT`]) || 128000;
		const maxTokens = Number(env[`${prefix}_OUTPUT`]) || DEFAULT_OUTPUT;
		const level = String(env[`${prefix}_REASONING`] || "").trim().toLowerCase();
		out.push({
			providerID: n === 1 ? "llm" : `llm-${n}`, label: String(env[`${prefix}_LABEL`] || "").trim() || "Inference",
			prefix, baseUrl, keyVar,
			models: ids.map((id) => ({ id, name: id, contextWindow, maxTokens, images: seesImages(env[`${prefix}_IMAGES`], id) })),
			// unset (or unknown): no effort sent, the model's own default — as OpenCode does without _REASONING
			thinkingLevel: LEVELS.has(level) ? level : "off",
			extra: extraBody(env[`${prefix}_REASONING_OPTIONS`]),
		});
	}
	return out;
}

const withThinking = (options = {}, extra = {}) => ({
	...options,
	onPayload: async (payload, model) => {
		const p = (await options.onPayload?.(payload, model)) ?? payload;
		return thinkingBody(p, options.reasoning ?? options.reasoningEffort, extra);
	},
});

/** A pi-ai Models collection with the endpoints, plus the flat model list the card's model menu shows. */
export function inferenceModels(env = process.env) {
	const eps = endpoints(env);
	const models = createModels();
	for (const ep of eps) {
		models.setProvider(createProvider({
			id: ep.providerID,
			name: ep.label,
			baseUrl: ep.baseUrl,
			auth: {
				apiKey: {
					name: `${ep.label} key (${ep.keyVar})`,
					resolve: async ({ ctx }) => { const key = (await ctx.env(ep.keyVar)) || env[ep.keyVar]; return key ? { auth: { apiKey: key }, source: ep.keyVar } : undefined; },
				},
			},
			models: ep.models.map((m) => ({
				id: m.id, name: m.name, api: "openai-completions", provider: ep.providerID, baseUrl: ep.baseUrl,
				reasoning: true, input: m.images ? ["text", "image"] : ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: m.contextWindow, maxTokens: m.maxTokens,
				// A generic OpenAI-compatible server: no developer role, no `store`; reasoning_effort is set by
				// thinkingBody (below), exactly as OpenCode sends it
				compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false },
			})),
			// the generic OpenAI-completions streams, through pi-ai's public dispatch by `model.api`; the body gets
			// OpenCode's thinking settings for the conversation's level
			api: {
				stream: (model, context, options) => stream(model, context, withThinking(options, ep.extra)),
				streamSimple: (model, context, options) => streamSimple(model, context, withThinking(options, ep.extra)),
			},
		}));
	}
	const flat = eps.flatMap((ep) => ep.models.map((m) => ({ providerID: ep.providerID, providerName: ep.label, modelID: m.id, name: m.name, thinkingLevel: ep.thinkingLevel, images: m.images })));
	return { models, list: flat, default: flat[0] };
}
