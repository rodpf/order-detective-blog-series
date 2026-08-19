import 'dotenv/config'
import { buildOrderDetectiveAgent } from './agent.js'

const mcpServerUrl = process.env.MCP_SERVER_URL ?? 'http://localhost:4004/mcp/order'
const question = process.argv.slice(2).join(' ') || 'Why is order 4500001234 late?'

const agent = buildOrderDetectiveAgent(mcpServerUrl)

const result = await agent.invoke({
  messages: [{ role: 'user', content: question }]
})

const last = result.messages[result.messages.length - 1]
console.log(last.content)
