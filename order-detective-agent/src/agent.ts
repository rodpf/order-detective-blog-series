import { createAgent } from 'langchain'
import { OrchestrationClient } from '@sap-ai-sdk/langchain'
import { OrderDetectiveMcpClient } from './mcp-client.js'
import { createTraceOrderTool } from './tools.js'

const SYSTEM_PROMPT = `You are Order Detective, an assistant that answers questions about sales
orders using the trace_order tool. trace_order returns customer, order status, planned vs actual
delivery date, delivery status, and - if delayed - the delay reason and days (see daysOverdue for
orders not yet delivered).

Call trace_order once per order number mentioned - if the user asks about more than one order,
call it multiple times before answering. Answer any question directly answerable from the fields
trace_order returns, not just delay status - e.g. customer name, dates, whether two orders share
the same customer. Do not speculate beyond what trace_order actually returned.

If you cannot identify an order number from the question, ask the user for it - never claim a
system limitation, missing access, or offer to walk the user through manual/external steps. Your
only capability is trace_order; if a question genuinely can't be answered from its fields, say so
plainly rather than inventing an explanation.`

export function buildOrderDetectiveAgent(mcpServerUrl: string) {
  const mcpClient = new OrderDetectiveMcpClient(mcpServerUrl)
  const traceOrderTool = createTraceOrderTool(mcpClient)

  // GenAI Hub / AI Core, via the Orchestration Service exclusively - not a
  // choice between clients, a commitment to the one that's actually
  // provider-agnostic. OrchestrationClient normalizes OpenAI, Claude, Gemini,
  // etc. behind one API; swapping providers post-MVP is GENAI_HUB_MODEL
  // changing in .env, nothing else.
  //
  // Requirement this depends on: an orchestration-scenario deployment in AI
  // Core, not a foundation-models deployment. This is an AI Core resource
  // type, not a code choice - a foundation-models deployment ID here fails
  // with "Subpath 'v2/completion' is not allowed" (confirmed earlier). If you
  // don't have an orchestration deployment yet, that's the actual next step
  // before this runs - see readme.md.
  //
  // No deploymentId by default: omitting it lets the SDK search your
  // resource group (defaults to 'default') for whichever deployment serves
  // GENAI_HUB_MODEL, so switching models is purely the env var. Set
  // GENAI_HUB_DEPLOYMENT_ID only if you want to pin a specific deployment
  // instead of relying on that lookup. GENAI_HUB_RESOURCE_GROUP only matters
  // if your resource group isn't literally named "default" - ignored
  // whenever GENAI_HUB_DEPLOYMENT_ID is set.
  const deploymentConfig = process.env.GENAI_HUB_DEPLOYMENT_ID
    ? { deploymentId: process.env.GENAI_HUB_DEPLOYMENT_ID }
    : process.env.GENAI_HUB_RESOURCE_GROUP
      ? { resourceGroup: process.env.GENAI_HUB_RESOURCE_GROUP }
      : undefined

  const model = new OrchestrationClient(
    {
      promptTemplating: {
        model: {
          name: process.env.GENAI_HUB_MODEL ?? 'gpt-4o-mini',
          params: { temperature: 0 }
        }
      }
    },
    undefined,
    deploymentConfig as { resourceGroup?: string } | undefined
  )

  return createAgent({
    model,
    tools: [traceOrderTool],
    systemPrompt: SYSTEM_PROMPT
  })
}
