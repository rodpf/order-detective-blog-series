import 'dotenv/config'
import express from 'express'
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
  InMemoryPushNotificationStore,
  type AgentExecutor,
  type PushNotificationSender
} from '@a2a-js/sdk/server'
import { agentCardHandler, jsonRpcHandler, UserBuilder } from '@a2a-js/sdk/server/express'
import type { AgentCard } from '@a2a-js/sdk'
import { OrderDetectiveAgentExecutor } from './a2a-agent-executor.js'

const PORT = Number(process.env.PORT ?? 8080)
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`
const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? 'http://localhost:4004/mcp/order'

const agentCard: AgentCard = {
  name: 'Order Detective',
  description: 'Traces sales order delays: order -> delivery -> delay reason.',
  version: '1.0.0',
  provider: undefined,
  documentationUrl: undefined,
  supportedInterfaces: [{ url: PUBLIC_URL, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '0.3' }],
  capabilities: {
    streaming: false,
    // Flipped on for the async push-notification path: Joule registers a
    // `taskPushNotificationConfig` on `message/send` and gets an immediate
    // `working` ack, then the real answer arrives via a direct callback
    // POST (see a2a-agent-executor.ts / joule-client.ts) rather than over
    // this request.
    pushNotifications: true,
    extensions: [],
    extendedAgentCard: false
  },
  securitySchemes: {},
  securityRequirements: [],
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'trace-order-delay',
      name: 'Trace order delay',
      description: 'Explains why a sales order is late, or confirms it is on schedule.',
      tags: ['orders', 'logistics'],
      examples: ['Why is order 4500001234 late?'],
      inputModes: ['text'],
      outputModes: ['text'],
      securityRequirements: []
    }
  ],
  signatures: []
}

const agentExecutor: AgentExecutor = new OrderDetectiveAgentExecutor(MCP_SERVER_URL)
const taskStore = new InMemoryTaskStore()

// `capabilities.pushNotifications: true` above makes `DefaultRequestHandler`
// auto-construct its OWN push store + `DefaultPushNotificationSender` and
// fire a push for every event we publish on the bus — including the first
// `working` task — straight to whatever URL the caller registered. That
// collides with the Felix-style manual callback in a2a-agent-executor.ts /
// joule-client.ts (confirmed by testing: both landed on the same webhook,
// the SDK's own producing a near-empty body because it has no v0.3
// serializer registered for a push config registered over the v0.3 compat
// path). We still need the capability flag advertised and still want the
// client's registration stored, so we pass an explicit store but a no-op
// sender to swallow the SDK's own dispatch — our executor is the only
// thing that actually calls out.
const pushNotificationStore = new InMemoryPushNotificationStore()
const noopPushNotificationSender: PushNotificationSender = { send: async () => {} }

const requestHandler = new DefaultRequestHandler(
  agentCard,
  taskStore,
  agentExecutor,
  undefined,
  pushNotificationStore,
  noopPushNotificationSender
)

const app = express()
app.use(express.json())

// Diagnostic: what does Joule actually send? Logs shape only, never secrets:
// header NAMES (not values), whether a push config is present, its URL, and
// how long the response took.
app.use((req, res, next) => {
  if (req.method !== 'POST') return next()
  const started = Date.now()
  const params = req.body?.params ?? {}
  const cfg = params.configuration ?? {}
  const push = cfg.pushNotificationConfig ?? cfg.taskPushNotificationConfig
  console.log(
    `[request] method=${req.body?.method} a2a-version=${req.headers['a2a-version'] ?? '-'} ` +
      `configuration.keys=[${Object.keys(cfg).join(',')}] pushUrl=${push?.url ?? '-'} ` +
      `auth=${req.headers.authorization ? 'present' : 'absent'} ` +
      `conversationid=${req.headers['conversationid'] ?? '-'} x-correlationid=${req.headers['x-correlationid'] ?? '-'}`
  )
  console.log(`[request] header names: ${Object.keys(req.headers).join(', ')}`)
  res.on('finish', () => console.log(`[request] responded ${res.statusCode} after ${Date.now() - started} ms`))
  next()
})

app.use(
  '/.well-known/agent-card.json',
  agentCardHandler({ agentCardProvider: requestHandler, legacyCompat: { enabled: true } })
)
app.use(
  '/',
  jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
    legacyCompat: { enabled: true }
  })
)

app.listen(PORT, () => {
  console.log(`order-detective-agent A2A server listening on ${PORT}, advertising ${PUBLIC_URL}`)
})
