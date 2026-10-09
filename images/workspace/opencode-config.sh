#!/usr/bin/env bash
# Generate the platform's OpenCode config from the LLM_* environment. Installed in
# the image as /usr/local/bin/workspace-opencode-config; the entrypoint runs it on
# every boot.
#
#   workspace-opencode-config <target.json>
#
# Writes one OpenCode provider per inference endpoint (any OpenAI-compatible server,
# `@ai-sdk/openai-compatible`) so the editor's OpenCode panel and the `opencode` CLI
# in a terminal see the same models. services/pi/models.mjs reads the same contract.
#
#   endpoint 1: LLM_BASE_URL, LLM_API_KEY, LLM_MODELS (comma list of model ids),
#               optional LLM_LABEL (the provider's display name, default "Inference"),
#               LLM_CONTEXT + LLM_OUTPUT (token limits; OpenCode wants both or neither),
#               LLM_REASONING (off|low|medium|high|max: the `reasoning_effort` sent by
#               default; off = none sent, the model's own default),
#               LLM_REASONING_OPTIONS (a JSON object deep-merged into every model's
#               options, i.e. into the request body — for server-specific switches such
#               as {"chat_template_kwargs":{"enable_thinking":true}} on vLLM/SGLang),
#               LLM_IMAGES (a regex over model ids: the models that take images; unset =
#               none, `.` = all)
#   endpoint N: LLM_<N>_BASE_URL, LLM_<N>_API_KEY, LLM_<N>_MODELS, … same suffixes
#
# Discovery stops at the first missing _BASE_URL. Endpoint 1 is provider `llm`,
# endpoint N is `llm-<N>`; the default model is the first model of the first complete
# endpoint. A model's `options` are forwarded by OpenCode into the request body
# (`reasoningEffort` → `reasoning_effort`, everything else verbatim). An unknown level,
# malformed JSON or a bad regex is logged and ignored — a bad setting must never stop
# a pod from booting.
#
# Keys never land in the file: options use OpenCode's `{env:VAR}` indirection and
# resolve from the process environment (the pod's optional inference Secret, envFrom).
# Without a complete endpoint the target is removed and the script exits 0 — OpenCode
# then shows its own provider setup.
#
# The caller points OpenCode at the file with OPENCODE_CONFIG=<target.json>; OpenCode
# deep-merges it with the user's own ~/.config/opencode/opencode.json, so personal
# settings (theme, keybinds, extra providers) survive.
set -euo pipefail
target=${1:?usage: workspace-opencode-config <target.json>}

if [ -z "${LLM_BASE_URL:-}" ]; then
    rm -f "$target"
    echo "opencode-config: LLM_* not set — no platform OpenCode config" >&2
    exit 0
fi

# The thinking preset for a level: the effort OpenCode sends as `reasoning_effort`.
reasoning_preset() {
    case "$1" in
        off)    echo '{}' ;;
        low|medium|high|max) jq -cn --arg e "$1" '{reasoningEffort:$e}' ;;
        *)      return 1 ;;
    esac
}

# The per-model `options` for one endpoint prefix: preset deep-merged with the raw
# JSON override. Prints `{}` when neither is set or both are unusable.
reasoning_options() {
    local level_var="${1}_REASONING" raw_var="${1}_REASONING_OPTIONS"
    local level raw out='{}' preset parsed
    level=$(tr '[:upper:]' '[:lower:]' <<<"${!level_var:-}" | tr -d '[:space:]')
    raw=${!raw_var:-}
    if [ -n "$level" ]; then
        if preset=$(reasoning_preset "$level"); then out=$preset
        else echo "opencode-config: ${level_var}=\"$level\" is not one of off|low|medium|high|max — ignored" >&2; fi
    fi
    if [ -n "${raw// /}" ]; then
        if parsed=$(jq -c 'if type == "object" then . else error("not an object") end' <<<"$raw" 2>/dev/null); then
            out=$(jq -c --argjson o "$parsed" '. * $o' <<<"$out")
        else echo "opencode-config: ${raw_var} is not a JSON object — ignored" >&2; fi
    fi
    echo "$out"
}

# The card's "Thinking" choice (Low | Medium | High | Max): one OpenCode variant per level
# on every model, so a message with `variant: "high"` asks for more effort and one
# without keeps the endpoint default. services/pi maps the same names onto its level.
VARIANTS=$(for level in low medium high max; do reasoning_preset "$level" | jq -c --arg l "$level" '{($l): .}'; done | jq -cs 'add')

