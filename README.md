# pi-extension-ai-gateway

AI Gateway autodiscovery provider for [Pi](https://pi.dev).

`ai-gateway-provider.ts` registers two provider IDs without replacing Pi's built-in `openai` or `anthropic` providers:

- `ai-gateway` uses Pi's `openai-responses` transport.
- `ai-gateway-anthropic` uses Pi's `anthropic-messages` transport.

Both transports are enabled by default. Discovery makes an independent `GET <transportBaseUrl>/v1/models` request for each transport, with `<transportBaseUrl>/models` as a fallback, using Bearer authentication for the OpenAI-compatible pass and `x-api-key` for the Anthropic pass. If the gateway rejects Bearer at its edge, the OpenAI pass retries with both headers. A model-level `api` selector can restrict a model to one transport; when it is omitted, an otherwise-unclassified model is listed under both providers. Exact Pi registry matches and Claude IDs are routed to their native transport automatically, so Claude IDs do not appear under `ai-gateway` unless explicitly overridden. A single `providers.ai-gateway` entry supplies the endpoints, key, explicit model list, and overrides for both registrations. The endpoint(s) must expose the catalog plus the request routes used by the selected transport: `/v1/models`, `/v1/responses`, and `/v1/messages` (normally below `/v1`). The extension keeps these URL roles separate: OpenAI Responses models use a base ending in `/v1`, while Anthropic models use the host root because Pi's Anthropic adapter appends `/v1/messages` itself. Thus a host-root configuration correctly discovers at `<baseUrl>/v1/models` and sends Anthropic requests to `<baseUrl>/v1/messages`.

Use `openaiBaseUrl` and `anthropicBaseUrl` when the gateway has separate front doors, as Codex does with its OpenAI-compatible provider. Each field is optional and overrides `baseUrl` only for its corresponding transport; `baseUrl` remains the fallback for both:

```json
{
  "providers": {
    "ai-gateway": {
      "baseUrl": "https://gateway.example/unified/v1",
      "openaiBaseUrl": "https://gateway.example/openai/v1",
      "anthropicBaseUrl": "https://gateway.example/anthropic/v1",
      "apiKey": "$PRICETAG_KEY"
    }
  }
}
```

When a catalog entry omits metadata, the extension matches its exact model ID against Pi's bundled/runtime registry and inherits the known name, context window, output limit, reasoning support, thinking-level map, input modalities, input limits, cache metadata, sampling defaults, compatibility flags, and cost. Gateway-provided metadata wins. Use Pi's `modelOverrides` when the gateway's actual limits differ:

```json
{
  "providers": {
    "ai-gateway": {
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "$PRICETAG_KEY",
      "modelOverrides": {
        "gpt-5": {
          "contextWindow": 400000,
          "maxTokens": 128000,
          "reasoning": true,
          "thinkingLevelMap": {
            "off": null,
            "low": "low",
            "medium": "medium",
            "high": "high"
          }
        }
      }
    }
  }
}
```

## Add GPT or other models omitted by `/v1/models`

Autodiscovery cannot invent models that the gateway catalog does not advertise. Add an explicit model entry to the one `ai-gateway` configuration; it is merged with the live catalog and is available through the matching transport:

```json
{
  "providers": {
    "ai-gateway": {
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "$API_KEY",
      "models": [
        { "id": "gpt-5", "api": "openai-responses" },
        { "id": "gpt-5.4", "api": "openai-responses" },
        { "id": "claude-sonnet-5", "api": "anthropic-messages" }
      ]
    }
  }
}
```

An exact Pi registry match fills metadata for entries such as `gpt-5`. The gateway still has to accept the model ID at `/responses`; the entry only makes it selectable. Add `contextWindow`, `maxTokens`, `reasoning`, `input`, or other fields when the ID is custom or the gateway differs from Pi's registry.

The selector is the standard per-model Pi `api` field. Supported values here are `openai-responses` and `anthropic-messages`. If a gateway model works with both transports, omit `api`; the extension exposes it through both provider IDs. For an explicit multi-transport allowlist, the extension also accepts an `apis` array on the model entry, for example `{ "id": "shared-model", "apis": ["openai-responses", "anthropic-messages"] }`.

Discovery only exposes IDs returned by the selected transport's gateway catalog. The unified gateway host used during development advertises Claude, Qwen, and GLM models but no GPT models (`has_more: false`); its separate OpenAI-compatible host advertises the GPT catalog.

## Authentication and endpoint configuration

Store a key under the custom provider ID in `auth.json`:

```json
{
  "ai-gateway": {
    "type": "api_key",
    "key": "sk-..."
  }
}
```

The Anthropic transport reuses this credential. A separate `ai-gateway-anthropic` credential may be supplied when it needs a different key. The existing `openai` and `anthropic` credentials remain independent.

In `models.json`, the key may use any environment variable name, for example `$API_KEY`; it does not need to be named `OPENAI_RESPONSES` or `AI_GATEWAY_API_KEY`:

```json
{
  "providers": {
    "ai-gateway": {
      "baseUrl": "https://gateway.example/v1",
      "apiKey": "$API_KEY"
    }
  }
}
```

`AI_GATEWAY_OPENAI_BASE_URL` / `PI_AI_GATEWAY_OPENAI_BASE_URL` and `AI_GATEWAY_ANTHROPIC_BASE_URL` / `PI_AI_GATEWAY_ANTHROPIC_BASE_URL` override the corresponding transport URL. `AI_GATEWAY_BASE_URL` / `PI_AI_GATEWAY_BASE_URL` remain the shared fallback, and `AI_GATEWAY_API_KEY` is the key fallback. Pi's normal provider configuration and model overrides continue to apply on top of the extension.

## Install

After renaming the repository to `pi-extension-ai-gateway`, install it directly from GitHub:

```bash
pi install git:github.com/tumido/pi-extension-ai-gateway
```

To load the extension from a checkout without changing Pi settings:

```bash
pi -e ./extensions/ai-gateway-provider.ts --list-models
```

For project-local development, register the checkout in `.pi/settings.json`:

```bash
pi install . --local
```
