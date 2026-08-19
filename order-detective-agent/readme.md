# order-detective-agent

A LangGraph agent that calls the `order-detective` CAP/MCP service (see the
sibling project in this repo) for data and GenAI Hub for reasoning, exposed
to SAP Joule via the A2A protocol. Companion code for a 3-part blog series
on building a pro-code agent on SAP BTP - see the [root README](../README.md)
for links to all three posts and how this repo's tags map to them.

Deliberately a separate deployable from `order-detective` - it never
imports `@sap/cds`, and only knows about `order-detective` through a URL.

## Project layout

```
order-detective-agent/
├── src/
│   ├── mcp-client.ts            MCP client wrapper (Part 2)
│   ├── tools.ts                 traceOrder as a LangChain tool (Part 2)
│   ├── agent.ts                 LangGraph agent + GenAI Hub (Part 2)
│   ├── index.ts                 CLI entrypoint (Part 2)
│   ├── test-mcp-client.ts       standalone MCP smoke test (Part 2)
│   ├── a2a-agent-executor.ts    bridges A2A events to the agent (Part 3)
│   └── a2a-server.ts            Express app exposing the A2A endpoint (Part 3)
├── joule-capability/            Joule pro-code capability YAML (Part 3)
│   ├── capability.sapdas.yaml
│   ├── scenarios/order_detective_agent_scenario.yaml
│   └── functions/order_detective_agent_function.yaml
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

With the A2A server running, verify it directly:

```bash
curl http://localhost:10000/.well-known/agent-card.json

curl -s -X POST http://localhost:10000 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":"test-1","method":"message/send","params":{"message":{"role":"user","parts":[{"text":"Why is order 4500001234 late?","kind":"text"}],"messageId":"msg-001","kind":"message"}}}'
```

A completed response with the answer at `result.artifacts[0].parts[0].text`
confirms the whole chain works before anything touches Cloud Foundry or Joule.

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

## Registering with Joule

1. Create a BTP destination named `ORDER_DETECTIVE_AGENT` (Connectivity →
   Destinations), pointed at the agent's CF route, `NoAuthentication` for
   this MVP.
2. Install and log in to the Joule CLI (`npm install -g @sap/joule-studio-cli`,
   then `joule login` with credentials from your Joule service instance's
   service key).
3. `joule deploy -c -n "order_detective_test"` - deploys into an isolated
   standalone test assistant, safe to experiment in.
4. `joule launch "order_detective_test"` - opens the test webclient. Ask it
   the same questions used throughout local testing.
5. Once verified, `joule update "sap_digital_assistant" --capability-file
   joule-capability/capability.sapdas.yaml` promotes the same capability to
   the real assistant.

## What's deliberately not implemented

This is an MVP, not a production deployment - worth being explicit about
the gap rather than pretending otherwise:

- `AICORE_SERVICE_KEY` is a portable but long-lived secret in an environment
  variable; a real service binding is the more defensible production posture.
- The BTP destination uses `NoAuthentication`; real data behind this hop
  would need real authentication.
- No IAS App2App trust or principal propagation - the agent currently acts
  as an anonymous service identity, not as the calling user. Relevant the
  moment this touches anything more sensitive than synthetic demo data.
- No async/push-notification support - fine here since every call completes
  in seconds, a real consideration for slower backends.
