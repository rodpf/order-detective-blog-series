

Readme · MD
# Order Detective: async A2A with Joule push notifications
 
This branch makes the Order Detective agent answer Joule **asynchronously**. Joule calls the agent, the agent acknowledges within milliseconds and closes the request, does the work in the background, and posts progress updates and the final answer back to Joule's callback API, on behalf of the signed-in user.
 
It builds on Part 3 of the series (sync A2A + Joule capability). The Node.js implementation is a port of Felix Bartler's Python reference; see [Credits](#credits).
 
**Result, verified on a live Joule tenant:**
 
| Time | What the user sees in Joule |
|---|---|
| 0 s | Question sent; progress card appears |
| 15 s | Progress card: `Working 1 (15 s)` |
| 30 s | `Working 2 (31 s)` |
| 45 s | `Working 3 (48 s)` |
| 60 s | `Working 4 (60 s)` |
| 65 s | Final answer, ending with `(Async demo: answered 65 s after your question.)` |
 
In sync mode, Joule gives up after **exactly 60 s** (measured: request at 04:06:18, Joule error at 04:07:18, `WebResponse.getStatus() is null`). The async version above delivers at 65 s, after the original HTTP request was closed within milliseconds.
 
---
 
## Contents
 
1. [How it works](#1-how-it-works)
2. [Prerequisites](#2-prerequisites)
3. [Code changes](#3-code-changes)
4. [IAS configuration](#4-ias-configuration)
5. [BTP destinations](#5-btp-destinations)
6. [Agent environment variables](#6-agent-environment-variables)
7. [Joule capability change](#7-joule-capability-change)
8. [Build and deploy](#8-build-and-deploy)
9. [Demo mode: forcing a long-running task](#9-demo-mode-forcing-a-long-running-task)
10. [Testing locally without BTP](#10-testing-locally-without-btp)
11. [Verifying on CF](#11-verifying-on-cf)
12. [Troubleshooting: errors we actually hit](#12-troubleshooting-errors-we-actually-hit)
13. [Findings beyond the reference post](#13-findings-beyond-the-reference-post)
14. [Security and cleanup](#14-security-and-cleanup)
15. [Credits](#credits)
---
 
## 1. How it works
 
```
User ──> Joule
          │  1. Exchanges the user's token via the das-ias dependency "joule-to-proxy"
          │  2. Destination ORDER_DETECTIVE_AGENT (OAuth2JWTBearer) exchanges it again
          │     via "proxy-to-agent" -> token for A2A_Custom_Agent_App
          ▼
   order-detective-agent (CF)
          │  3. message/send arrives with pushNotificationConfig + user JWT
          │     + conversationid / x-correlationid headers
          │  4. Agent replies "working" immediately (HTTP 200 in ms) and returns
          │
          │  ── background ──────────────────────────────────────────────
          │  5. Runs the LangGraph agent (GenAI Hub + MCP -> order-detective-srv)
          │  6. For each update: asks the Destination service for JOULE_ASYNC_API
          │     with X-user-token = user JWT; IAS exchanges it via "agent-to-joule"
          │     -> JWT for the Joule API, still carrying the user's identity
          │  7. POSTs a JSON-RPC-wrapped A2A Task to Joule's callback URL,
          │     echoing conversationid / x-correlationid
          ▼
Joule shows "Working n" updates, then the final answer
```
 
Two token exchanges happen before the agent is even called (steps 1–2), and one more for each callback (step 6). The callback **requires a user token**; see [Findings](#13-findings-beyond-the-reference-post).
 
---
 
## 2. Prerequisites
 
- The Part 3 state of this repo: `order-detective` (CAP + HANA + MCP) and `order-detective-agent` (LangGraph + A2A) deployed to CF, and the Joule capability deployed to a Joule assistant.
- `order-detective-srv` healthy on CF. The `traceOrder` OData call must return data:
```bash
  curl -s "https://<order-detective-srv-route>/odata/v4/order/traceOrder(orderNumber='4500001234')"
```
- Access to the **IAS Admin Console** of the tenant your Joule instance trusts.
- Roles: `extensibility_developer` and `capability_admin` to deploy capabilities, `end_user` to chat with Joule.
- A **Destination service** instance (plan `lite`) in the same subaccount/space.
- `@a2a-js/sdk` **1.3.0 or later** in `order-detective-agent` (it exposes inbound headers via `STATE_HEADERS_KEY`, which this relies on):
```bash
  npm install @a2a-js/sdk@^1.3.0
  npm install -D tsx   # only for the local webhook receiver in section 10
```
 
---
 
## 3. Code changes
 
All in `order-detective-agent/`.
 
### `src/joule-client.ts` (new)
 
The outbound side, Node port of Felix's `joule_client.py`:
 
- **Destination hop.** Gets a client-credentials token for the Destination service, then calls `GET {DEST_SERVICE_URL}/destination-configuration/v1/destinations/{DEST_NAME}` with `X-user-token: <inbound user JWT>`. The Destination service performs the IAS JWT-bearer exchange and returns the Joule-API token (`authTokens[0]`) and the callback URL (`destinationConfiguration.URL`).
- **Envelopes.** Each callback body is a JSON-RPC envelope around an A2A Task:
```json
  {
    "id": "<x-correlationid>",
    "jsonrpc": "2.0",
    "result": {
      "id": "<taskId>", "contextId": "<contextId>", "kind": "task",
      "status": { "state": "completed" },
      "artifacts": [{ "artifactId": "result-<taskId>", "parts": [{ "kind": "text", "text": "<answer>" }] }]
    }
  }
```
  - `completedEnvelope`: final answer in `artifacts` (Joule renders this as the assistant message).
  - `workingEnvelope`: progress update. Text goes in **`status.message`** (Joule shows it as the progress card label) and in `artifacts` with a unique `artifactId` per update.
  - `failedEnvelope`: sent as a **`completed`** message carrying the error text, because Joule accepts `failed` but doesn't display it.
- **`pushTaskUpdate()`** posts the envelope with the correlation headers.
- **Test mode:** `SKIP_DEST_EXCHANGE=true` skips the destination hop and posts straight to the URL from the request, unauthenticated (local testing only).
- **Experimental mode:** `JOULE_CALLBACK_AUTH=client_credentials` uses an IAS client-credentials token instead of the user token. **This does not work with Joule** (see section 13); it's kept only to reproduce that finding.
### `src/a2a-agent-executor.ts` (changed)
 
- Reads the inbound `Authorization`, `conversationid` and `x-correlationid` headers from `requestContext.context.state.get(STATE_HEADERS_KEY)`. This is the Node equivalent of Felix's `context._call_context.state["headers"]`.
- If the request carries `configuration.pushNotificationConfig.url` (async mode):
  1. Publishes a `working` task and **returns immediately**. Returning is what lets the SDK answer Joule's HTTP request.
  2. Runs `runAndCallback()` detached from that promise: optional demo wait with updates, then the agent, then the final callback.
- Without a push config, the original sync path runs unchanged.
- Logs one `[inbound]` line per async request (IDs only, never the JWT).
### `src/a2a-server.ts` (changed)
 
- `capabilities.pushNotifications: true` on the agent card.
- **Important:** `DefaultRequestHandler` is constructed with an `InMemoryPushNotificationStore` and a **no-op `PushNotificationSender`**. With `pushNotifications: true`, the SDK otherwise creates its own sender and fires a push for every event to the same URL, which collides with our callbacks (we saw a near-empty duplicate push arrive at the webhook).
- A diagnostic `[request]` logger: method, configuration keys, push URL, whether `Authorization` is present, correlation IDs and header names. It never logs header values or tokens. Remove it for production if you prefer (section 14).
### `test/webhook-receiver.ts` (new)
 
A local stand-in for Joule's callback endpoint that logs every POST. Run with `npx tsx test/webhook-receiver.ts`.
 
---
 
## 4. IAS configuration
 
Three IAS applications are involved. Two are yours; one is Joule's own (SAP-managed, named `das-ias (<your subaccount>)`).
 
| App | Provided API | Dependency (name → target app / API) | Client secret |
|---|---|---|---|
| `A2A_Custom_Agent_App` (the agent) | `order_detective_agent_api` | `agent-to-joule` → `das-ias` / `joule-api` | yes |
| `A2A_Proxy_App` | `a2a_proxy_app_api` | `proxy-to-agent` → `A2A_Custom_Agent_App` / `order_detective_agent_api` | yes |
| `das-ias (<subaccount>)` (Joule, SAP-managed) | — | **`joule-to-proxy`** → `A2A_Proxy_App` / `a2a_proxy_app_api` | not possible |
 
Steps in the IAS Admin Console (Applications & Resources → Applications):
 
1. **`A2A_Custom_Agent_App`**
   - Create the application.
   - Provided APIs → add `order_detective_agent_api`.
   - Dependencies → add `agent-to-joule`, target `das-ias (<subaccount>)`, API `joule-api`.
   - Client Authentication → Secrets → add a secret. **IAS shows it only once.**
2. **`A2A_Proxy_App`**
   - Create the application.
   - Provided APIs → add `a2a_proxy_app_api`.
   - Dependencies → add `proxy-to-agent`, target `A2A_Custom_Agent_App`, API `order_detective_agent_api`.
   - Client Authentication → add a secret.
3. **`das-ias (<subaccount>)`** (Joule's app)
   - Dependencies → add a dependency named **exactly `joule-to-proxy`**, target `A2A_Proxy_App`, API `a2a_proxy_app_api`.
   - Joule looks for this literal name. Without it, Joule can't get a token for the inbound destination, and fails before calling the agent (`JCore - 5802`).
Values you'll need in the next section:
 
| Value | Where |
|---|---|
| Token Service URL | `https://<ias-tenant>.accounts.ondemand.com/oauth2/token` |
| JWKS URI | `https://<ias-tenant>.accounts.ondemand.com/oauth2/certs` |
| Client ID / secret | per app, from Client Authentication |
 
---
 
## 5. BTP destinations
 
BTP cockpit → your subaccount → Connectivity → Destinations. Both destinations are `OAuth2JWTBearer`, but several properties differ.
 
### `ORDER_DETECTIVE_AGENT`: inbound, Joule → agent
 
This is the existing Part 3 destination (the `system_alias` in the capability), switched from `NoAuthentication`.
 
| Field | Value |
|---|---|
| Name | `ORDER_DETECTIVE_AGENT` |
| Type | HTTP |
| URL | `https://<order-detective-agent-route>/` |
| Proxy Type | Internet |
| Authentication | `OAuth2JWTBearer` |
| Client ID / Secret | **`A2A_Proxy_App`** |
| Token Service URL | `https://<ias-tenant>.accounts.ondemand.com/oauth2/token` |
| Token Service URL Type | Dedicated |
 
Additional properties:
 
| Property | Value |
|---|---|
| `apptoapp` | `true` |
| `tokenService.body.resource` | `urn:sap:identity:application:provider:name:proxy-to-agent` |
| `tokenService.body.token_format` | `jwt` |
| `tokenService.addClientCredentialsInBody` | `false` |
| `x_user_token.jwks_uri` | `https://<ias-tenant>.accounts.ondemand.com/oauth2/certs` |
 
### `JOULE_ASYNC_API`: outbound, agent → Joule callback
 
| Field | Value |
|---|---|
| Name | `JOULE_ASYNC_API` |
| Type | HTTP |
| URL | `https://sapdas.<region>.sapdas.cloud.sap/api/agent/v1/callback/a2a` |
| Proxy Type | Internet |
| Authentication | `OAuth2JWTBearer` |
| Client ID / Secret | **`A2A_Custom_Agent_App`** |
| Token Service URL | `https://<ias-tenant>.accounts.ondemand.com/oauth2/token` |
| Token Service URL Type | Dedicated |
 
Additional properties:
 
| Property | Value |
|---|---|
| `tokenService.body.resource` | `urn:sap:identity:application:provider:name:agent-to-joule` |
| `tokenService.body.token_format` | `jwt` |
| `tokenService.addClientCredentialsInBody` | `true` |
| `x_user_token.jwks_uri` | `https://<ias-tenant>.accounts.ondemand.com/oauth2/certs` |
| `HTML5.DynamicDestination` | `true` |
 
Notes:
 
- The callback URL is the same host for every tenant in a region (e.g. `sapdas.us10.sapdas.cloud.sap`). Joule also sends it in each request as `pushNotificationConfig.url`; the agent logs it in its `[inbound]` line, which is an easy way to confirm yours.
- `addClientCredentialsInBody` is `false` inbound and `true` outbound. That isn't a typo.
- Felix lists `resource`, `token_format`, `addClientCredentialsInBody` and `x_user_token.jwks_uri` as required for the outbound destination. Missing any of them typically shows up as `Retrieval of OAuthToken failed due to: unexpected error`.
---
 
## 6. Agent environment variables
 
### Destination service credentials
 
The agent needs a key for the Destination service instance:
 
```bash
cf create-service-key <destination-instance> async-key
cf service-key <destination-instance> async-key | tail -n +2 > dest.json
echo "dest.json" >> .gitignore
```
 
Set the variables from that file with Node, not by hand. Client IDs contain `!` and `|`, and secrets often contain `$`, all of which bash mangles inside quotes. Depending on the CF CLI version, the key may be wrapped in a `credentials` block; the script handles both:
 
```bash
node -e '
const j=require("./dest.json"); const k=j.credentials||j.uaa||j;
const vals={
  DEST_TOKEN_URL: k.url ? String(k.url).replace(/\/+$/,"")+"/oauth/token" : undefined,
  DEST_SERVICE_URL: k.uri,
  DEST_CLIENT_ID: k.clientid,
  DEST_CLIENT_SECRET: k.clientsecret,
  DEST_NAME: "JOULE_ASYNC_API"
};
const missing=Object.entries(vals).filter(([,v])=>!v).map(([n])=>n);
if (missing.length) { console.error("Missing in dest.json:", missing.join(", ")); process.exit(1) }
const {execFileSync:x}=require("child_process"); const app="order-detective-agent";
for (const [n,v] of Object.entries(vals)) { x("cf",["set-env",app,n,v],{stdio:["ignore","ignore","inherit"]}); console.log("set",n) }'
```
 
| Variable | Value |
|---|---|
| `DEST_TOKEN_URL` | service key `url` + `/oauth/token` |
| `DEST_SERVICE_URL` | service key `uri` (no path; the code appends `/destination-configuration/v1`) |
| `DEST_CLIENT_ID` / `DEST_CLIENT_SECRET` | service key `clientid` / `clientsecret` |
| `DEST_NAME` | `JOULE_ASYNC_API` |
 
### AI Core key
 
If `AICORE_SERVICE_KEY` on CF is stale, the agent fails with `Could not fetch client credentials token for service of type "aicore" … 401 invalid_client`. Refresh it from your local key file, again without shell quoting:
 
```bash
node -e '
const v=JSON.stringify(require("./ai-core-key.json"));
require("child_process").execFileSync("cf",["set-env","order-detective-agent","AICORE_SERVICE_KEY",v],{stdio:["ignore","ignore","inherit"]});
console.log("set AICORE_SERVICE_KEY")'
```
 
### Must NOT be set on CF
 
`SKIP_DEST_EXCHANGE`, `JOULE_CALLBACK_AUTH`, `IAS_TENANT`, `IAS_CLIENT_ID`, `IAS_CLIENT_SECRET`. These are local-test or experimental settings. If `JOULE_CALLBACK_AUTH` is set, the agent skips the user-token path.
 
---
 
## 7. Joule capability change
 
In `joule-capability/functions/order_detective_agent_function.yaml`, add `body.configurations.pushNotifications` to the `agent-request` action, and **keep the `message` action**:
 
```yaml
action_groups:
  - actions:
      - type: agent-request
        system_alias: ORDER_DETECTIVE_AGENT
        agent_type: remote
        result_variable: "apiResponse"
        body:
          configurations:
            pushNotifications: true
      - type: message
        message:
          type: text
          content: "<? apiResponse.body.artifacts[0].parts[0].text ?>"
```
 
- **Indentation matters.** `pushNotifications` must be indented under `configurations`. If it sits at the same level, the YAML is still valid and compiles, but Joule doesn't switch to async, and the agent logs `configuration.keys=[historyLength,blocking] pushUrl=-`.
- **Keep the `message` action.** In async mode, Joule waits at the `agent-request` until the final callback arrives, puts that result in `apiResponse`, then runs the `message` action. Without it, the turn ends with nothing displayed.
With `pushNotifications: true`, Joule adds `pushNotificationConfig` to every request and accepts the immediate `working` reply without timing out.
 
---
 
## 8. Build and deploy
 
```bash
# Agent
cd order-detective-agent
npm run build
cf push
 
# Capability (run from the folder that contains da.sapdas.yaml, the project root)
joule login            # if your session expired
joule list             # find your assistant name
joule deploy -c -n <assistant-name>
```
 
The agent still builds locally before `cf push` (no build step on CF), same as Part 3.
 
### `joule login` without the quoting pain
 
The Joule service key's client ID contains `!` and `|`, and history expansion on `!` breaks the command (`bash: !b52…: event not found`). Read the values from the key file instead:
 
```bash
cf service-key <joule-instance> <key-name> | tail -n +2 > joule.json
echo "joule.json" >> .gitignore
node -e '
const k=require("./joule.json"); const c=k.uaa||k.credentials||k;
require("child_process").execFileSync("joule",
  ["login","--apiurl",process.argv[1],"-a",c.url,"-c",c.clientid,"-s",c.clientsecret],
  {stdio:"inherit"})' 'https://<subaccount-subdomain>.<region>.sapdas.cloud.sap'
```
 
`--apiurl` is your Joule host (`https://<subdomain>.<region>.sapdas.cloud.sap`), with no path and no trailing slash. It is not the `authentication` URL; that one goes in `-a`. The CLI then asks for your IAS username and password.
 
---
 
## 9. Demo mode: forcing a long-running task
 
The real agent answers in about 10 s. To show async beyond Joule's 60-second sync limit, two demo-only variables add a wait with numbered updates before the agent runs:
 
```bash
cf set-env order-detective-agent ASYNC_TEST_DELAY_MS 60000      # total forced wait
cf set-env order-detective-agent ASYNC_TEST_INTERVAL_MS 15000   # one update every 15 s
cf restage order-detective-agent
```
 
Behaviour:
 
1. Ack within milliseconds.
2. Every `ASYNC_TEST_INTERVAL_MS`, a `working` callback: `Working 1 (15 s)`, `Working 2 (30 s)`… Joule shows each one as the progress card label.
3. After `ASYNC_TEST_DELAY_MS`, the real agent runs.
4. The final answer ends with `(Async demo: answered N s after your question.)`.
If `ASYNC_TEST_INTERVAL_MS` is unset, there's a single update at the end of the wait. If `ASYNC_TEST_DELAY_MS` is unset (production), there's no wait and no demo text.
 
To push further, try `ASYNC_TEST_DELAY_MS=180000`. Felix reports single tasks running past 10 minutes with updates about every 30 s. Joule's limits may change, so keep sending updates on long tasks.
 
**Remove both variables after the demo:**
```bash
cf unset-env order-detective-agent ASYNC_TEST_DELAY_MS
cf unset-env order-detective-agent ASYNC_TEST_INTERVAL_MS
cf restage order-detective-agent
```
 
---
 
## 10. Testing locally without BTP
 
This exercises the ack → background → callback sequence on your machine, with no IAS or destinations involved.
 
Terminal 1, a fake Joule callback endpoint:
```bash
npx tsx test/webhook-receiver.ts      # listens on http://localhost:9000/callback
```
 
Terminal 2, the agent in test mode:
```bash
npm run build
SKIP_DEST_EXCHANGE=true ASYNC_TEST_DELAY_MS=15000 ASYNC_TEST_INTERVAL_MS=5000 PORT=8080 npm start
```
The agent still needs `MCP_SERVER_URL` and `AICORE_SERVICE_KEY` in `.env` for the final answer. `order-detective` must be running (`cds watch --profile hybrid`), or `MCP_SERVER_URL` must point at the CF route.
 
Terminal 3, a request shaped like Joule's:
```bash
curl -s -X POST http://localhost:8080/ \
  -H "Content-Type: application/json" \
  -H "conversationid: local-conv" -H "x-correlationid: local-corr" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"message/send",
    "params":{
      "message":{"role":"user","parts":[{"kind":"text","text":"Why is order 4500001234 late?"}],"messageId":"m1"},
      "configuration":{"pushNotificationConfig":{"url":"http://localhost:9000/callback"}}
    }
  }'
```
 
Expected: curl returns a `working` task immediately. Terminal 1 logs a `working` update every 5 s, then the `completed` envelope with the answer.
 
`ASYNC_TEST_*` values from `.env` are picked up by `npm start` (via `dotenv`). Remove them before deploying.
 
---
 
## 11. Verifying on CF
 
Stream the agent's logs and ask Joule a question:
 
```bash
cf logs order-detective-agent
```
 
A healthy run with demo mode on (`60000` / `15000`):
 
```
[request] method=message/send … configuration.keys=[pushNotificationConfig,blocking] pushUrl=https://sapdas.us10.sapdas.cloud.sap/api/agent/v1/callback/a2a auth=present …
[inbound] taskId=… userJwt=present pushUrl=https://sapdas…
[request] responded 200 after 3 ms
[joule-client] pushed working for task … -> https://sapdas…/callback/a2a (200)    ×4, 15 s apart
[joule-client] pushed completed for task … -> https://sapdas…/callback/a2a (200)
```
 
How to read the key fields:
 
| Field | Meaning |
|---|---|
| `pushUrl=-` | Joule is calling in sync mode → check the capability YAML (section 7) |
| `auth=absent` / `userJwt=absent` | The inbound destination isn't sending a user token → section 5, `ORDER_DETECTIVE_AGENT` |
| `responded 200 after N ms` | Should be milliseconds. Tens of seconds means the sync path ran. |
 
---
 
## 12. Troubleshooting: errors we actually hit
 
| Symptom | Cause | Fix |
|---|---|---|
| Joule error after **exactly 60 s**, `WebResponse.getStatus() is null`, `http_status 400` | Sync mode and the agent took longer than 60 s | Enable async (section 7). Also check the backend speed. |
| Joule error immediately, `Failed to retrieve destination: ORDER_DETECTIVE_AGENT … JCore - 5802`; nothing in agent logs | Joule couldn't do the inbound token exchange | Add the `joule-to-proxy` dependency on `das-ias` and use the two-app chain (section 4) |
| Agent log `configuration.keys=[historyLength,blocking] pushUrl=-` | `pushNotifications` not active | YAML indentation; redeploy the capability |
| `Missing required env var DEST_TOKEN_URL` | `DEST_*` not set, or set while in client-credentials mode | Section 6 |
| `Failed to parse URL from undefined/oauth/token` | Service key wrapped in `credentials`; the values were read from the wrong level | Use the script in section 6, which checks for missing values first |
| `Callback POST … failed: 500 … JCore - 5402` | Callback sent with a technical (client-credentials) token, no user | Use the user-token path (destinations + `DEST_*`); unset `JOULE_CALLBACK_AUTH` |
| `Could not fetch client credentials token for service of type "aicore" … 401 invalid_client` | Stale `AICORE_SERVICE_KEY` on CF | Section 6, AI Core key |
| `Failed to fetch the list of deployments` locally | `AICORE_SERVICE_KEY` missing or invalid in `.env` | Reload it from `ai-core-key.json`, as one line |
| Agent answers with a "technical issue connecting to the order tracking system" apology | `order-detective-srv` can't reach HANA (`ResourceRequest timed out`) or isn't bound | Redeploy the `order-detective` MTA. `cf services` must show the srv app bound to the HDI container. |
| Joule's progress card stops, no message appears | `message` action removed from the capability | Keep it (section 7) |
| A near-empty `{}` push arrives alongside the real one | The SDK's own push sender is active | Pass the no-op sender to `DefaultRequestHandler` (section 3) |
| `bash: !…: event not found` / broken quoting | `!`, `$`, `|` in client IDs and secrets | Use the Node-based commands in sections 6 and 8, or `set +H` |
 
---
 
## 13. Findings beyond the reference post
 
All verified on a live tenant while building this:
 
1. **The callback requires a user token.** A client-credentials token from `A2A_Custom_Agent_App` with `ias_apis: ["joule-api"]` passes Joule's gateway (no 401), but Joule's core fails with `500 JCore - 5402`, even with a real conversation's `conversationid` / `x-correlationid`. The same call with the exchanged user token returns 200. So async here depends on principal propagation, and that's why Felix's async post builds on his identity setup.
2. **The Joule service key can't call the callback.** Its client-credentials token (`das-designer` client, scope `uaa.resource`) gets a 401.
3. **Joule renders a `working` update's `status.message` as the progress card label.** With no text there, the card just says "WORKING".
4. **Joule accepts `failed` callbacks (200) but doesn't display them.** We send errors as a `completed` message so the user always sees an ending.
5. **Joule waits at the `agent-request` until the final callback, then runs the next action**, so the function's `message` action stays.
6. **The sync timeout is 60 s** (measured from Joule's own logs).
7. **`@a2a-js/sdk` 1.3.0 ships its own push sender**, which activates automatically when the agent card advertises `pushNotifications`. That's useful for vanilla A2A, but Joule needs a JSON-RPC-wrapped Task, an exchanged token and the original correlation headers, so we disable it and push from the executor, as Felix does in Python.
---
 
## 14. Security and cleanup
 
- **Secrets.** Rotate any secret that was ever pasted into a chat, ticket or log. Keep `dest.json`, `joule.json`, `ias.json` and `ai-core-key.json` out of git:
```bash
  printf "dest.json\njoule.json\nias.json\nai-core-key.json\n" >> .gitignore
```
- **Public Client Flows.** Leave this off on `A2A_Custom_Agent_App`; nothing here needs it.
- **Demo settings.** Unset `ASYNC_TEST_DELAY_MS` and `ASYNC_TEST_INTERVAL_MS` after demos.
- **Request logger.** The `[request]` middleware in `a2a-server.ts` logs conversation and correlation IDs (never tokens). Remove it, or put it behind a flag, for production.
- **Inbound token validation.** The A2A server still uses `UserBuilder.noAuthentication`. It forwards the inbound JWT but doesn't validate it. A forged token would be rejected at the Destination service exchange, so no callback would reach Joule, but by then the agent's own work (LLM and backend calls) may already have run. For production, validate the JWT (issuer, audience = `A2A_Custom_Agent_App`, signature via the IAS JWKS) before doing any work.
- **Task store.** Tasks live in memory (`InMemoryTaskStore`). That's fine for single-turn async. If you add Felix's multi-turn `contextId`/`taskId` body fields, a restart loses tasks, and follow-ups fail with "Task not found".
---
 
## Credits
 
This is a Node.js / `@a2a-js/sdk` port of Felix Bartler's Python reference implementation and setup:
 
- [Joule A2A: Async Push Notifications for Long-Running Agents](https://community.sap.com/t5/technology-blog-posts-by-sap/joule-a2a-async-push-notifications-for-long-running-agents/ba-p/14423408): envelope format, `JOULE_ASYNC_API` destination, the executor pattern
- [Joule A2A: Propagate the User Identity from Joule into S/4HANA](https://community.sap.com/t5/technology-blog-posts-by-sap/joule-a2a-propagate-the-user-identity-from-joule-into-s-4hana/ba-p/14420290): the inbound two-app chain, including `joule-to-proxy`
- [Joule A2A: Secure Code-Based Agents with IAS](https://community.sap.com/t5/technology-blog-posts-by-sap/joule-a2a-secure-code-based-agents-with-ias/ba-p/14367792)
 

Claude finished the response
