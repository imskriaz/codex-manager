# Manager API proxy audit

9router is a reference for compatibility pitfalls. Manager routes the active saved account to the Codex Responses backend; it does not implement every provider or endpoint offered by 9router.

## Fixes from the compatibility audit

| Edge case | Product behavior | Regression coverage |
| --- | --- | --- |
| Claude base URL or default subagent model points at Anthropic | Connection setup uses the Manager host root and catalogue model placeholders for main/default models | `tools/check-api-workspace-ui.mjs` |
| Claude tool results include screenshots or errors | Preserve text and error markers; forward images as user image content with the tool identity | `test/aiProxy.test.ts`, `test/aiProxyEdgeCases.test.ts` |
| Empty or omitted tool-result content | Preserve an empty result in Claude, Chat Completions, and Responses | `test/aiProxyEdgeCases.test.ts` |
| Claude disables parallel tool use | Translate the restriction to `parallel_tool_calls: false` | `test/aiProxyEdgeCases.test.ts` |
| Claude requests structured JSON output | Translate `output_config.format` to Responses JSON schema | `test/aiProxyEdgeCases.test.ts` |
| `output_config` has a format but no effort | Keep adaptive-thinking effort fallback | `test/aiProxyEdgeCases.test.ts` |
| Thinking display is omitted | Suppress reasoning summaries for both streaming and JSON responses | `test/aiProxyEdgeCases.test.ts` |
| Completed response mixes text, reasoning summaries and tools | Preserve Claude output order and expose reported reasoning summaries | `test/aiProxyEdgeCases.test.ts` |
| Truncated response contains a tool call | Report incomplete/length/max_tokens rather than successful tool completion | `test/aiProxyEdgeCases.test.ts` |
| Backend tool arguments are not a JSON object | Report an upstream error; never replace invalid arguments with an invented object | `test/aiProxyEdgeCases.test.ts` |
| Tool arguments arrive at item start, item completion, or final completion | Emit missing arguments once and reject inconsistent prefixes | `test/aiProxyEdgeCases.test.ts` |
| Final text contains an unsent suffix, or arrives without deltas | Forward the missing text once and reject inconsistent prefixes | `test/aiProxyEdgeCases.test.ts` |
| Text transitions to a tool or reasoning | Close the text block; unrelated item completions do not close it | `test/aiProxyEdgeCases.test.ts` |
| Backend cancellation never settles | Release the response and request capacity without waiting for the cancellation callback | `test/aiProxyEdgeCases.test.ts` |
| Claude asks to count tokens without generating | Handle `/v1/messages/count_tokens` locally with authentication, validation, history and Explorer documentation | `test/aiProxy.test.ts`, `test/apiPlayground.test.ts` |
| A local estimate is confused with consumed tokens | Mark the response header `x-manager-token-count: estimate`; store estimated tokens separately from reported usage | `test/aiProxy.test.ts`, `test/aiProxyHistory.test.ts` |
| Count-only request creates a fake account route | Show Local estimate in logs and omit it from the account diagram | `tools/check-api-workspace-ui.mjs` |
| Deep JSON causes recursive estimator overflow | Traverse the estimation input iteratively | `src/services/aiProxy.ts` |
| Model discovery credential read stalls or client disconnects | Bound reads and honor cancellation; verify active account ownership before serving cached results | `test/aiProxy.test.ts` |
| Backend catalogue includes malformed rows | Skip malformed rows while retaining valid visible models | `test/aiProxy.test.ts` |
| Incorrect HTTP method on model routes | Return 405 with `Allow: GET` | `test/aiProxy.test.ts` |
| Invalid model URL encoding | Return a client error | `src/services/aiProxy.ts` |
| Negative, fractional or impossible cached usage | Validate token counts and keep cached tokens within reported input | `test/aiProxyEdgeCases.test.ts` |
| Unsupported system image is silently discarded | Reject non-text instructions explicitly | `test/aiProxy.test.ts` |
| Invalid thinking mode or error flag | Reject the input before upstream work | `test/aiProxy.test.ts` |
| Unsupported server context editing is silently ignored | Reject edits other than clearing prior thinking | `test/aiProxyEdgeCases.test.ts` |

## Existing behavior covered by regression checks

- Disabled API access; missing, malformed, conflicting, revoked, scoped or ungranted keys.
- Enabled account availability, device ownership, active-account changes and credential renewal.
- Confirmed 401/429 recovery, quota inspection failure, blocked switching and unconfirmed switches.
- No automatic replay after accepted generation, network uncertainty, partial output or upstream failure.
- Model discovery schemas, credential-keyed caching, visibility flags, retrieval and Claude pagination.
- Streaming and JSON responses for Chat Completions, Responses and Claude Messages.
- UTF-8/chunk boundaries, CRLF, malformed JSON, partial SSE records, request/response size limits.
- Disconnect/shutdown cancellation, concurrency overflow, capacity release and request time bounds.
- Request IDs, completed/incomplete/failed/cancelled log statuses, safe metadata, isolated history snapshots and bounded retention.
- Usage attribution by key/account; unavailable usage stays distinct from zero; no credentials or message bodies in request history.
- Dashboard mobile/desktop layout, privacy labels, refresh failures, key creation uncertainty and clipboard failures.

## Product and backend limits

- The proxy serves Codex models through compatible wire formats. It does not serve Anthropic models or implement Anthropic billing, signed thinking, server-side tools, Files, Batches, audio, PDF/document input, or Realtime endpoints. Unsupported content is rejected rather than silently discarded.
- Token counting is a character-based estimate, not a model tokenizer. Base64/image size and non-English text can differ substantially from actual consumption. Only backend-reported generation usage contributes to token totals.
- Request history contains the latest 100 metadata records in the current host process and clears on host restart. It is not durable billing history or a lifetime usage total.
- Anthropic caching hints and thinking budgets cannot reproduce Anthropic execution on a Codex backend. Thinking effort is translated where supported; prior Anthropic thinking signatures cannot be replayed as Codex reasoning state.
- Upstream model support, quota, credentials and network availability can change. The proxy reports failures and inconclusive outcomes; a compatibility audit cannot guarantee the absence of every future failure.
