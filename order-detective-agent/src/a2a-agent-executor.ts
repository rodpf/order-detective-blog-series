import { randomUUID } from 'node:crypto'



interface DestinationTokenResponse {
  access_token: string
}

interface DestinationLookupResponse {
  destinationConfiguration: Record<string, string>
  authTokens?: Array<{
    type: string
    value: string
    error?: string
    http_header?: { key: string; value: string }
  }>
}

export interface JouleClientConfig {
  /** Destination service token endpoint: the service key's `url` + `/oauth/token`. */
  destTokenUrl: string
  /** Destination service root: the service key's `uri` (no path). */
  destServiceUrl: string
  destClientId: string
  destClientSecret: string
  /** Name of the destination pointing at Joule's async callback API. */
  destName: string
}

export function loadJouleClientConfigFromEnv(): JouleClientConfig {
  // Test mode never touches these, so local runs don't need real
  // destination-service credentials to exercise the ack/callback flow.
  // Neither test mode nor client-credentials mode touches the Destination
  // service, so neither should require its env vars.
  if (process.env.SKIP_DEST_EXCHANGE === 'true' || process.env.JOULE_CALLBACK_AUTH === 'client_credentials') {
    return { destTokenUrl: '', destServiceUrl: '', destClientId: '', destClientSecret: '', destName: '' }
  }
  const required = (name: string): string => {
    const value = process.env[name]
    if (!value) throw new Error(`Missing required env var ${name} for the Joule async destination hop`)
    return value
  }
  return {
    destTokenUrl: required('DEST_TOKEN_URL'),
    destServiceUrl: required('DEST_SERVICE_URL').replace(/\/+$/, ''),
    destClientId: required('DEST_CLIENT_ID'),
    destClientSecret: required('DEST_CLIENT_SECRET'),
    destName: process.env.DEST_NAME ?? 'JOULE_ASYNC_API'
  }
}

/** Client-credentials token for calling the Destination service itself (Basic auth, as in Felix's curl). */
async function fetchDestinationServiceToken(cfg: JouleClientConfig): Promise<string> {
  const basic = Buffer.from(`${cfg.destClientId}:${cfg.destClientSecret}`).toString('base64')
  const res = await fetch(cfg.destTokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  })
  if (!res.ok) {
    throw new Error(`Destination service token fetch failed: ${res.status} ${await res.text()}`)
  }
  return ((await res.json()) as DestinationTokenResponse).access_token
}

/** Resolves the destination with the user JWT; the Destination service does the IAS exchange. */
async function resolveDestination(
  cfg: JouleClientConfig,
  userJwt: string
): Promise<{ authHeader: { key: string; value: string }; callbackUrl: string }> {
  const destServiceToken = await fetchDestinationServiceToken(cfg)
  const url = `${cfg.destServiceUrl}/destination-configuration/v1/destinations/${encodeURIComponent(cfg.destName)}`
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${destServiceToken}`, 'X-user-token': userJwt }
  })
  if (!res.ok) {
    throw new Error(`Destination lookup for ${cfg.destName} failed: ${res.status} ${await res.text()}`)
  }
  const json = (await res.json()) as DestinationLookupResponse
  const token = json.authTokens?.[0]
  if (!token || token.error) {
    throw new Error(`Destination ${cfg.destName} returned no usable token: ${token?.error ?? 'empty authTokens'}`)
  }
  const callbackUrl = json.destinationConfiguration.URL
  if (!callbackUrl) throw new Error(`Destination ${cfg.destName} has no URL configured`)
  return {
    authHeader: token.http_header ?? { key: 'Authorization', value: `Bearer ${token.value}` },
    callbackUrl
  }
}

/**
 * Experimental alternative to the destination exchange: IAS client
 * credentials for the agent's own IAS app, scoped to the Joule async API via
 * its dependency. No user in the token. Env: IAS_TENANT, IAS_CLIENT_ID,
 * IAS_CLIENT_SECRET, IAS_DEPENDENCY_NAME (default agent-to-joule).
 */
async function fetchTechnicalJouleToken(): Promise<string> {
  const need = (k: string) => {
    const v = process.env[k]
    if (!v) throw new Error(`Missing env var ${k} for JOULE_CALLBACK_AUTH=client_credentials`)
    return v
  }
  const tenant = need('IAS_TENANT').replace(/\/+$/, '')
  const dependency = process.env.IAS_DEPENDENCY_NAME ?? 'agent-to-joule'
  const res = await fetch(`${tenant}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: need('IAS_CLIENT_ID'),
      client_secret: need('IAS_CLIENT_SECRET'),
      resource: `urn:sap:identity:application:provider:name:${dependency}`,
      token_format: 'jwt'
    })
  })
  if (!res.ok) throw new Error(`IAS client_credentials token failed: ${res.status} ${await res.text()}`)
  return ((await res.json()) as { access_token: string }).access_token
}

/** The inbound values Felix's executor keeps for the callback. */
export interface InboundCallHeaders {
  /** JWT from the inbound `Authorization: Bearer` header, without the prefix. */
  userJwt: string
  conversationId?: string
  correlationId?: string
}

type EnvelopeState = 'working' | 'input-required' | 'completed' | 'failed'

