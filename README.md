# Building a Pro-Code Agent on SAP BTP

Companion code for a 3-part blog series on building and deploying a pro-code
agent on SAP BTP — CAP, HANA, MCP, a LangGraph agent calling GenAI Hub, and
Joule integration via the A2A protocol.

- **Part 1** — The data layer: CAP, HANA, and MCP *(link once published)*
- **Part 2** — The agent: LangGraph + GenAI Hub *(link once published)*
- **Part 3** — Joule integration via A2A, and what changes for production *(link once published)*

## Structure

Two independently deployable projects, each its own folder:

- **`order-detective/`** — a CAP service exposing synthetic sales order data
  as both OData and an MCP server, backed by HANA Cloud. Introduced in Part 1.
- **`order-detective-agent/`** — a LangGraph agent that consumes
  `order-detective` via MCP, calls GenAI Hub for reasoning, and (from Part 3
  onward) exposes itself to Joule as an A2A server. Introduced in Part 2;
  gains its A2A/Joule pieces in Part 3.

They're deployed as two separate Cloud Foundry apps — `order-detective-agent`
never imports CAP, it only knows about `order-detective` through a URL.

## Following along with a specific post

Each part has a matching tag, at the exact state that post describes —
useful if you want the code as it stood at that point, not the finished
result:

```bash
git checkout part-1   # order-detective only
git checkout part-2   # + order-detective-agent (LangGraph, no A2A yet)
git checkout part-3   # + A2A server, Joule capability files
```

`main` tracks the latest state, same as `part-3` once that post is out.

## Setup

Each project has its own README with prerequisites, local run instructions,
and deployment steps — start there once you've picked a checkout point above.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).
