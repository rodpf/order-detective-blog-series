#!/usr/bin/env node
/**
 * Probe: does Joule's async callback accept a TECHNICAL token (IAS client
 * credentials, no user) instead of Felix's user-token exchange?
 *
 * 1. Gets a token from IAS with grant_type=client_credentials, scoped to the
 *    `agent-to-joule` dependency via `resource`.
 * 2. Prints the token's claims, so you can see what Joule will receive.
 * 3. POSTs a Felix-shaped `completed` envelope to the callback URL and prints
 *    the HTTP status + body.
 *
 * Reading the result:
 *   401 / 403            -> Joule rejected the token itself: technical tokens don't work.
 *   400 / 404 / 422      -> Auth was accepted; Joule just couldn't match the
 *                           conversation. Promising: rerun with real IDs.
 *   200 / 202            -> Accepted. With real IDs, check the Joule chat.
 *
 * Usage (secret read silently, so it stays out of shell history):
 *   read -s IAS_CLIENT_SECRET && export IAS_CLIENT_SECRET
 *   IAS_TENANT=https://<tenant>.accounts.ondemand.com \
 *   IAS_CLIENT_ID=<A2A_Custom_Agent_App client id> \
 *   DEPENDENCY_NAME=agent-to-joule \
 *   JOULE_CALLBACK_URL=https://sapdas.<region>.sapdas.cloud.sap/api/agent/v1/callback/a2a \
 *   node test/probe-callback-clientcreds.mjs
 *
 * Optional, for the real-conversation run (values from the agent's
 * "[inbound]" log line): CONVERSATION_ID, CORRELATION_ID, TASK_ID, CONTEXT_ID.
 */
import { randomUUID } from 'node:crypto'

const need = (k) => {
  const v = process.env[k]
  if (!v) { console.error(`Missing env var ${k}`); process.exit(1) }
  return v
}
const tenant = need('IAS_TENANT').replace(/\/+$/, '')
const clientId = need('IAS_CLIENT_ID')
const clientSecret = need('IAS_CLIENT_SECRET')
const dependency = process.env.DEPENDENCY_NAME ?? 'agent-to-joule'
const callbackUrl = need('JOULE_CALLBACK_URL')
const conversationId = process.env.CONVERSATION_ID ?? `probe-conv-${randomUUID()}`
const correlationId = process.env.CORRELATION_ID ?? `probe-corr-${randomUUID()}`
const taskId = process.env.TASK_ID ?? randomUUID()
const contextId = process.env.CONTEXT_ID ?? randomUUID()

console.log('--- 1. IAS client_credentials token ---')
const tokenRes = await fetch(`${tenant}/oauth2/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    resource: `urn:sap:identity:application:provider:name:${dependency}`,
    token_format: 'jwt'
  })
})
const tokenText = await tokenRes.text()
if (!tokenRes.ok) {
  console.error(`IAS token request failed: ${tokenRes.status}\n${tokenText}`)
  process.exit(1)
}
const accessToken = JSON.parse(tokenText).access_token
console.log(`OK (${tokenRes.status})`)

console.log('\n--- 2. Token claims (what Joule will see) ---')
try {
  const claims = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString())
  const { aud, ias_apis, sub, sap_id_type, azp, iss, exp } = claims
  console.log(JSON.stringify({ iss, aud, azp, sub, sap_id_type, ias_apis, exp }, null, 2))
  if (!ias_apis || !JSON.stringify(ias_apis).includes('joule')) {
    console.log('WARNING: no joule API in ias_apis. Check the dependency name / target in IAS.')
  }
} catch {
  console.log('Token is not a JWT (opaque). token_format=jwt was not honoured; Joule will likely reject it.')
}

console.log('\n--- 3. POST callback ---')
console.log(`conversationid=${conversationId}\nx-correlationid=${correlationId}`)
const body = {
  id: correlationId,
  jsonrpc: '2.0',
  result: {
    id: taskId,
    contextId,
    kind: 'task',
    status: { state: 'completed' },
    artifacts: [{ artifactId: `result-${taskId}`, parts: [{ kind: 'text', text: 'Probe: technical-token callback test from order-detective-agent.' }] }]
  }
}
const cbRes = await fetch(callbackUrl, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    conversationid: conversationId,
    'x-correlationid': correlationId
  },
  body: JSON.stringify(body)
})
console.log(`Status: ${cbRes.status}`)
console.log((await cbRes.text()).slice(0, 2000) || '(empty body)')

const s = cbRes.status
console.log('\nVerdict:',
  s === 401 || s === 403 ? 'token REJECTED: Joule needs the user token (Felix setup).'
  : s >= 200 && s < 300 ? 'ACCEPTED. If you used real IDs, check the Joule chat for the probe message.'
  : 'auth looks ACCEPTED, conversation not matched. Rerun with real IDs from the agent log.')