# Provider objects, one per endpoint, as a JSON array of {id, entry}.
providers='[]'
default_model=''
for n in $(seq 1 32); do
    if [ "$n" = 1 ]; then prefix=LLM; id=llm
    else prefix="LLM_$n"; id="llm-$n"; fi
    base_var="${prefix}_BASE_URL"; key_var="${prefix}_API_KEY"
    base=${!base_var:-}; [ -n "$base" ] || break
    key=${!key_var:-}
    models_var="${prefix}_MODELS"; label_var="${prefix}_LABEL"; ctx_var="${prefix}_CONTEXT"; out_var="${prefix}_OUTPUT"; images_var="${prefix}_IMAGES"
    models=${!models_var:-}; ctx=${!ctx_var:-}; out=${!out_var:-}; images=${!images_var:-}
    label=${!label_var:-}; label=${label:-Inference}
    if [ -z "$key" ] || [ -z "$models" ]; then continue; fi   # incomplete block: skip, keep walking
    # _IMAGES must be a regex jq can compile; anything else means "no model takes images"
    if [ -n "$images" ] && ! jq -en --arg r "$images" '"" | test($r) | . or true' >/dev/null 2>&1; then
        echo "opencode-config: ${images_var} is not a valid regex — ignored" >&2
        images=''
    fi
    options=$(reasoning_options "$prefix")
    entry=$(jq -n --arg id "$id" --arg name "$label" --arg base_var "$base_var" --arg key_var "$key_var" \
                  --arg models "$models" --arg ctx "$ctx" --arg out "$out" --argjson options "$options" \
                  --arg images "$images" --argjson variants "$VARIANTS" '
        ($models | split(",") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0))) as $ids
        # OpenCode validates `limit` as {context, output} — both or neither.
        | (if $ctx != "" and $out != "" then {context: ($ctx | tonumber), output: ($out | tonumber)} else {} end) as $limit
        | {
            id: $id,
            entry: {
              npm: "@ai-sdk/openai-compatible",
              name: $name,
              options: { baseURL: ("{env:" + $base_var + "}"), apiKey: ("{env:" + $key_var + "}") },
              models: ([$ids[] | {
                key: .,
                value: ({ name: . }
                        + (if ($limit | length) > 0 then {limit: $limit} else {} end)
                        + (if ($options | length) > 0 then {options: $options} else {} end)
                        + {variants: $variants}
                        + (if $images != "" and test($images; "i") then {attachment: true, modalities: {input: ["text", "image"], output: ["text"]}} else {} end))
              }] | from_entries)
            }
          }')
    providers=$(jq -c --argjson e "$entry" '. + [$e]' <<<"$providers")
    if [ -z "$default_model" ]; then
        first=$(cut -d, -f1 <<<"$models" | tr -d '[:space:]')
        default_model="$id/$first"
    fi
done

if [ "$providers" = '[]' ]; then
    rm -f "$target"
    echo "opencode-config: no complete LLM_* endpoint — no platform OpenCode config" >&2
    exit 0
fi

# Platform brief + skill for OpenCode (images/workspace/dotfiles/opencode/, baked at
# /etc/opencode-defaults; OPENCODE_DEFAULTS points elsewhere, e.g. the repo copy in a lab).
# `instructions` is always in the system prompt, `skills.paths` is loaded on demand.
defaults=${OPENCODE_DEFAULTS:-/etc/opencode-defaults}
instructions='[]'; skill_paths='[]'
[ -f "$defaults/AGENTS.md" ] && instructions=$(jq -cn --arg p "$defaults/AGENTS.md" '[$p]')
[ -d "$defaults/skills" ] && skill_paths=$(jq -cn --arg p "$defaults/skills" '[$p]')

mkdir -p "$(dirname "$target")"
jq -n --argjson providers "$providers" --arg model "$default_model" --argjson instructions "$instructions" --argjson skill_paths "$skill_paths" '{
    "$schema": "https://opencode.ai/config.json",
    share: "disabled",
    autoupdate: false,
    provider: ($providers | map({key: .id, value: .entry}) | from_entries),
    model: $model,
    # The configured endpoints only: OpenCode ships a built-in "opencode" provider of
    # hosted models that would otherwise appear in the picker.
    disabled_providers: ["opencode"],
    # Shell commands run without asking — the workspace is the sandbox (its own disk
    # and container), and asking for everything only teaches people to click Yes.
    # The editor'"'"'s OpenCode card still asks (Yes / Yes and remember the pattern for
    # this project / No, or say what to do instead) for the few commands that can'"'"'t
    # be undone or reach beyond the machine: deleting files, pushing code / changing
    # GitHub repos, publishing packages, and `opencode run` (a second OpenCode, often
    # with --auto, that would run all of the above unasked). OpenCode checks each
    # command of a pipeline on its own, the LAST matching rule wins, and "rm *" also
    # matches a bare "rm". Edits and web fetches run without a prompt too.
    permission: {
      edit: "allow",
      webfetch: "allow",
      bash: {
        "*": "allow",
        "rm *": "ask",
        "git push *": "ask",
        "gh repo *": "ask",
        "npm publish *": "ask",
        "opencode run *": "ask"
      }
    }
}
+ (if ($instructions | length) > 0 then { instructions: $instructions } else {} end)
+ (if ($skill_paths | length) > 0 then { skills: { paths: $skill_paths } } else {} end)' > "$target"
echo "opencode-config: wrote $target ($(jq -r '.provider | keys | join(", ")' "$target"); default $default_model; brief: $(jq -r '(.instructions // []) | length' "$target"), skills: $(jq -r '(.skills.paths // []) | length' "$target"))" >&2
