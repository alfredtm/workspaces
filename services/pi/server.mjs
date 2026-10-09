// Pi (beta) for the workspace editor: OpenCode's HTTP API over Pi Durable (github.com/earendil-works/pi), so the
// editor's assistant card (ui/theia/workspace-theia/src/browser/opencode) runs on Pi unchanged. The editor backend
// starts it while Settings → Assistant is Pi (`workspace.assistant: "pi"`) and routes /opencode-api here.
//
//   node server.mjs [workspace-dir]       listens on 127.0.0.1:$PI_PORT (4099)
//
// Implements the subset the card calls (browser/opencode/client.ts) and the /event SSE stream the backend relay
// follows. One OpenCode session = one Durable conversation (cwd = the session's folder). Everything is committed to
// SQLite in $PI_DATA (~/.local/share/pi, on the PVC), so a pause, a crash or a restart mid-run picks up
// where it stopped — including an approval that was still waiting.
import http from "node:http";
import { spawn } from "node:child_process";
import os from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, GenerationTask, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { CodingTools, createBashTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { inferenceModels } from "./models.mjs";
import { decide, loadRules, writesSomething } from "./rules.mjs";
import { mapView, SHELL_NOTE } from "./mapping.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PI_PORT || 4099), HOST = "127.0.0.1";
const DATA = process.env.PI_DATA || join(os.homedir(), ".local/share/pi");
const WS_DEFAULT = process.argv[2] || process.env.WS_ROOT || os.homedir();
// The platform brief and skill OpenCode gets (images/workspace/dotfiles/opencode → /etc/opencode-defaults)
const DEFAULTS = [process.env.OPENCODE_DEFAULTS, "/etc/opencode-defaults", join(HERE, "../../images/workspace/dotfiles/opencode")].find((d) => d && existsSync(join(d, "AGENTS.md")));
const VERSION = (() => { try { return JSON.parse(readFileSync(join(HERE, "node_modules/@earendil-works/pi-durable/package.json"), "utf8")).version; } catch { return "?"; } })();
mkdirSync(DATA, { recursive: true, mode: 0o700 });
const ctx = BACKGROUND_CONTEXT;
const note = (...a) => console.log(new Date().toISOString().slice(11, 19), "pi:", ...a);

const ai = inferenceModels();
if (!ai.default) note("no complete LLM_* endpoint: Pi has no model to talk to");
const modelOf = (providerID, modelID) => ai.list.find((m) => m.providerID === providerID && m.modelID === modelID);

// ── small JSON files next to the database ───────────────────────────────────
const jsonFile = (name, fallback) => {
	const f = join(DATA, name);
	let v = fallback;
	try { if (existsSync(f)) v = JSON.parse(readFileSync(f, "utf8")); } catch { /* corrupt: start over */ }
	return { get: () => v, set: (x) => { v = x; writeFileSync(f, JSON.stringify(v, null, 1)); } };
};
/** @type {{get(): {id:string, conv:number, directory:string, title:string, created:number, updated:number, model?:{providerID:string, modelID:string}}[], set(v:any): void}} */
const sessionsFile = jsonFile("sessions.json", []);
const approvalsFile = jsonFile("approvals.json", {});   // folder → commands answered "Yes, for this project"
const sessions = () => sessionsFile.get();
const saveSessions = () => sessionsFile.set(sessions());
const byId = (id) => sessions().find((s) => s.id === id);
const byConv = (conv) => sessions().find((s) => s.conv === conv);
const ocSession = (s) => ({ id: s.id, projectID: "pi", directory: s.directory, title: s.title, version: `pi-${VERSION}`, time: { created: s.created, updated: s.updated } });

// ── SSE subscribers per folder ──────────────────────────────────────────────
const subs = new Map();   // directory → Set<res>
const emit = (directory, type, properties) => {
	const frame = `data: ${JSON.stringify({ type, properties })}\n\n`;
	for (const res of subs.get(directory) || []) { try { res.write(frame); } catch { /* gone */ } }
};
// like OpenCode 1.18.30: a heartbeat every 10 s, so no proxy on the way cuts an idle stream
setInterval(() => { for (const set of subs.values()) for (const res of set) { try { res.write(`data: {"type":"server.heartbeat","properties":{}}\n\n`); } catch { /* gone */ } } }, 10_000).unref();

// ── approvals: OpenCode's permission cards, OpenCode's rules ────────────────
const rules = loadRules();
const pendingPerms = new Map();   // id → {req, resolve}
let permSeq = 0;

const read = (f) => (f && existsSync(f) ? readFileSync(f, "utf8") : undefined);

// ── Plan mode: the card's Build | Plan switch (OpenCode's `plan` agent) ─────
// Plan offers only `read` and `bash`, says so in the instructions, and blocks shell commands that change anything.
const PLAN_TOOLS = [createReadTool(), createBashTool()];
const PLAN_INSTRUCTIONS = [
	"PLAN MODE. The user wants a plan before anything changes.",
	"Look at the files and run read-only commands (ls, cat, grep, git status/log/diff, tests that do not write) as much as you need,",
	"but do not create, edit or delete files, install packages, commit, push or deploy.",
	"End with the plan as a short numbered list in plain language, and say that switching the box below the chat from Plan to Build lets you carry it out.",
].join(" ");
const planMode = (conv) => byConv(conv)?.agent === "plan";
/** The card's Thinking levels — the variants opencode-config.sh writes for OpenCode. */
const EFFORTS = ["low", "medium", "high", "max"];
const Workspace = defineExtension({
	name: "workspace",
	sections: [
		section("preamble", () => [
			"You are Pi, the coding assistant in the workspace editor's assistant panel (Pi beta).",
			"The platform notes below were written for OpenCode, the other assistant of the same panel: everything they say about the panel, the Preview, the user and the rules applies to you.",
			"Be brief and use the tools. Shell commands that delete files, push code or publish need the user's OK: say in one plain sentence what you are about to do before you run one.",
		].join(" "), { tag: false }),
		section("cwd", (input) => input.env?.cwd),
		section("platform", () => read(DEFAULTS && join(DEFAULTS, "AGENTS.md"))),
		section("skill", () => read(DEFAULTS && join(DEFAULTS, "skills/workspace/SKILL.md"))),
		section("agents_md", (input) => read(join(input.env?.cwd || WS_DEFAULT, "AGENTS.md"))),
	],
	hooks: [hook(GenerationTask, {
		// one line per model reply in the pod log: how it ended and what it cost — what a "Pi stopped" report needs
		afterResponse: (m, api) => {
			const parts = Array.isArray(m.content) ? m.content : [];
			const said = parts.filter((p) => p.type === "text").reduce((n, p) => n + (p.text || "").length, 0);
			const thought = parts.filter((p) => p.type === "thinking").reduce((n, p) => n + (p.thinking || "").length, 0);
			const tools = parts.filter((p) => p.type === "toolCall").map((p) => p.name);
			const s = byConv(api.conversationId);
			note(`reply ${s?.id || api.conversationId} ${m.provider}/${m.model}: ${m.stopReason}${m.errorMessage ? ` (${String(m.errorMessage).slice(0, 200)})` : ""}, out ${m.usage?.output ?? "?"} tok, text ${said} / thinking ${thought} chars${tools.length ? `, tools ${tools.join(",")}` : ""}`);
		},
		// A reply that ran out of room before it said anything: continue once by itself, rather than leave the user
		// looking at a run that just stopped. A second one in the same run shows as an error in the card.
		onYield: async (answer, api, c) => {
			const said = (Array.isArray(answer.content) ? answer.content : []).some((p) => (p.type === "text" && p.text?.trim()) || p.type === "toolCall");
			if (answer.stopReason !== "length" || said) return undefined;
			if (await api.memo("continued-after-length", c)) return undefined;
			await api.memo("continued-after-length", true, c);
			note(`reply cut off at the length limit before answering: continuing once (${byConv(api.conversationId)?.id || api.conversationId})`);
			return { continue: "Your last reply hit the length limit while you were still thinking. Continue now: keep the thinking short and get to the answer or the next tool call." };
		},
	}), hook(ToolTask, {
		beforeTool: async (call, api, c) => {
			if (planMode(api.conversationId)) {
				if (call.name === "write" || call.name === "edit") return { block: "Plan mode: do not change files. Put the change in the plan instead." };
				if (call.name === "bash" && writesSomething(call.arguments?.command)) return { block: "Plan mode: this command would change something. Put it in the plan instead." };
			}
			if (call.name !== "bash") return undefined;
			const cmd = String(call.arguments?.command || "");
			const verdict = decide(cmd, rules);
			if (verdict === "deny") return { block: "This command is not allowed in this workspace." };
			if (verdict === "allow") return undefined;
			// the answer is memoised in the tool task: a restart re-asks an unanswered card, never an answered one
			const key = `approval:${call.id}`;
			let ok = await api.memo(key, c);
			if (ok === undefined) {
				const s = byConv(api.conversationId);
				const remembered = s && (approvalsFile.get()[s.directory] || []).includes(cmd);
				const answer = remembered ? "always" : await new Promise((resolve) => {
					const id = `per_pi_${Date.now().toString(36)}_${++permSeq}`;
					const req = { id, sessionID: s?.id || "", permission: "bash", patterns: [cmd], metadata: { command: cmd, description: call.arguments?.description }, always: [cmd], tool: { messageID: "", callID: call.id } };
					pendingPerms.set(id, { req, resolve });
					if (s) emit(s.directory, "permission.asked", req);
				});
				ok = await api.memo(key, answer !== "reject", c);
			}
			return ok ? undefined : { block: "The user said no to this command." };
		},
	})],
});
const registry = createRegistry();
registry.install(CodingTools);
registry.install(Workspace);

const harness = await Harness.open(await openNodeSqliteStorage(join(DATA, "pi.sqlite")), {
	models: ai.models, registry,
	env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? WS_DEFAULT }),
	settings: { retry: { maxRetries: 2 }, compaction: { reserveTokens: 16384 } },
}, ctx);

