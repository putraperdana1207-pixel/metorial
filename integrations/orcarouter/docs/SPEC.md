# Slates Specification for OrcaRouter

## Overview

OrcaRouter is an OpenAI-compatible AI gateway at `https://api.orcarouter.ai/v1` that routes requests to many model vendors behind one endpoint, one credential, and one wire format. Models are addressed by their vendor-qualified ID (for example `openai/gpt-5.5` or `deepseek/deepseek-v4-pro`). Because the inference surface follows the OpenAI schema, chat completions, tool calls, structured outputs, multimodal content parts, the Responses API, and embeddings all use the same request shapes you would send to OpenAI directly.

This integration exposes the gateway as a named provider with its own configuration, its own credential handling, and a live model catalog. It does not proxy arbitrary endpoints: both origins are fixed OrcaRouter origins (authentication on `https://www.orcarouter.ai`, inference on `https://api.orcarouter.ai/v1`), and each can only be overridden explicitly through integration config or an OrcaRouter-specific environment variable for self-hosted or staging deployments.

## Authentication

OrcaRouter supports two independent authentication methods. Both end in a durable `sk-orca-` API key stored as the credential; neither depends on the other, and either can be selected on its own.

### 1. API Key

Users can paste an existing OrcaRouter API key. The key is sent as `Authorization: Bearer sk-orca-...` to the inference origin. When the host asks for a profile, the integration calls `GET /v1/models` (a non-billing request) to confirm the credential works and reports how many models the key can see.

### 2. OAuth 2.0 + PKCE

OrcaRouter supports an OAuth 2.0 authorization-code flow with PKCE (S256) so a user can authorize the integration without creating and copying a key by hand. The flow issues a durable API key scoped to the user's own OrcaRouter account.

**Flow (loopback redirect, used by the CLI and desktop hosts):**

1. The host opens a loopback listener and supplies a `redirectUri` (for example `http://127.0.0.1:45873/callback`) plus a fresh `state` value.
2. The integration generates a fresh cryptographic `code_verifier` for this attempt, derives `code_challenge = base64url(sha256(verifier))`, and returns an authorize URL on the auth origin:
   `https://www.orcarouter.ai/auth?callback_url=...&code_challenge=...&code_challenge_method=S256&state=...&app_name=Metorial&scope=api`.
   The verifier itself never appears in the URL, in logs, or in any user-facing error. It travels only in the host-persisted `callbackState`.
3. After the user approves, OrcaRouter redirects to `callback_url` with `code` and `state`. The host compares `state` with the value it persisted; the integration compares it again in constant time before touching the code.
4. The integration exchanges the code at `POST https://www.orcarouter.ai/api/v1/auth/keys` with `{ code, code_verifier, code_challenge_method: "S256" }`. No client secret is used. The endpoint lives on the auth origin; `/v1/auth/keys` on the inference origin is not a valid exchange endpoint and is never called.
5. The response contains the issued key and the granted scope. The integration accepts only keys prefixed with `sk-orca-` and only the `api` scope, which is the scope required to call inference. A different scope fails with an actionable message rather than storing a credential that cannot be used.
6. The issued key is stored as the auth output. It is a durable API key, not a refresh token, so there is no refresh grant and no token-refresh handler. If the key is later rejected (HTTP 401/403), the request fails with a `needsReauth` marker and the host asks the user to connect again instead of pretending to refresh.

The integration requests the `api` scope explicitly. Flow B (out-of-band) is not needed for this repository: every host that drives this integration already provides a loopback or HTTPS `redirectUri`, and the Slates CLI listener handles the callback locally.

## Features

### Chat Completions

`send_chat_completion` sends OpenAI-format messages (system, developer, user, assistant, tool) to any model the credential can call. It supports tool definitions and tool choice, structured outputs (`json_object`, `json_schema`, `text`), reasoning effort where the model advertises it, and multimodal content parts. Image content is fail-closed: before sending, the integration reads `GET /v1/models/{vendor}/{slug}` and refuses the request unless the model's `architecture.input_modalities` explicitly includes `image`.

### Responses API

`create_response` calls the OpenAI Responses endpoint for models that advertise the `openai-response` endpoint type. It accepts a string or an array of input items, instructions, tools, and structured output configuration, and returns the output text plus usage.

### Embeddings

`create_embedding` calls the OpenAI-compatible embeddings endpoint with one or more inputs and returns the vectors plus token usage. Use the live catalog with `capability: "embedding"` to find embedding models.

### Model Discovery and Capability Filters

`list_models` reads the live catalog from `GET /v1/models` on the inference origin — never a hand-written list. OrcaRouter's list records include `id`, `name`, `owned_by`, `created`, and `supported_endpoint_types`; the integration normalizes them and can ask OrcaRouter to filter by capability (`chat`, `embedding`, `image`, `video`, `rerank`) at the server.

Capability semantics are explicit:

- `chat` requires `openai`, `anthropic`, `gemini`, or `openai-response` and excludes image-generation, openai-video, and jina-rerank routes.
- `embedding`, `image`, `video`, and `rerank` map to their respective endpoint types.
- Unknown endpoint types are not treated as chat-compatible.

`inputModality` filtering (`text`, `image`, `audio`, `file`, `video`) fails closed: a model without declared input modalities is excluded. Because list records may omit `architecture`, the tool hydrates a bounded set of per-model detail records (`GET /v1/models/{id}`) to check `input_modalities`, with limited concurrency; if metadata cannot be read, the model is excluded rather than guessed.

The catalog is cached for 60 seconds per credential; `refresh: true` forces a new read. Only transient failures (network errors, 429, 5xx) fall back to a small, verified seed catalog that is explicitly labelled `catalogSource: "verified_fallback"` and `degraded: true`. Authentication failures are surfaced, not masked by the fallback.

`get_model` returns the full published metadata for one model: context window, output limit, input/output modalities, endpoint types, supported parameters, and pricing.

## Configuration

The integration has no required configuration. Two optional values exist for non-public deployments:

- `authBaseUrl` — authentication origin; defaults to `https://www.orcarouter.ai`.
- `apiBaseUrl` — inference origin; defaults to `https://api.orcarouter.ai/v1`.

Environment fallbacks use the same names with an `ORCAROUTER_` prefix: `ORCAROUTER_AUTH_BASE_URL`, `ORCAROUTER_API_BASE_URL`, and `ORCAROUTER_BASE_URL` (shared fallback; the inference URL gets a `/v1` suffix when absent). URLs must use HTTPS; plain HTTP is accepted only for loopback hosts so the CLI listener can complete a local login.

## Events

OrcaRouter does not expose a general-purpose webhook or event stream for this integration. Model discovery is pull-based (`GET /v1/models`), and usage and billing are visible through the OrcaRouter console and API outside this Slates integration.
