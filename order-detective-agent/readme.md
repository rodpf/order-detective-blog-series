# order-detective-agent

A LangGraph agent that calls the `order-detective` CAP/MCP service (see the
sibling project in this repo) for data and GenAI Hub for reasoning, exposed
to SAP Joule via the A2A protocol. Companion code for a 3-part blog series
on building a pro-code agent on SAP BTP - see the [root README](../README.md)
for links to all three posts and how this repo's tags map to them.

Deliberately a separate deployable from `order-detective` - it never
imports `@sap/cds`, and only knows about `order-detective` through a URL.

**This branch (`part-3-async`) adds asynchronous A2A with Joule push
notifications:** the agent acknowledges Joule's request within milliseconds,
works in the background, and posts progress updates and the final answer
back to Joule's callback API on behalf of the signed-in user. The full
step-by-step setup (IAS apps, BTP destinations, capability change, demo
mode, troubleshooting) is in the **[async tutorial](../README-async.md)**.
This README covers the project itself and points there for the async setup.

## Project layout

```
order-detective-agent/
├── src/
│   ├── mcp-client.ts            MCP client wrapper (Part 2)
│   ├── tools.ts                 traceOrder as a LangChain tool (Part 2)
│   ├── agent.ts                 LangGraph agent + GenAI Hub (Part 2)
│   ├── index.ts                 CLI entrypoint (Part 2)
│   ├── test-mcp-client.ts       standalone MCP smoke test (Part 2)
│   ├── a2a-agent-executor.ts    bridges A2A events to the agent (Part 3; async path added on this branch)
│   ├── a2a-server.ts            Express app exposing the A2A endpoint (Part 3; push notifications on this branch)
│   └── joule-client.ts          Destination-service exchange + Joule callback envelopes (async branch)
├── test/
│   └── webhook-receiver.ts      local stand-in for Joule's callback endpoint (async branch)
├── joule-capability/            Joule pro-code capability YAML (Part 3)
│   ├── capability.sapdas.yaml
│   ├── scenarios/order_detective_agent_scenario.yaml
│   └── functions/order_detective_agent_function.yaml   (pushNotifications enabled on this branch)
├── da.sapdas.yaml                standalone test-assistant descriptor (Part 3)
├── manifest.yaml                 Cloud Foundry deployment config (Part 3)
├── package.json
├── tsconfig.json
└── .env.example
```

## A note on the GenAI Hub client choice

This project uses `OrchestrationClient` exclusively, not
`AzureOpenAiChatClient` - specifically so switching model providers (GPT,
Claude, Gemini) is a `.env` change, not a code change. That requires an
**orchestration-scenario** AI Core deployment, not a **foundation-models**
one - pointing this at the wrong deployment type fails with `"Subpath
'v2/completion' is not allowed"`. Check AI Launchpad's Deployments view for
the scenario type if you're not sure which you have.

## Sync and async modes

The agent decides per request, based on what Joule sends:

- **Sync (Part 3 behaviour)** - no `pushNotificationConfig` in the request.
  The agent runs inline and returns the answer in the same HTTP response.
  Joule waits at most **60 s** for this response.
- **Async (this branch)** - the request carries
  `configuration.pushNotificationConfig.url`, which Joule sends once the
  capability has `pushNotifications: true`. The agent replies `working`
  immediately, then runs in the background and POSTs updates and the final
  answer to that callback, authenticated with a token exchanged from the
  user's own JWT via the BTP Destination service.

Requires `@a2a-js/sdk` 1.3.0 or later (inbound headers are read via
`STATE_HEADERS_KEY`).

## Local setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

- `MCP_SERVER_URL` - defaults to `http://localhost:4004/mcp/order`, matching
  `order-detective` running locally. Update once that project is deployed
  elsewhere.
- `GENAI_HUB_DEPLOYMENT_ID` / `GENAI_HUB_MODEL` - deployment ID is preferred
  when set (unambiguous); otherwise the SDK auto-discovers a deployment
  serving `GENAI_HUB_MODEL` in your resource group. Model name is required
  either way.
- `GENAI_HUB_RESOURCE_GROUP` - optional, only needed if your AI Core resource
  group isn't literally named `default`. Ignored whenever
  `GENAI_HUB_DEPLOYMENT_ID` is set.