// ── one attached view per session: map, diff, emit what changed ─────────────
const watched = new Map();   // session id → {view, conv, sent: Map<id, json>, busy}
async function watchSession(s) {
	if (watched.has(s.id)) return watched.get(s.id);
	const conv = await harness.conversation(s.conv, ctx);
	if (!conv) throw new Error(`conversation ${s.conv} is gone`);
	const view = await conv.viewState(ctx);
	const w = { view, conv, sent: new Map(), busy: false };
	watched.set(s.id, w);
	const onChange = (value) => {
		const mapped = mapView(s, value);
		for (const { info, parts } of mapped.messages) {
			const ij = JSON.stringify(info);
			if (w.sent.get(info.id) !== ij) { w.sent.set(info.id, ij); emit(s.directory, "message.updated", { info }); }
			for (const part of parts) {
				const pj = JSON.stringify(part);
				if (w.sent.get(part.id) !== pj) { w.sent.set(part.id, pj); emit(s.directory, "message.part.updated", { part }); }
			}
		}
		const status = mapped.retry ? { type: "retry", attempt: 1, message: mapped.retry.error, next: mapped.retry.at } : mapped.busy ? { type: "busy" } : { type: "idle" };
		const busy = status.type !== "idle";
		if (busy !== w.busy || mapped.retry) {
			w.busy = busy;
			emit(s.directory, "session.status", { sessionID: s.id, status });
			if (!busy) { emit(s.directory, "session.idle", { sessionID: s.id }); s.updated = Date.now(); saveSessions(); }
		}
	};
	onChange(view.value);
	view.subscribe(onChange);
	return w;
}