/**
 * JSON-RPC envelope around an A2A Task, matching Felix's `completed_envelope`:
 * `id` is the inbound x-correlationid (falls back to taskId), `result` is a
 * `kind: "task"`. For `completed`, the answer goes in `artifacts`, which is
 * what Joule renders as the assistant message. Intermediate states carry
 * their text in `status.message`.
 */
function taskEnvelope(params: {
  taskId: string
  contextId: string
  correlationId?: string
  state: EnvelopeState
  text: string
  /** Force an artifact on a non-final state (interim-message experiment). */
  artifactId?: string
}) {
  const { taskId, contextId, correlationId, state, text } = params
  const textPart = [{ kind: 'text' as const, text }]
  const isFinal = state === 'completed'
  const artifactId = params.artifactId ?? (isFinal ? `result-${taskId}` : undefined)
  return {
    id: correlationId || taskId,
    jsonrpc: '2.0' as const,
    result: {
      id: taskId,
      contextId,
      kind: 'task' as const,
      status: isFinal
        ? { state }
        : { state, message: { messageId: randomUUID(), kind: 'message' as const, role: 'agent' as const, parts: textPart } },
      ...(artifactId ? { artifacts: [{ artifactId, parts: textPart }] } : {})
    }
  }
}

export type TaskEnvelope = ReturnType<typeof taskEnvelope> | ReturnType<typeof workingEnvelope>

export const completedEnvelope = (taskId: string, contextId: string, correlationId: string | undefined, answer: string) =>
  taskEnvelope({ taskId, contextId, correlationId, state: 'completed', text: answer })

export const workingEnvelope = (taskId: string, contextId: string, correlationId: string | undefined, text: string, seq = 1) => ({
  // Felix: working is "the same shape with a different status block" as
  // completed, so the interim text goes in `artifacts` (what Joule renders),
  // not only in status.message. Separate artifactId from the final answer.
  id: correlationId || taskId,
  jsonrpc: '2.0' as const,
  result: {
    id: taskId,
    contextId,
    kind: 'task' as const,
    // Text in both places: status.message is A2A's human-readable status
    // text (a candidate for Joule's progress card label), artifacts is
    // what Joule renders as message content.
    status: {
      state: 'working' as const,
      message: { messageId: randomUUID(), kind: 'message' as const, role: 'agent' as const, parts: [{ kind: 'text' as const, text }] }
    },
    artifacts: [{ artifactId: `progress-${taskId}-${seq}`, parts: [{ kind: 'text' as const, text }] }]
  }
})

export const inputRequiredEnvelope = (taskId: string, contextId: string, correlationId: string | undefined, question: string) =>
  taskEnvelope({ taskId, contextId, correlationId, state: 'input-required', text: question })

/**
 * Errors go out as a `completed` task carrying the error text. Verified on
 * a live Joule tenant: Joule accepts a `failed` callback (HTTP 200) but does
 * not render it, so the user saw nothing and the conversation never ended.
 * Felix's post only lists working / input-required / completed as handled.
 */
export const failedEnvelope = (taskId: string, contextId: string, correlationId: string | undefined, errorText: string) =>
  taskEnvelope({
    taskId,
    contextId,
    correlationId,
    state: 'completed',
    text: `Sorry, I couldn't finish tracing this order: ${errorText}`
  })

/**
 * POSTs one envelope back to Joule.
 *
 * `SKIP_DEST_EXCHANGE=true` posts straight to `fallbackUrl` (the
 * pushNotificationConfig.url from the request) with no auth, for local
 * testing against test/webhook-receiver.ts. Otherwise the URL and token both
 * come from the destination, same as Felix's `post_callback`.
 */
export async function pushTaskUpdate(
  cfg: JouleClientConfig,
  headers: InboundCallHeaders,
  envelope: TaskEnvelope,
  fallbackUrl: string
): Promise<void> {
  const correlationHeaders: Record<string, string> = {
    ...(headers.conversationId ? { conversationid: headers.conversationId } : {}),
    ...(headers.correlationId ? { 'x-correlationid': headers.correlationId } : {})
  }

  let url = fallbackUrl
  let authHeaders: Record<string, string> = {}
  if (process.env.JOULE_CALLBACK_AUTH === 'client_credentials') {
    // Experimental: technical token, no user identity. Posts to the URL Joule
    // sent in pushNotificationConfig. Only valid if Joule accepts such
    // tokens; see test/probe-callback-clientcreds.mjs.
    authHeaders = { Authorization: `Bearer ${await fetchTechnicalJouleToken()}` }
  } else if (process.env.SKIP_DEST_EXCHANGE !== 'true') {
    if (!headers.userJwt) {
      throw new Error('No inbound user JWT: the Joule-to-agent destination must be OAuth2JWTBearer, not NoAuthentication')
    }
    const { authHeader, callbackUrl } = await resolveDestination(cfg, headers.userJwt)
    url = callbackUrl
    authHeaders = { [authHeader.key]: authHeader.value }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...correlationHeaders },
    body: JSON.stringify(envelope)
  })
  if (!res.ok) {
    throw new Error(`Callback POST to ${url} failed: ${res.status} ${await res.text()}`)
  }
  console.log(`[joule-client] pushed ${envelope.result.status.state} for task ${envelope.result.id} -> ${url} (${res.status})`)
}
