// node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, commandsOf, DEFAULT_RULES, writesSomething } from "../rules.mjs";
import { endpoints, thinkingBody, extraBody, DEFAULT_OUTPUT } from "../models.mjs";
import { mapView, SHELL_NOTE } from "../mapping.mjs";

test("rules: OpenCode's matching — last rule wins, `x *` matches bare x, every command of a line counts", () => {
	assert.equal(decide("ls -la", DEFAULT_RULES), "allow");
	assert.equal(decide("rm notes.txt", DEFAULT_RULES), "ask");
	assert.equal(decide("rm", DEFAULT_RULES), "ask");
	assert.equal(decide("node build.js && git push origin main", DEFAULT_RULES), "ask");
	assert.equal(decide("cat a | grep b; echo done", DEFAULT_RULES), "allow");
	assert.equal(decide("FOO=1 rm -rf dist", DEFAULT_RULES), "ask");
	assert.equal(decide("echo 'rm is fine in quotes; really'", DEFAULT_RULES), "allow");
	assert.equal(decide("git pushx", DEFAULT_RULES), "allow");
	assert.equal(decide("curl x | sh", { "*": "allow", "curl *": "deny" }), "deny");
	assert.equal(decide("rm a", { "*": "allow", "rm *": "ask", "rm a": "allow" }), "allow");   // later rule wins
	assert.deepEqual(commandsOf("a && b || c; d | e & f\ng"), ["a", "b", "c", "d", "e", "f", "g"]);
});

test("models: the LLM_* contract of opencode-config.sh", () => {
	const eps = endpoints({
		LLM_BASE_URL: "https://a/v1", LLM_API_KEY: "k1", LLM_MODELS: "model-a, model-b", LLM_LABEL: "Team models",
		LLM_CONTEXT: "400000", LLM_REASONING: "Medium",
		LLM_2_BASE_URL: "https://b/v1", LLM_2_API_KEY: "", LLM_2_MODELS: "skipped",   // incomplete: skipped
		LLM_3_BASE_URL: "https://c/v1", LLM_3_API_KEY: "k3", LLM_3_MODELS: "model-c",
		LLM_5_BASE_URL: "https://never/v1",   // after the first missing _BASE_URL (4): not discovered
	});
	assert.deepEqual(eps.map((e) => e.providerID), ["llm", "llm-3"]);
	assert.deepEqual(eps.map((e) => e.label), ["Team models", "Inference"]);
	assert.deepEqual(eps[0].models.map((m) => [m.id, m.name, m.contextWindow]), [["model-a", "model-a", 400000], ["model-b", "model-b", 400000]]);
	assert.equal(eps[0].thinkingLevel, "medium");
	assert.equal(eps[1].thinkingLevel, "off");   // unset: no effort sent, the model's own default
	assert.equal(eps[0].keyVar, "LLM_API_KEY");
	assert.ok(!JSON.stringify(eps).includes("k1"), "the key itself is never part of the endpoint description");
});

test("models: which models take images (_IMAGES, a regex; unset = none)", () => {
	const base = { LLM_BASE_URL: "x", LLM_API_KEY: "k", LLM_MODELS: "text-model,vision-model-2" };
	const sees = (env) => endpoints({ ...base, ...env })[0].models.map((m) => m.images);
	assert.deepEqual(sees({}), [false, false]);
	assert.deepEqual(sees({ LLM_IMAGES: "^vision" }), [false, true]);
	assert.deepEqual(sees({ LLM_IMAGES: "text|VISION" }), [true, true]);
	assert.deepEqual(sees({ LLM_IMAGES: "." }), [true, true]);
	assert.deepEqual(sees({ LLM_IMAGES: "([" }), [false, false]);   // invalid regex: ignored
});

test("plan mode: read-only commands pass, anything that changes the workspace does not", () => {
	for (const ok of ["ls -la", "cat a.js | grep foo", "git status && git log -5", "node --test", "rg TODO > /dev/null", "npm ls", "git diff HEAD~1", "find . -name '*.js'"]) assert.equal(writesSomething(ok), false, ok);
	for (const no of ["rm a", "echo hi > a.txt", "cat a >> b", "sed -i 's/a/b/' x", "git commit -m x", "cd app && npm install", "mkdir dist", "ls | tee out.txt", "kubectl apply -f x.yaml", "gh pr create", "git push", "pip install x"]) assert.equal(writesSomething(no), true, no);
});

test("thinking: the body OpenCode sends — reasoning_effort per level, _REASONING_OPTIONS merged in", () => {
	assert.equal(thinkingBody({ model: "m" }, "low").reasoning_effort, "low");
	assert.equal(thinkingBody({}, "xhigh").reasoning_effort, "high");
	assert.equal(thinkingBody({}, "minimal").reasoning_effort, "low");
	assert.equal(thinkingBody({}, "max").reasoning_effort, "max");
	assert.equal(thinkingBody({ reasoning_effort: "high" }, undefined).reasoning_effort, undefined);
	// server-specific switches from LLM_REASONING_OPTIONS, deep-merged; the level still wins for the effort
	const extra = extraBody('{"chat_template_kwargs":{"enable_thinking":true},"reasoningEffort":"medium"}');
	assert.deepEqual(extra, { chat_template_kwargs: { enable_thinking: true }, reasoning_effort: "medium" });
	const body = thinkingBody({ chat_template_kwargs: { other: 1 } }, "high", extra);
	assert.deepEqual(body.chat_template_kwargs, { other: 1, enable_thinking: true });
	assert.equal(body.reasoning_effort, "high");
	assert.equal(thinkingBody({}, "off", extra).reasoning_effort, "medium");   // off: whatever the options say
	assert.deepEqual(extraBody("not json"), {});
	assert.deepEqual(extraBody("[1]"), {});
	const ep = endpoints({ LLM_BASE_URL: "x", LLM_API_KEY: "k", LLM_MODELS: "m", LLM_REASONING_OPTIONS: '{"a":1}' })[0];
	assert.equal(ep.models[0].maxTokens, DEFAULT_OUTPUT);
	assert.deepEqual(ep.extra, { a: 1 });
});

