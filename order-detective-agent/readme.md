# order-detective-agent

A LangGraph agent, in its own project, that calls the `order-detective`
CAP/MCP service (see the sibling project in this repo) for data and GenAI
Hub for reasoning. Companion code for [Part 2 of a blog series on building a
pro-code agent on SAP BTP](#) *(link once published)*.

Deliberately a separate deployable from `order-detective` - it never
imports `@sap/cds`, and only knows about `order-detective` through a URL.

## Project layout

- `src/mcp-client.ts` - MCP client wrapper, connects to `order-detective`
- `src/tools.ts` - wraps `traceOrder` as a LangChain tool (`trace_order`)
- `src/agent.ts` - builds the agent: `createAgent` (LangGraph) +
  `OrchestrationClient` (GenAI Hub, provider-agnostic) + the `trace_order`
  tool + a system prompt
- `src/index.ts` - CLI entrypoint
- `src/test-mcp-client.ts` - standalone MCP connectivity smoke test

## A note on the GenAI Hub client choice

This project uses `OrchestrationClient` exclusively, not
`AzureOpenAiChatClient` - specifically so switching model providers (GPT,
Claude, Gemini) is a `.env` change, not a code change. That requires an
**orchestration-scenario** AI Core deployment, not a **foundation-models**
one - pointing this at the wrong deployment type fails with `"Subpath
'v2/completion' is not allowed"`. Check AI Launchpad's Deployments view for
the scenario type if you're not sure which you have.

## Setup

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
  group isn't literally named `default`.
- `AICORE_SERVICE_KEY` - the full service key as **one JSON string**, not
  separate fields. This SDK only reads `AICORE_SERVICE_KEY` (or an actual CF
  service binding) - unlike SAP's Python SDK, it does not read
  `AICORE_CLIENT_ID`/`AICORE_CLIENT_SECRET`/etc. as separate vars. On Cloud
  Foundry: `cf create-service-key <your-ai-core-instance> agent-key`, then
  `cf service-key <your-ai-core-instance> agent-key` and paste the entire
  JSON output (not the command's preamble line) as one single-quoted value.

## Run it

Start `order-detective` first (`npx cds serve` in that project, default
port 4004). Then:

```bash
# Test just the MCP connection - no LLM, no AI Core credentials needed
npm run test-mcp

# Run the full agent
npm run dev "Why is order 4500001234 late?"
```