- `AICORE_SERVICE_KEY` - the full service key as **one JSON string**, not
  separate fields. This SDK only reads `AICORE_SERVICE_KEY` (or an actual CF
  service binding) - unlike SAP's Python SDK, it does not read
  `AICORE_CLIENT_ID`/`AICORE_CLIENT_SECRET`/etc. as separate vars. On Cloud
  Foundry: `cf create-service-key <your-ai-core-instance> agent-key`, then
  `cf service-key <your-ai-core-instance> agent-key` and paste the entire
  JSON output (not the command's preamble line) as one single-quoted value.
- `PORT` - optional, the A2A server listens on `8080` by default.

Async-only settings (see the [async tutorial](../README-async.md), sections
6 and 9):

- `DEST_TOKEN_URL`, `DEST_SERVICE_URL`, `DEST_CLIENT_ID`,
  `DEST_CLIENT_SECRET`, `DEST_NAME` - Destination service credentials for
  the callback hop. Only needed on CF (or locally against real Joule).
- `SKIP_DEST_EXCHANGE=true` - **local testing only**: post callbacks
  straight to the URL in the request, no token exchange.
- `ASYNC_TEST_DELAY_MS` / `ASYNC_TEST_INTERVAL_MS` - **demo only**: force a
  wait with numbered `Working n` updates before the agent runs.

## Run it locally

Start `order-detective` first (`npx cds serve` in that project, default
port 4004). Then:

```bash
# Test just the MCP connection - no LLM, no AI Core credentials needed
npm run test-mcp

# Run the agent directly via CLI, no A2A/Joule involved
npm run dev "Why is order 4500001234 late?"

# Run the A2A server locally
npm run a2a-dev
```

With the A2A server running, verify it directly (sync mode):

```bash
curl http://localhost:8080/.well-known/agent-card.json

curl -s -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"test-1","method":"message/send","params":{"message":{"role":"user","parts":[{"text":"Why is order 4500001234 late?","kind":"text"}],"messageId":"msg-001","kind":"message"}}}'
```

A completed response with the answer at `result.artifacts[0].parts[0].text`
confirms the whole chain works before anything touches Cloud Foundry or Joule.
The agent card should now show `"pushNotifications": true`.

### Async mode locally

No IAS or destinations needed - a local webhook stands in for Joule:

```bash
# Terminal 1 - fake Joule callback endpoint on http://localhost:9000/callback
npx tsx test/webhook-receiver.ts

# Terminal 2 - agent with test-mode callbacks and a 15 s demo wait
SKIP_DEST_EXCHANGE=true ASYNC_TEST_DELAY_MS=15000 ASYNC_TEST_INTERVAL_MS=5000 npm run a2a-dev

# Terminal 3 - same request, plus a push config
curl -s -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -H "conversationid: local-conv" -H "x-correlationid: local-corr" \
  -d '{"jsonrpc":"2.0","id":"test-2","method":"message/send","params":{"message":{"role":"user","parts":[{"text":"Why is order 4500001234 late?","kind":"text"}],"messageId":"msg-002","kind":"message"},"configuration":{"pushNotificationConfig":{"url":"http://localhost:9000/callback"}}}}'
```

curl gets a `working` task back immediately; Terminal 1 then logs a
`working` update every 5 s and finally the `completed` envelope with the
answer.

## Deploying to Cloud Foundry

Build locally and push the compiled output - the buildpack only installs
production `dependencies`, so don't rely on compiling `typescript` inside
the CF container itself:

```bash
npm run build
cf push
```

Then wire it to the deployed `order-detective` instance and real AI Core
credentials (routes are per-deployment - check yours with `cf apps`):

```bash
cf set-env order-detective-agent PUBLIC_URL <this app's CF route, with https://>
cf set-env order-detective-agent MCP_SERVER_URL <order-detective's CF route>/mcp/order
cf set-env order-detective-agent AICORE_SERVICE_KEY "$(cf service-key <your-ai-core-instance> agent-key | tail -n +2)"
cf restage order-detective-agent
```

For async, also set the five `DEST_*` variables from a Destination service
key. Client IDs and secrets contain `!`, `|` and `$`, which bash mangles, so
use the Node one-liner in the [async tutorial](../README-async.md), section
6, rather than typing them into `cf set-env`. Don't set `SKIP_DEST_EXCHANGE`
on CF.

`cf logs order-detective-agent` shows one `[request]` line per call (method,
push URL, whether a token arrived, correlation IDs - never token values), an
`[inbound]` line in async mode, and one `[joule-client] pushed <state> …`
line per callback.

## Registering with Joule

1. Create a BTP destination named `ORDER_DETECTIVE_AGENT` (Connectivity →
   Destinations), pointed at the agent's CF route. On the Part 3 tag this
   is `NoAuthentication`; **on this branch it's `OAuth2JWTBearer`** with the
   IAS proxy-app chain, so the user's token reaches the agent. Async also
   needs a second destination, `JOULE_ASYNC_API`. Exact values for both:
   [async tutorial](../README-async.md), sections 4-5.
2. Install and log in to the Joule CLI (`npm install -g @sap/joule-studio-cli`,
   then `joule login` with credentials from your Joule service instance's
   service key). If the client ID's `!` breaks the command, see the async
   tutorial, section 8.
3. `joule deploy -c -n "order_detective_test"` from this folder (where
   `da.sapdas.yaml` lives) - deploys into an isolated standalone test
   assistant, safe to experiment in.
4. `joule launch "order_detective_test"` - opens the test webclient. Ask it
   the same questions used throughout local testing.
5. Once verified, `joule update "sap_digital_assistant" --capability-file
   joule-capability/capability.sapdas.yaml` promotes the same capability to
   the real assistant.

## What's deliberately not implemented

This is still an MVP, not a production deployment - worth being explicit
about the gap rather than pretending otherwise:

- `AICORE_SERVICE_KEY` is a portable but long-lived secret in an environment
  variable; a real service binding is the more defensible production posture.
- The A2A server forwards the inbound user JWT but **doesn't validate it**
  (`UserBuilder.noAuthentication`). A forged token would fail at the
  Destination service exchange, but only after the agent's own work has run.
  Validate issuer, audience and signature (IAS JWKS) before doing any work.
- The user's identity stops at the agent: the MCP call to `order-detective`
  is still anonymous. Propagating it further is the same pattern again, one
  hop down.
- Tasks live in memory (`InMemoryTaskStore`). Fine for single-turn async; a
  restart loses in-flight tasks, and multi-turn follow-ups would fail with
  "Task not found".
- The `[request]` diagnostic logger and the `ASYNC_TEST_*` demo settings are
  for development and demos - remove or unset them for production.
