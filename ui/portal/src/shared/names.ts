// Friendly default names: most users don't know what to call a workspace, and
// an empty required field is a tiny wall. Editable, of course.
import { useCallback, useEffect, useRef, useState } from "react";

const NAME_ADJ = [
  "blue", "sunny", "swift", "cosy", "brave", "calm", "coral", "crisp",
  "dapper", "eager", "fjord", "gentle", "golden", "happy", "keen", "lively",
  "lucky", "mellow", "nimble", "polar", "quiet", "rosy", "spry", "velvet",
  "amber", "breezy", "cedar", "dusky", "frosty", "misty", "pine", "silver",
];
const NAME_NOUN = [
  "squash", "otter", "maple", "comet", "pebble", "willow", "falcon", "lagoon",
  "ember", "tundra", "sparrow", "biscuit", "meadow", "anchor", "juniper", "puffin",
  "harbor", "clover", "walrus", "sorbet", "lantern", "moose", "fjell", "waffle",
  "aurora", "bramble", "cabin", "drift", "glacier", "heron", "saga", "viking",
];

/**
 * Suggest an adjective-noun name the user doesn't already have; a numeric
 * suffix on `fallbackPrefix` as last resort. Every generated name satisfies
 * the strictest server rule we have (DNS-1035: starts with a letter,
 * lowercase alphanumerics and single dashes, ≤31 chars).
 */
export function randomName(taken?: Set<string>, fallbackPrefix = "workspace"): string {
  for (let i = 0; i < 30; i++) {
    const n = `${NAME_ADJ[Math.floor(Math.random() * NAME_ADJ.length)]}-${NAME_NOUN[Math.floor(Math.random() * NAME_NOUN.length)]}`;
    if (!taken?.has(n)) return n;
  }
  return `${fallbackPrefix}-${Math.floor(Math.random() * 10000)}`;
}

/**
 * Coerce user input towards a legal name: lowercase, only `[a-z0-9-]`, no
 * leading or double hyphens, ≤31 chars.
 *
 * `typing: true` keeps a single trailing hyphen — otherwise the dash in
 * "keen-otter" would vanish the moment it is typed. Call it without the flag
 * (or trust the submit path) to get the final, trimmed form.
 */
export function sanitizeName(v: string, opts?: { typing?: boolean }): string {
  const s = v
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+/, "")
    .slice(0, 31);
  return opts?.typing ? s : s.replace(/-+$/, "");
}

/**
 * A pre-filled name field that quietly re-rolls when the loaded list turns out
 * to already contain the suggestion — but never touches a name the user typed.
 * `taken` must be referentially stable (build it with `useMemo`).
 */
export function useSuggestedName(taken: Set<string>, fallbackPrefix: string) {
  const [name, setName] = useState(() => randomName(undefined, fallbackPrefix));
  const suggested = useRef(name);

  useEffect(() => {
    if (name === suggested.current && taken.has(name)) {
      const fresh = randomName(taken, fallbackPrefix);
      suggested.current = fresh;
      setName(fresh);
    }
  }, [taken, name, fallbackPrefix]);

  /** After a successful create: suggest another, excluding the name just used. */
  const reroll = useCallback(
    (justUsed: string) => {
      const fresh = randomName(new Set(taken).add(justUsed), fallbackPrefix);
      suggested.current = fresh;
      setName(fresh);
    },
    [taken, fallbackPrefix],
  );

  return { name, setName, reroll };
}
