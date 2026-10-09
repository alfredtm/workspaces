// Post-unpack patches for the Claude Code extension (plugins/claude-code). Idempotent — re-run after every
// plugin update, and in the prod image build right after unpacking the vsix.
//   1. CSP: `font-src ${cspSource}` blocks the extension's own inline data: codicon font in webview/index.css
//      → console errors + missing glyphs. Add ` data:`.
//   2. "Browse the web" (Chrome browser-integration MCP) needs a local Chrome extension — impossible from a
//      remote workspace. It is gated by isBrowserIntegrationSupported() (true for claude.ai logins); force false.
//   3. The "Prefer the Terminal experience?" banner defaults to hidden.
// Usage: node patch-claude.mjs [plugins/claude-code]
import fs from 'node:fs';
import path from 'node:path';
const dir = process.argv[2] || new URL('./plugins/claude-code', import.meta.url).pathname;
const file = path.join(dir, 'extension.js');
let src = fs.readFileSync(file, 'utf8');
const patches = [
  { name: 'csp font-src data:', re: /font-src \$\{([A-Za-z_$][\w$]*)\.cspSource\}(?! data:)/g, to: 'font-src ${$1.cspSource} data:' },
  // 3. "Prefer the Terminal experience? Switch back in Settings." banner: shown while the stored flag is unset.
  //    Default it to hidden (users can't switch to a terminal UI here anyway); a stored value still wins.
  //    The minified local holding the stored flag changes name between builds (`x` in 2.1.258, `I` in 2.1.280) —
  //    capture it instead of assuming.
  { name: 'terminal banner hidden by default', re: /globalState\.get\("showTerminalBanner"\);super\(([^;]*?),([A-Za-z_$][\w$]*)===void 0\?!0:\2,/g, to: 'globalState.get("showTerminalBanner");super($1,$2===void 0?!1:$2,' },
  { name: 'browser integration off', re: /isBrowserIntegrationSupported\(\)\{return this\.authManager\.getAuthStatus\(\)\?\.authMethod==="claudeai"\}/g, to: 'isBrowserIntegrationSupported(){return!1}' },
];
for (const p of patches) {
  const n = (src.match(p.re) || []).length;
  if (!n) { console.log(`claude patch: ${p.name}: nothing to do (already patched or shape changed — check manually)`); continue; }
  src = src.replace(p.re, p.to);
  console.log(`claude patch: ${p.name}: ${n} occurrence(s)`);
}
fs.writeFileSync(file, src);

// 4. Webview cosmetics (direction A): rounder prompt box without a hairline, user turns as right-aligned bubbles.
//    Appended to webview/index.css; attribute selectors survive the CSS-module hash suffix changing between versions.
const css = path.join(dir, 'webview', 'index.css');
const MARK = '.ws-soft-islands{}';
let style = fs.readFileSync(css, 'utf8');
if (style.includes(MARK)) { console.log('claude patch: webview cosmetics: already applied'); }
else {
  style += `\n${MARK}:root{--corner-radius-large:14px}` +
    `[class^="inputContainer_"],[class*=" inputContainer_"]{border-color:transparent!important;box-shadow:none!important}` +
    `body.vscode-light [class^="inputContainer_"],body.vscode-light [class*=" inputContainer_"]{border-color:var(--vscode-widget-border)!important}` +
    `[class^="userMessage_"],[class*=" userMessage_"]{background:var(--vscode-input-background);border-radius:14px;padding:10px 14px}\n`;
  fs.writeFileSync(css, style); console.log('claude patch: webview cosmetics: appended');
}

// 5. No native path tooltips inside the webview (file chips carry the absolute path in `title`).
const wjs = path.join(dir, 'webview', 'index.js');
const JSMARK = '/*ws-no-path-tooltips*/';
let js = fs.readFileSync(wjs, 'utf8');
if (js.includes(JSMARK)) { console.log('claude patch: webview path tooltips: already applied'); }
else {
  js += `\n;${JSMARK}(function(){try{var isPath=function(t){return /^(\\/|~\\/|[A-Za-z]:\\\\)/.test(t||"")};var strip=function(n){if(!(n instanceof Element))return;if(n.hasAttribute("title")&&isPath(n.getAttribute("title")))n.removeAttribute("title");n.querySelectorAll("[title]").forEach(function(e){if(isPath(e.getAttribute("title")))e.removeAttribute("title")})};new MutationObserver(function(ms){ms.forEach(function(m){if(m.type==="attributes")strip(m.target);else m.addedNodes.forEach(strip)})}).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:["title"]});strip(document.documentElement)}catch(e){}})();\n`;
  fs.writeFileSync(wjs, js); console.log('claude patch: webview path tooltips: appended');
}

// 6. Plain-language copy in the webview: the prompt placeholder advertises ⌘ Esc / Shift Tab shortcuts that do not
//    work in this shell, and the empty-state tips talk about CLAUDE.md, /model and MCP. Neither helps our users.
const JSMARK6 = '/*ws-plain-copy*/';
let js6 = fs.readFileSync(wjs, 'utf8');
if (js6.includes(JSMARK6)) { console.log('claude patch: plain copy: already applied'); }
else {
  const ASK = '"Ask Claude to change something…"';
  const subs = [
    { name: 'placeholder: focus shortcut', re: /return`\$\{[A-Za-z0-9_$]+\} to focus or unfocus Claude`/g, to: `return${ASK}` },
    { name: 'placeholder: attach shortcut', re: /return`\$\{[A-Za-z0-9_$]+\} to attach selected text`/g, to: 'return"Ask Claude about the selected text…"' },
    { name: 'placeholder: edit', re: /"Ask Claude to edit…"/g, to: ASK },
    { name: 'empty state: first line', re: /"What to do first\? Ask about this codebase or we can start writing code\."/g, to: '"What should we build? Describe it in plain words."' },
  ];
  for (const p of subs) { const n = (js6.match(p.re) || []).length; if (!n) { console.log(`claude patch: ${p.name}: nothing to do (shape changed — check manually)`); continue; } js6 = js6.replace(p.re, p.to); console.log(`claude patch: ${p.name}: ${n}`); }
  // the rotating tips: a memoised array literal starting with the "// TODO: Everything" tip — replace the whole literal
  const start = js6.indexOf('[{text:"// TODO: Everything.');
  if (start < 0) { console.log('claude patch: tips: nothing to do (shape changed — check manually)'); }
  else {
    let depth = 0, end = start; for (; end < js6.length; end++) { const c = js6[end]; if (c === '[') depth++; else if (c === ']') { depth--; if (depth === 0) break; } }
    const tips = '[{text:"Describe what you want in plain words, like \\u201cadd a login page\\u201d."},'
      + '{text:"Claude edits the files for you. Open one on the left to follow along."},'
      + '{text:"When something is running, Open app in the top bar shows it."},'
      + '{text:"Paste an error message and Claude will sort it out."}]';
    js6 = js6.slice(0, start) + tips + js6.slice(end + 1); console.log(`claude patch: tips: replaced ${end + 1 - start} chars`);
  }
  js6 += `\n${JSMARK6}\n`;
  fs.writeFileSync(wjs, js6);
}
