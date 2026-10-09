// A Pi Durable conversation view → OpenCode's messages and parts (the wire shapes the editor's card reads:
// opencode/types.ts in the Theia extension under ui/theia). Pure, so it is tested on its own (test/pi.test.mjs).
//
// Ids are stable on purpose: the card upserts blocks by id and never drops a streamed one, so the in-flight partial
// (pi.live) and the committed entry must produce the same message and part ids.
//   - user message:      msg_<conv>_<entry id>
//   - assistant message: msg_<conv>_r_<provider response id> (the partial carries it from the first chunk)
//   - tool part:         prt_<conv>_t_<tool call id>

/** Prefix of the user entry `!command` writes in front of its bash call (server.mjs). */
export const SHELL_NOTE = "(The user ran this command in the workspace terminal.)";

export const textOf = (content) => Array.isArray(content) ? content.filter((p) => p.type === "text").map((p) => p.text).join("") : String(content ?? "");

const toolTitle = (name, args = {}) => name === "bash" ? String(args.command || "bash").split("\n")[0].slice(0, 80) : args.path ? `${name} ${args.path}` : name;

/**
 * @param s     the session: {id, conv, created}
 * @param view  Durable's ConversationView: {entries, docs: {"pi.live": LiveState}}
 * @returns     {messages: [{info, parts}], busy, retry}
 */
export function mapView(s, view, now = Date.now()) {
	const out = [];
	const results = new Map();
	for (const e of view.entries || []) if (e.kind === "pi.tool-result") results.set(e.model?.[0]?.toolCallId, e.model?.[0]);
	const live = view.docs?.["pi.live"] || {};
	const slots = new Map((live.tools || []).map((t) => [t.callId, t]));
	let parent = "";

	const asst = (id, m, created, streaming) => {
		const info = {
			id, sessionID: s.id, role: "assistant", parentID: parent || id, mode: "build",
			modelID: m.model || "", providerID: m.provider || "",
			time: { created, ...(streaming ? {} : { completed: m.timestamp || created }) },
		};
		if (m.stopReason === "error") info.error = { name: "UnknownError", data: { message: m.errorMessage || "The model request failed" } };
		if (m.stopReason === "aborted") info.error = { name: "MessageAbortedError", data: {} };
		// cut off before it said or did anything (all thinking): the card's "hit the output length limit" error,
		// not a silent stop
		const acted = (Array.isArray(m.content) ? m.content : []).some((p) => (p.type === "text" && p.text?.trim()) || p.type === "toolCall");
		if (m.stopReason === "length" && !acted && !streaming) info.error = { name: "MessageOutputLengthError", data: {} };
		const parts = [];
		(Array.isArray(m.content) ? m.content : []).forEach((p, i) => {
			const base = { id: `${id}_p${i}`, sessionID: s.id, messageID: id };
			const time = { start: created, ...(streaming ? {} : { end: created }) };
			if (p.type === "thinking" && p.thinking) parts.push({ ...base, type: "reasoning", text: p.thinking, time });
			else if (p.type === "text" && p.text) parts.push({ ...base, type: "text", text: p.text, time });
			else if (p.type === "toolCall") {
				const r = results.get(p.id), slot = slots.get(p.id), input = p.arguments || {}, title = toolTitle(p.name, input);
				const state = r
					? (r.isError
						? { status: "error", input, error: textOf(r.content), time: { start: created, end: r.timestamp || created } }
						: { status: "completed", input, output: textOf(r.content), title, metadata: {}, time: { start: created, end: r.timestamp || created } })
					: slot?.status === "running"
						? { status: "running", input, title, metadata: { output: slot.output }, time: { start: created } }
						: { status: "pending", input, raw: "" };
				parts.push({ ...base, id: `prt_${s.conv}_t_${p.id}`, type: "tool", callID: p.id, tool: p.name, state });
			}
		});
		return { info, parts };
	};
	const asstId = (m, fallback) => (m.responseId ? `msg_${s.conv}_r_${m.responseId}` : fallback);

	for (const e of view.entries || []) {
		const m = e.model?.[0];
		if (!m) continue;
		const entryId = `msg_${s.conv}_${String(e.id).padStart(6, "0")}`;
		const created = m.timestamp || s.created;
		if (e.kind === "pi.compaction") {
			// OpenCode's shape for a compaction: an assistant message flagged `summary` (mode compaction) holding it —
			// the card shows one "Conversation compacted" line with the summary a click away
			const id = `${entryId}_summary`;
			out.push({
				info: { id, sessionID: s.id, role: "assistant", parentID: parent || id, mode: "compaction", summary: true, modelID: "", providerID: "", time: { created, completed: created } },
				parts: [{ id: `${id}_p0`, sessionID: s.id, messageID: id, type: "text", text: textOf(m.content), time: { start: created, end: created } }],
			});
			continue;
		}
		if (e.kind === "pi.user") {
			parent = entryId;
			// images the user sent come back as OpenCode file parts (data URLs), so the card shows them in the turn
			const images = Array.isArray(m.content) ? m.content.filter((p) => p.type === "image" && p.data) : [];
			out.push({
				info: { id: entryId, sessionID: s.id, role: "user", time: { created }, agent: s.agent || "build" },
				parts: [
					// a `!command` the user ran (server.mjs shellInto): the note is for the model, not shown in the card
					{ id: `${entryId}_p0`, sessionID: s.id, messageID: entryId, type: "text", text: textOf(m.content), ...(textOf(m.content).startsWith(SHELL_NOTE) ? { synthetic: true } : {}) },
					...images.map((p, i) => ({ id: `${entryId}_f${i}`, sessionID: s.id, messageID: entryId, type: "file", mime: p.mimeType, url: `data:${p.mimeType};base64,${p.data}`, filename: `image-${i + 1}` })),
				],
			});
		} else if (e.kind === "pi.assistant") out.push(asst(asstId(m, entryId), m, created, false));
	}
	// the in-flight partial, once it has a response id, as the same message its entry will become
	const partial = live.generation?.message;
	if (partial?.responseId && !out.some((x) => x.info.id === asstId(partial, ""))) out.push(asst(asstId(partial, ""), partial, now, true));
	return { messages: out, busy: !!live.run, retry: live.generation?.retry };
}
