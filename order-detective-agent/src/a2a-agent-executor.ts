import { randomUUID } from 'node:crypto'
import {
  AgentEvent,
  type AgentExecutor,
  type ExecutionEventBus,
  type RequestContext
} from '@a2a-js/sdk/server'
import { Role, TaskState } from '@a2a-js/sdk'
import { buildOrderDetectiveAgent } from './agent.js'

const mcpServerUrl = process.env.MCP_SERVER_URL ?? 'http://localhost:4004/mcp/order'

function textOf(requestContext: RequestContext): string {
  const message = requestContext.userMessage
  const textPart = message.parts.find((p) => p.content?.$case === 'text')
  return textPart?.content?.$case === 'text' ? textPart.content.value : ''
}

/**
 * Bridges the A2A protocol to the Phase 2 LangGraph agent. Deliberately
 * simple: build the agent, run it once per request, publish exactly one
 * artifact + one completed status. No multi-turn, no streaming intermediate
 * updates, no async/push notifications - those are Phase 4 territory, and
 * bolting them on here first would make this harder to verify in isolation.
 */
export class OrderDetectiveAgentExecutor implements AgentExecutor {
  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskId = requestContext.taskId
    const contextId = requestContext.contextId
    const question = textOf(requestContext)

    // First event MUST be a task or message - the SDK enforces this ordering.
    eventBus.publish(
      AgentEvent.task({
        id: taskId,
        contextId,
        status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: new Date().toISOString() },
        artifacts: [],
        history: [requestContext.userMessage],
        metadata: {}
      })
    )

    try {
      const agent = buildOrderDetectiveAgent(mcpServerUrl)
      const result = await agent.invoke({ messages: [{ role: 'user', content: question }] })
      const last = result.messages[result.messages.length - 1]
      const answerText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content)

      eventBus.publish(
        AgentEvent.artifactUpdate({
          taskId,
          contextId,
          artifact: {
            artifactId: randomUUID(),
            name: 'trace_answer',
            description: 'Order Detective answer',
            parts: [{ content: { $case: 'text', value: answerText }, metadata: undefined, filename: '', mediaType: 'text/plain' }],
            metadata: undefined,
            extensions: []
          },
          append: false,
          lastChunk: true,
          metadata: undefined
        })
      )

      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: new Date().toISOString() },
          metadata: undefined
        })
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      eventBus.publish(
        AgentEvent.statusUpdate({
          taskId,
          contextId,
          status: {
            state: TaskState.TASK_STATE_FAILED,
            message: {
              messageId: randomUUID(),
              contextId,
              taskId,
              role: Role.ROLE_AGENT,
              parts: [
                {
                  content: { $case: 'text', value: `Order Detective failed: ${message}` },
                  metadata: undefined,
                  filename: '',
                  mediaType: 'text/plain'
                }
              ],
              metadata: undefined,
              extensions: [],
              referenceTaskIds: []
            },
            timestamp: new Date().toISOString()
          },
          metadata: undefined
        })
      )
    } finally {
      eventBus.finished()
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    eventBus.publish(
      AgentEvent.statusUpdate({
        taskId,
        contextId: '',
        status: { state: TaskState.TASK_STATE_CANCELED, message: undefined, timestamp: new Date().toISOString() },
        metadata: undefined
      })
    )
    eventBus.finished()
  }
}
