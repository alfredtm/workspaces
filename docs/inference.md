# Inference providers

Every workspace has three assistants:

- **Claude Code** uses each person's own Claude account. They sign in once
  inside their workspace (the editor has a guided sign-in). Nothing to
  configure.
- **OpenCode** and **Pi** use the inference providers you configure: any
  server with an OpenAI-compatible chat completions API. That includes
  OpenAI, OpenRouter, Azure OpenAI, vLLM, SGLang, Ollama, LM Studio,
  LiteLLM and most hosted model APIs.

## Configure with the chart

```yaml
inference:
  providers:
    - label: OpenRouter                       # shown in the model picker
      baseUrl: https://openrouter.ai/api/v1
      apiKey: sk-or-...
      models: anthropic/claude-sonnet-4.5,qwen/qwen3-coder
      images: "^anthropic/"                   # models that accept images (regex)
    - label: In-cluster
      baseUrl: http://vllm.ai.svc:8000/v1
      models: Qwen/Qwen3-Coder-30B-A3B-Instruct
      context: "131072"                       # set context and output together
      output: "16384"
      reasoning: medium
```

The chart stores this in a Secret (`workspace-inference`) in the workspace
namespace. Every workspace reads it as environment variables:
- new workspaces pick it up straight away;
- running ones pick it up at their next start.

To manage the Secret yourself (for example with External Secrets), set
`inference.existingSecret` and give it the keys below.

## The environment contract

The first provider has no number. Further providers add `_2`, `_3`, and so
on. Discovery stops at the first missing `_BASE_URL`.

| Key | Meaning |
|---|---|
| `LLM_BASE_URL` | The API base, usually ending in `/v1` |
| `LLM_API_KEY` | The API key (optional for servers without auth) |
| `LLM_MODELS` | Comma-separated model ids. The first model of the first provider is the default. |
| `LLM_LABEL` | Display name (default `Inference`) |
| `LLM_CONTEXT`, `LLM_OUTPUT` | Context window and maximum output in tokens; set both or neither |
| `LLM_REASONING` | Default reasoning effort: `off`, `low`, `medium`, `high` or `max`. `off` (or unset) sends nothing and lets the model decide. |
| `LLM_REASONING_OPTIONS` | A JSON object merged into every request body, for server-specific switches, e.g. `{"chat_template_kwargs":{"enable_thinking":true}}` on vLLM |
| `LLM_IMAGES` | Regex over model ids: which models accept images (unset = none, `.` = all) |
| `LLM_2_BASE_URL`, `LLM_2_API_KEY`, … | The same keys for provider 2, and so on |

In OpenCode the providers are `llm`, `llm-2` and so on. In the assistant
card they appear as one model list grouped by label. The card's *Thinking*
control (Low, Medium, High, Max) overrides `LLM_REASONING` per message.

API keys never land in config files inside the workspace. OpenCode reads them
from the environment, and the editor removes them from anything it shows.

## Without a provider

If `inference.providers` is empty, Claude Code works as usual. OpenCode
shows its own provider setup, so people can bring their own key, and Pi says
that no models are configured.