/**
 * `!command` (OpenCode's POST /session/:id/shell): the user's own command, run in the session's folder without an
 * approval card (they typed it), its output written into the conversation as a bash call + result so the model
 * knows what happened and the card shows it as a Bash block. A user entry in front marks it as the user's doing.
 */
async function shellInto(w, s, cmd) {
	const t0 = Date.now();
	const { output, code } = await new Promise((resolve) => {
		const child = spawn("bash", ["-lc", cmd], { cwd: s.directory, env: process.env });
		let out = "";
		const add = (d) => { if (out.length < 60_000) out += d; };
		child.stdout.on("data", add); child.stderr.on("data", add);
		const timer = setTimeout(() => { child.kill("SIGKILL"); out += "\n(stopped after 2 minutes)"; }, 120_000);
		child.on("close", (c) => { clearTimeout(timer); resolve({ output: out.length >= 60_000 ? out.slice(0, 60_000) + "\n…(truncated)" : out, code: c }); });
		child.on("error", (e) => { clearTimeout(timer); resolve({ output: String(e.message), code: 127 }); });
	});
	const id = `shell_${t0.toString(36)}`;
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
	await w.conv.submit({ type: "write", entry: { kind: "pi.user", model: [{ role: "user", content: `${SHELL_NOTE} ${cmd}`, timestamp: t0 }] } }, ctx);
	await w.conv.submit({ type: "write", entry: { kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command: cmd } }], api: "openai-completions", provider: "user", model: "shell", usage, stopReason: "toolUse", timestamp: t0 }] } }, ctx);
	await w.conv.submit({ type: "write", entry: { kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text: output || "(no output)" }], isError: code !== 0, timestamp: Date.now() }], data: { diagnostics: [] } } }, ctx);
	note(`shell ${s.id}: exit ${code} in ${Date.now() - t0} ms`);
}

