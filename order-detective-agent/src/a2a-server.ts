import 'dotenv/config'
import express from 'express'
import { DefaultRequestHandler, InMemoryTaskStore } from '@a2a-js/sdk/server'
import { jsonRpcHandler, UserBuilder, agentCardHandler } from '@a2a-js/sdk/server/express'
import type { AgentCard } from '@a2a-js/sdk'
import { OrderDetectiveAgentExecutor } from './a2a-agent-executor.js'

const PORT = Number(process.env.PORT ?? 10000)
// Must be the CF app's real public URL once deployed - the Joule destination
// resolves this via the well-known agent card, and Joule calls back to
// whatever URL is declared here, not the one in the destination config.
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`

const agentCard: AgentCard = {
  name: 'Order Detective',
  description: 'Traces why a sales order is delayed - orders, deliveries, and delay reasons.',
  // legacyCompat routing (see jsonRpcHandler below) requires a v0.3 JSONRPC
  // interface to be declared here, matching the older message/send-style
  // wire format the reference Joule integration was built against.
  supportedInterfaces: [
    { url: PUBLIC_URL, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '0.3' }
  ],
  provider: undefined,
  version: '1.0.0',
  capabilities: { streaming: false, pushNotifications: false, extensions: [] },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text', 'text/plain'],
  defaultOutputModes: ['text', 'text/plain'],
  skills: [
    {
      id: 'trace_order',
      name: 'Order delay tracing',
      description: 'Given an order number, explains whether it is delayed and why.',
      tags: ['orders', 'delivery', 'delay'],
      examples: ['Why is order 4500001234 late?'],
      inputModes: [],
      outputModes: [],
      securityRequirements: []
    }
  ],
  signatures: []
}

const taskStore = new InMemoryTaskStore()
const agentExecutor = new OrderDetectiveAgentExecutor()
const requestHandler = new DefaultRequestHandler(agentCard, taskStore, agentExecutor)

const app = express()
app.use(express.json())

app.use(
  '/.well-known/agent-card.json',
  agentCardHandler({
    agentCardProvider: () => Promise.resolve(agentCard),
    legacyCompat: { enabled: true }
  })
)
app.use(
  jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
    legacyCompat: { enabled: true }
  })
)

app.listen(PORT, () => {
  console.log(`Order Detective A2A server listening on port ${PORT}`)
  console.log(`Agent card: ${PUBLIC_URL}/.well-known/agent-card.json`)
})
