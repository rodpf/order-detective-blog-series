import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js'

/**
 * Thin wrapper around the MCP SDK client, scoped to what this agent needs:
 * connect once, call the generic `call` tool with an action name + params.
 * order-detective's @cap-js/mcp adapter exposes describe/query/call, not one
 * tool per CAP action - see readme.md in that project for why.
 */
export class OrderDetectiveMcpClient {
  private client: Client
  private connected = false

  constructor(private readonly serverUrl: string) {
    this.client = new Client({ name: 'order-detective-agent', version: '1.0.0' }, { capabilities: {} })
  }

  async connect() {
    if (this.connected) return
    const transport = new StreamableHTTPClientTransport(new URL(this.serverUrl))
    await this.client.connect(transport)
    this.connected = true
  }

  async traceOrder(orderNumber: string) {
    await this.connect()
    const result = await this.client.request(
      {
        method: 'tools/call',
        params: {
          name: 'call',
          arguments: { action: 'traceOrder', parameters: { orderNumber } }
        }
      },
      CallToolResultSchema
    )

    const textContent = result.content.find((c) => c.type === 'text')
    if (!textContent || textContent.type !== 'text') {
      throw new Error('Unexpected MCP response shape from traceOrder')
    }
    return textContent.text
  }
}
