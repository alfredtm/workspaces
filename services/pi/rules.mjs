// Which shell commands Pi asks about before running them — OpenCode's `permission.bash` format and matching, so both
// assistants ask about the same things (images/workspace/opencode-config.sh is the source; its generated config is
// read when present, the defaults below mirror it otherwise):
//   - patterns are globs (`*` = anything), `"x *"` also matches a bare `x`
//   - the LAST matching rule wins
//   - every command of a pipeline / list (`a | b`, `a && b`, `a; b`) is checked on its own; one `deny` denies,
//     otherwise one `ask` asks
import { readFileSync } from "node:fs";

export const DEFAULT_RULES = {
	"*": "allow",
	"rm *": "ask",
	"git push *": "ask",
	"gh repo *": "ask",
	"npm publish *": "ask",
	"opencode run *": "ask",
};

/** The platform's rules: OpenCode's generated config (OPENCODE_CONFIG) if it has `permission.bash`, else the defaults. */
export function loadRules(env = process.env) {
	try {
		const cfg = JSON.parse(readFileSync(env.OPENCODE_CONFIG || "", "utf8"));
		const bash = cfg?.permission?.bash;
		if (bash && typeof bash === "object" && !Array.isArray(bash)) return bash;
	} catch { /* no config: defaults */ }
	return DEFAULT_RULES;
}

const globRe = (pattern) => {
	const esc = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
	// "x *" matches "x" too
	return new RegExp(`^${esc.endsWith(" .*") ? esc.slice(0, -3) + "( .*)?" : esc}$`, "s");
};

/** The commands of a shell line: split on |, ||, &&, ;, & and newlines outside quotes. */
export function commandsOf(line) {
	const out = []; let cur = "", q = "";
	const s = String(line || "");
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (q) { cur += c; if (c === q && s[i - 1] !== "\\") q = ""; continue; }
		if (c === "'" || c === '"') { q = c; cur += c; continue; }
		if (c === "|" || c === ";" || c === "&" || c === "\n") { if (cur.trim()) out.push(cur.trim()); cur = ""; continue; }
		cur += c;
	}
	if (cur.trim()) out.push(cur.trim());
	// a leading `cd dir` or env assignment does not hide what runs after it
	return out.map((c) => c.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, ""));
}

// Plan mode (server.mjs): Pi may look around with bash, but nothing that changes the workspace. A best-effort list —
// the plan-mode instructions say the same, this catches a model that forgets.
const WRITES = [
	/^(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|ln|truncate|dd|install|patch|unzip|tar\s+-?x)\b/,
	/^(sed|perl)\s+(-[a-zA-Z]*\s+)*-i/,
	/^git\s+(add|commit|push|pull|checkout|switch|restore|reset|revert|merge|rebase|stash|apply|am|cherry-pick|clean|rm|mv|init|clone|tag|branch\s+-[dDmM])\b/,
	/^(npm|pnpm|yarn|bun)\s+(i|install|ci|add|remove|rm|uninstall|update|upgrade|publish|link|init|create)\b/,
	/^(pip3?|pipx|uv|poetry|cargo|go)\s+(install|uninstall|add|remove|get|mod\s+tidy|init)\b/,
	/^gh\s+\S+\s+(create|delete|deploy|edit|merge|close|set|enable|disable)\b/,
	/^(kubectl|oc|helm)\s+(apply|create|delete|patch|replace|scale|rollout|install|upgrade|uninstall)\b/,
];
/** Does this shell line (probably) change files, packages, git or anything outside? */
export function writesSomething(line) {
	// redirecting output into a file (`>`, `>>`, `tee`) writes, /dev/null does not
	if (/(^|[^0-9&])>>?\s*(?!\/dev\/null\b|&)\S/.test(String(line)) || /\btee\b/.test(String(line))) return true;
	return commandsOf(line).some((cmd) => WRITES.some((re) => re.test(cmd)));
}

/** "allow" | "ask" | "deny" for one shell line. */
export function decide(line, rules = DEFAULT_RULES) {
	const entries = Object.entries(rules).map(([p, a]) => [globRe(p), a]);
	let verdict = "allow";
	for (const cmd of commandsOf(line)) {
		let a = "allow";
		for (const [re, action] of entries) if (re.test(cmd)) a = action;
		if (a === "deny") return "deny";
		if (a === "ask") verdict = "ask";
	}
	return verdict;
}