async function createSession(directory, title) {
	const d = ai.default;
	const conv = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: d.providerID, modelId: d.modelID }, thinkingLevel: d.thinkingLevel, cwd: directory } }, ctx);
	const now = Date.now();
	const s = { id: `ses_pi_${conv.id}_${now.toString(36)}`, conv: conv.id, directory, title: title || "New conversation", created: now, updated: now, model: { providerID: d.providerID, modelID: d.modelID } };
	sessions().push(s); saveSessions();
	await watchSession(s);
	emit(directory, "session.created", { info: ocSession(s) });
	return s;
}

for (const s of sessions()) await watchSession(s).catch((e) => note("could not reopen", s.id, e.message));
harness.resume();   // continue whatever the last process left running

// ── HTTP ────────────────────────────────────────────────────────────────────
const readBody = (req) => new Promise((resolve) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } }); });
const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)); };
const notYet = (res, what) => json(res, 400, { name: "NotSupported", data: { message: `${what} is not in Pi (beta) yet` } });

const providersAnswer = () => {
	const byProvider = new Map();
	for (const m of ai.list) {
		if (!byProvider.has(m.providerID)) byProvider.set(m.providerID, { id: m.providerID, name: m.providerName, models: {} });
		// OpenCode's shape: the card reads capabilities.input.image to offer attachments
		byProvider.get(m.providerID).models[m.modelID] = {
			id: m.modelID, name: m.name, capabilities: { attachment: !!m.images, input: { text: true, image: !!m.images } },
			variants: Object.fromEntries(EFFORTS.map((e) => [e, {}])),
		};
	}
	return { providers: [...byProvider.values()], default: ai.default ? { [ai.default.providerID]: ai.default.modelID } : {} };
};

