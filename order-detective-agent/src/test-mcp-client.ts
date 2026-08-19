import { OrderDetectiveMcpClient } from './mcp-client.js'

const url = process.env.MCP_SERVER_URL ?? 'http://localhost:4004/mcp/order'
const client = new OrderDetectiveMcpClient(url)

const result = await client.traceOrder('4500001234')
console.log(result)
