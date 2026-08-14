# Order Detective

A self-contained CAP service — synthetic sales orders, deliveries, and delay
reasons — exposed both as a normal OData API and as an MCP server, backed by
HANA Cloud. Companion code for [Part 1 of a blog series on building a
pro-code agent on SAP BTP](#) *(link once published)*.

## What's here

- `db/schema.cds` — Orders / OrderItems / Deliveries / DelayReasons, with
  compositions wired for the delivery -> delay-reason trace
- `db/data/*.csv` — synthetic seed data: a handful of orders, some delayed,
  some on time, one in transit
- `srv/order-service.cds` — OData projections + a `traceOrder(orderNumber)`
  function, service annotated `@protocol: ['odata', 'mcp']`
- `srv/order-service.js` — the `traceOrder` handler (a single CQL query with
  nested expands across delivery -> delayReason)

## Note on the MCP shape

`@cap-js/mcp` doesn't expose one dedicated tool per CAP action by default —
it exposes three generic tools (`describe`, `query`, `call`), and a client
calls `traceOrder` via `call` with `{ action: "traceOrder", parameters: {...} }`.
If you'd rather have `traceOrder` show up as its own named tool, set
`per_action_tool: true` under `cds.mcp` in `package.json`.

## Run it locally (SQLite, no HANA needed)

```bash
npm install
npx cds deploy --to sqlite:test.db
npx cds serve
```

```bash
curl "http://localhost:4004/odata/v4/order/traceOrder(orderNumber='4500001234')"
```

## Run it against HANA Cloud

### Option A — hybrid testing (local Node, real HANA Cloud)

Fastest loop while iterating on the model. Requires `cf login` targeted at
the right org/space first.

```bash
cds add hana
cds bind -2 <your-hana-service-instance-name> --kind hana
cds deploy --to hana --profile hybrid
cds watch --profile hybrid
```

`cds watch` picks up the hybrid binding automatically once it exists in
`.cdsrc-private.json` (created by `cds bind` — gitignored, holds credentials).

### Option B — deploy for real (Cloud Foundry + HDI container)

```bash
cds add hana,mta
mbt build
cf deploy mta_archives/order-detective_1.0.0.mtar
```

Provisions an HDI container and deploys the CAP service to Cloud Foundry —
needed once something else (an agent, another service) needs a stable URL
to reach this over the network rather than a local bind.

## Testing MCP directly

```bash
curl -s -X POST http://localhost:4004/mcp/order \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"call","arguments":{"action":"traceOrder","parameters":{"orderNumber":"4500001234"}}}}'
```

Or interactively with [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```bash
npx @modelcontextprotocol/inspector
```
