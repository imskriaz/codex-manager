import { ModalShell } from "./primitives";
import { API_ENDPOINTS, apiPayloadExample, type ApiEndpointId } from "./apiPlayground";

const guidance: Record<ApiEndpointId, { fields: string[]; response: string }> = {
  action: {
    fields: [
      "Choose a permitted operation in the Operation selector.",
      "Enter the operation parameters as a JSON object. The Explorer adds the request ID and action envelope.",
      "For scoped keys, choose a granted host project. Inspect /api/schema for available operations."
    ],
    response:
      "Action results report completed, failed, or inconclusive outcomes. Verify current state before retrying a write."
  },
  state: {
    fields: [
      "No request body is needed.",
      "The key must grant state access. Project-scoped keys return only their permitted scope."
    ],
    response: "Returns the current dashboard snapshot as JSON."
  },
  schema: {
    fields: [
      "No request body is needed.",
      "Use this endpoint to check the key name, allowed actions, permissions, and project folders."
    ],
    response: "Returns actions and token metadata. It never returns the secret key value."
  },
  models: {
    fields: [
      "No request body is needed.",
      "Use a host-wide key with aiProxy permission.",
      "Copy a returned model ID into a generation request, or use Load models in the Explorer."
    ],
    response: "Returns a model catalogue. Model discovery does not create a conversation."
  },
  chat: {
    fields: [
      "model: a model ID returned by /v1/models.",
      "messages: an array of role/content messages.",
      "stream: false for a JSON response, true for server-sent events."
    ],
    response: "Returns an OpenAI-compatible choices response with token usage."
  },
  responses: {
    fields: [
      "model: a model ID returned by /v1/models.",
      "input: prompt text or supported structured input.",
      "stream: false for JSON, true for server-sent events."
    ],
    response:
      "Returns a Responses-format object with output and usage. An incomplete response is reported separately from completion."
  },
  messages: {
    fields: [
      "model: a model ID returned by /v1/models.",
      "messages: user and assistant message content.",
      "max_tokens: the requested output limit. Use stream: true for server-sent events."
    ],
    response:
      "Returns Claude-compatible content blocks and usage. External clients may send the Manager key in x-api-key."
  },
  countTokens: {
    fields: [
      "model: a model ID returned by /v1/models.",
      "messages: Claude user and assistant messages; system, tools, tool_choice, and thinking are optional.",
      "This endpoint returns a character-based estimate and does not contact the saved-account backend. Images are not counted with a model tokenizer; x-manager-token-count: estimate identifies the approximation."
    ],
    response: "Returns input_tokens for the supplied Claude context."
  }
};

export function ApiDocsModal(props: {
  endpoint?: ApiEndpointId;
  baseUrl?: string;
  operation: string;
  model?: string;
  onClose: () => void;
}) {
  if (!props.endpoint) return null;
  const endpoint = API_ENDPOINTS.find((item) => item.id === props.endpoint)!;
  const guide = guidance[endpoint.id];
  const payload =
    endpoint.id === "action"
      ? JSON.stringify(
          {
            type: "dashboard:action",
            requestId: "unique-request-id",
            action: props.operation || "getProjectBoard",
            payload: {}
          },
          null,
          2
        )
      : apiPayloadExample(endpoint.id, props.model || "YOUR_MODEL_ID");
  const example = `${endpoint.method} ${props.baseUrl || "https://YOUR_MANAGER_HOST"}${endpoint.path}\nAuthorization: Bearer YOUR_API_KEY${endpoint.method === "POST" ? "\nContent-Type: application/json\n\n" + payload : ""}`;
  return (
    <ModalShell
      open
      title={`${endpoint.label} guide`}
      closeLabel="Close API documentation"
      className="api-docs-modal"
      onClose={props.onClose}
    >
      <div class="api-docs-content">
        <p>{endpoint.description}</p>
        <section>
          <h3>1. Authorize</h3>
          <p>
            Create a key in API keys, then paste it into Bearer token. The Explorer verifies its permissions before
            enabling Send.
            {endpoint.permission === "aiProxy" ? " AI endpoints require host-wide aiProxy permission." : ""}
          </p>
        </section>
        <section>
          <h3>2. Prepare the request</h3>
          <ul>
            {guide.fields.map((field) => (
              <li key={field}>{field}</li>
            ))}
          </ul>
          <pre tabIndex={0} aria-label="Request example">
            {example}
          </pre>
        </section>
        <section>
          <h3>3. Read the result</h3>
          <p>{guide.response}</p>
          <p>
            401: check the key. 403: check its permissions. 429: check quota or proxy capacity. Server errors remain
            visible in the response. Requests are sent once; cancellation or timeout can leave the outcome unconfirmed.
          </p>
        </section>
      </div>
    </ModalShell>
  );
}