http.createServer(async (req, res) => {
	const url = new URL(req.url, "http://x");
	const p = url.pathname, dir = url.searchParams.get("directory") || WS_DEFAULT;
	const m = (re) => p.match(re);
	let r;
	try {
		if (p === "/global/health" || p === "/") return json(res, 200, { healthy: true, version: `pi-${VERSION}` });
		if (p === "/event") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(`data: {"type":"server.connected","properties":{}}\n\n`);
			if (!subs.has(dir)) subs.set(dir, new Set());
			subs.get(dir).add(res);
			req.on("close", () => subs.get(dir)?.delete(res));
			return;
		}
		if (p === "/session" && req.method === "GET") return json(res, 200, sessions().filter((s) => s.directory === dir).sort((a, b) => b.updated - a.updated).map(ocSession));
		if (p === "/session" && req.method === "POST") { const b = await readBody(req); return json(res, 200, ocSession(await createSession(dir, b.title))); }
		if (p === "/session/status") return json(res, 200, Object.fromEntries(sessions().filter((s) => s.directory === dir && watched.get(s.id)?.busy).map((s) => [s.id, { type: "busy" }])));
		if ((r = m(/^\/session\/([^/]+)$/)) && req.method === "DELETE") {
			const s = byId(decodeURIComponent(r[1]));
			if (s) { sessionsFile.set(sessions().filter((x) => x !== s)); emit(s.directory, "session.deleted", { info: ocSession(s) }); }
			return json(res, 200, true);
		}
		if ((r = m(/^\/session\/([^/]+)\/message$/))) {
			const s = byId(decodeURIComponent(r[1])); if (!s) return json(res, 404, { name: "NotFound" });
			return json(res, 200, mapView(s, (await watchSession(s)).view.value).messages);
		}
		if ((r = m(/^\/session\/([^/]+)\/prompt_async$/))) {
			const s = byId(decodeURIComponent(r[1])); if (!s) return json(res, 404, { name: "NotFound" });
			const b = await readBody(req);
			const text = (b.parts || []).filter((x) => x.type === "text").map((x) => x.text).join("\n");
			const w = await watchSession(s);
			// the card sends its model pick with every message: switch the conversation when it changed
			const pick = b.model && modelOf(b.model.providerID, b.model.modelID);
			if (pick && (s.model?.providerID !== pick.providerID || s.model?.modelID !== pick.modelID)) {
				await w.conv.configure({ model: { provider: pick.providerID, modelId: pick.modelID }, thinkingLevel: pick.thinkingLevel }, ctx);
				s.model = { providerID: pick.providerID, modelID: pick.modelID }; saveSessions();
			}
			// …its Thinking choice, as OpenCode's `variant` (low | medium | high | max; none = the endpoint default)
			const level = EFFORTS.includes(b.variant) ? b.variant : (modelOf(s.model?.providerID, s.model?.modelID) || ai.default)?.thinkingLevel;
			if (level && s.effort !== level) {
				await w.conv.configure({ thinkingLevel: level }, ctx);
				s.effort = level; saveSessions();
			}
			// …and its Build | Plan switch, as OpenCode's `agent`
			const agent = b.agent === "plan" ? "plan" : "build";
			if ((s.agent || "build") !== agent) {
				await w.conv.configure(agent === "plan" ? { tools: PLAN_TOOLS, instructions: PLAN_INSTRUCTIONS } : { tools: null, instructions: null }, ctx);
				s.agent = agent; saveSessions();
			}
			if (s.title === "New conversation" && text) { s.title = text.split("\n")[0].slice(0, 60); saveSessions(); emit(s.directory, "session.updated", { info: ocSession(s) }); }
			// pasted / attached images: as image input for a model that takes them, a note for one that does not
			const current = modelOf(s.model?.providerID, s.model?.modelID) || ai.default;
			const images = (b.parts || []).filter((x) => x.type === "file" && /^image\//.test(x.mime || "") && /^data:[^;]+;base64,/.test(x.url || ""));
			const content = !images.length ? text
				: current?.images ? [{ type: "text", text }, ...images.map((x) => ({ type: "image", mimeType: x.mime, data: x.url.slice(x.url.indexOf(",") + 1) }))]
				: `${text}\n\n(The user attached ${images.length} image(s), but ${current?.name || "this model"} cannot see images. Say so briefly, and that a model that takes images can be picked in the model menu if one is offered.)`;
			// "Send now" on a waiting message (the card's `steer`): joins the running work after its current step
			await w.conv.submit({ type: "input", content, ...(b.steer ? { whenBusy: "steer" } : {}) }, ctx);
			res.writeHead(204); return res.end();
		}
		if ((r = m(/^\/session\/([^/]+)\/abort$/))) { const s = byId(decodeURIComponent(r[1])); if (s) await (await watchSession(s)).conv.abort(ctx); return json(res, 200, true); }
		if ((r = m(/^\/session\/([^/]+)\/summarize$/))) {
			// /compact: wait for the compaction task and say whether it placed a summary — a short conversation has
			// nothing to compact, and the card then says so instead of waiting for a row that never comes
			const s = byId(decodeURIComponent(r[1])); if (!s) return json(res, 404, { name: "NotFound" });
			const id = await (await watchSession(s)).conv.compact(undefined, ctx);
			const done = await Promise.race([harness.waitForTask(id, ctx), new Promise((res2) => setTimeout(() => res2(undefined), 180_000))]);
			const outcome = done?.state?.outcome;
			return json(res, 200, { compacted: outcome?.status === "completed" && outcome.result?.submissionId !== undefined, status: outcome?.status || "pending" });
		}
		if ((r = m(/^\/session\/([^/]+)\/shell$/))) {
			const s = byId(decodeURIComponent(r[1])); if (!s) return json(res, 404, { name: "NotFound" });
			const b = await readBody(req);
			const cmd = String(b.command || "").trim();
			if (!cmd) return json(res, 400, { name: "BadRequest", data: { message: "No command" } });
			if (decide(cmd, rules) === "deny") return json(res, 400, { name: "NotAllowed", data: { message: "This command is not allowed in this workspace" } });
			await shellInto(await watchSession(s), s, cmd);
			return json(res, 200, true);
		}
		if ((r = m(/^\/session\/[^/]+\/(command|revert|unrevert)$/))) return notYet(res, { command: "Slash commands", revert: "Undo", unrevert: "Redo" }[r[1]]);
		if (p === "/permission") return json(res, 200, [...pendingPerms.values()].map((x) => x.req).filter((q) => byId(q.sessionID)?.directory === dir));
		if ((r = m(/^\/permission\/([^/]+)\/reply$/))) {
			const id = decodeURIComponent(r[1]), pp = pendingPerms.get(id);
			const b = await readBody(req);
			if (!pp) return json(res, 404, { name: "NotFound" });
			pendingPerms.delete(id);
			const reply = b.reply || "once";
			const s = byId(pp.req.sessionID);
			if (reply === "always" && s) {
				const all = approvalsFile.get();
				all[s.directory] = [...new Set([...(all[s.directory] || []), ...pp.req.always])];
				approvalsFile.set(all);
			}
			pp.resolve(reply);
			if (s) emit(s.directory, "permission.replied", { sessionID: s.id, requestID: id, reply });
			return json(res, 200, true);
		}
		if (p === "/question" || p === "/command") return json(res, 200, []);
		// model ids and names only: no URLs, no keys
		if (p === "/config") return json(res, 200, ai.default ? { model: `${ai.default.providerID}/${ai.default.modelID}` } : {});
		if (p === "/config/providers") return json(res, 200, providersAnswer());
		return json(res, 404, { name: "NotFound", data: { message: `${p} is not in Pi (beta)` } });
	} catch (e) {
		note("error", p, e?.message || e);
		return json(res, 500, { name: "UnknownError", data: { message: String(e?.message || e) } });
	}
}).listen(PORT, HOST, () => note(`Pi ${VERSION} on ${HOST}:${PORT}, ${ai.list.length} models, ${sessions().length} conversations, data in ${DATA}`));