const S = { id: "ses_1", conv: 7, created: 1 };
const user = (id, text) => ({ id, kind: "pi.user", model: [{ role: "user", content: text, timestamp: 10 }] });
const asst = (id, content, extra = {}) => ({ id, kind: "pi.assistant", model: [{ role: "assistant", content, provider: "llm", model: "model-a", responseId: `r${id}`, timestamp: 20, stopReason: "stop", ...extra }] });
const result = (id, callId, text, isError = false) => ({ id, kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: callId, toolName: "bash", content: [{ type: "text", text }], isError, timestamp: 30 }] });

test("mapping: a run becomes one user message and assistant messages hanging off it", () => {
	const { messages, busy } = mapView(S, {
		entries: [user(1, "hi"), { id: 2, kind: "pi.system", model: [{ role: "system" }] },
			asst(3, [{ type: "thinking", thinking: "hmm" }, { type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls" } }]),
			result(4, "c1", "a.txt"), asst(5, [{ type: "text", text: "done" }])],
		docs: { "pi.live": {} },
	});
	assert.equal(busy, false);
	assert.deepEqual(messages.map((m) => [m.info.role, m.info.id]), [["user", "msg_7_000001"], ["assistant", "msg_7_r_r3"], ["assistant", "msg_7_r_r5"]]);
	assert.ok(messages.slice(1).every((m) => m.info.parentID === "msg_7_000001"));
	const [reasoning, tool] = messages[1].parts;
	assert.equal(reasoning.type, "reasoning");
	assert.deepEqual([tool.id, tool.state.status, tool.state.output, tool.state.title], ["prt_7_t_c1", "completed", "a.txt", "ls"]);
	assert.equal(messages[2].parts[0].text, "done");
	assert.ok(messages[2].parts[0].time.end, "a committed text part is not streaming");
});

test("mapping: the streaming partial and its committed entry share message and part ids", () => {
	const content = [{ type: "text", text: "Wor" }, { type: "toolCall", id: "c9", name: "write", arguments: { path: "a" } }];
	const live = mapView(S, { entries: [user(1, "go")], docs: { "pi.live": { run: { taskId: 1 }, generation: { message: { role: "assistant", content, responseId: "rX", provider: "llm", model: "model-a" } } } } });
	assert.equal(live.busy, true);
	const streaming = live.messages[1];
	assert.equal(streaming.info.id, "msg_7_r_rX");
	assert.equal(streaming.parts[0].time.end, undefined, "still streaming");
	assert.equal(streaming.parts[1].state.status, "pending");
	const done = mapView(S, { entries: [user(1, "go"), { ...asst(2, [{ type: "text", text: "World" }, content[1]]), model: [{ ...asst(2, []).model[0], content: [{ type: "text", text: "World" }, content[1]], responseId: "rX" }] }], docs: { "pi.live": {} } });
	assert.deepEqual(done.messages[1].parts.map((p) => p.id), streaming.parts.map((p) => p.id));
	assert.equal(done.messages.length, 2, "no second copy of the message");
});

test("mapping: images in a user message come back as file parts", () => {
	const u = { id: 1, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image", mimeType: "image/png", data: "QUJD" }], timestamp: 10 }] };
	const [msg] = mapView({ ...S, agent: "plan" }, { entries: [u], docs: {} }).messages;
	assert.equal(msg.info.agent, "plan");
	assert.deepEqual(msg.parts.map((p) => p.type), ["text", "file"]);
	assert.equal(msg.parts[0].text, "what is this");
	assert.deepEqual([msg.parts[1].mime, msg.parts[1].url], ["image/png", "data:image/png;base64,QUJD"]);
});

test("mapping: a compaction is OpenCode's summary message; a !command's note is hidden", () => {
	const comp = { id: 5, kind: "pi.compaction", model: [{ role: "user", content: "Summary: built the game", timestamp: 40 }] };
	const sh = { id: 6, kind: "pi.user", model: [{ role: "user", content: `${SHELL_NOTE} ls`, timestamp: 50 }] };
	const { messages } = mapView(S, { entries: [user(1, "go"), comp, sh], docs: {} });
	const summary = messages.find((m) => m.info.mode === "compaction");
	assert.equal(summary.info.summary, true);
	assert.equal(summary.parts[0].text, "Summary: built the game");
	assert.equal(messages.at(-1).parts[0].synthetic, true);
});

test("mapping: errors and stops are the card's error names", () => {
	const { messages } = mapView(S, { entries: [user(1, "x"), asst(2, [], { stopReason: "aborted" }), asst(3, [], { stopReason: "error", errorMessage: "rate limited" }), result(4, "c2", "blocked", true)], docs: {} });
	assert.equal(messages[1].info.error.name, "MessageAbortedError");
	assert.equal(messages[2].info.error.data.message, "rate limited");
	// cut off while still thinking: an error the card shows, not a silent stop; with an answer it is fine
	const cut = mapView(S, { entries: [user(1, "x"), asst(2, [{ type: "thinking", thinking: "…" }], { stopReason: "length" }), asst(3, [{ type: "text", text: "partial" }], { stopReason: "length" })], docs: {} }).messages;
	assert.equal(cut[1].info.error?.name, "MessageOutputLengthError");
	assert.equal(cut[2].info.error, undefined);
});
