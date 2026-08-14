import { tool } from '@langchain/core/tools'
import { z } from 'zod'
import { OrderDetectiveMcpClient } from './mcp-client.js'

/**
 * Wraps order-detective's traceOrder MCP tool as a LangChain tool the agent
 * can call. This is the only tool the agent has - deliberately narrow scope
 * for a first MVP.
 */
export function createTraceOrderTool(mcpClient: OrderDetectiveMcpClient) {
  return tool(
    async ({ orderNumber }) => {
      return mcpClient.traceOrder(orderNumber)
    },
    {
      name: 'trace_order',
      description:
        'Get the full delivery and delay trace for a sales order, given its order number. ' +
        'Returns customer, order status, planned vs actual delivery date, delivery status, ' +
        'and - if delayed - the number of days delayed and the reason. ' +
        'For orders not yet delivered (deliveryStatus inTransit or similar), use daysOverdue ' +
        'to determine lateness - do not infer this yourself from plannedDate, you have no ' +
        'reliable notion of the current date. daysOverdue is null once an order is delivered ' +
        '(delayDays/deliveryStatus already cover that case); positive means past the planned ' +
        'date and still not delivered; negative means still within the planned window, not yet due.',
      schema: z.object({
        orderNumber: z.string().describe("The order number to trace, e.g. '4500001234'")
      })
    }
  )
}
