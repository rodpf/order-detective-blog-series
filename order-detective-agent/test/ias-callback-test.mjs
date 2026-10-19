// Can a client-credentials token from our own IAS app (via the agent-to-joule
// dependency) call Joule's async callback? Reads credentials from ./ias.json:
//   { "tenant": "https://<tenant>.accounts.ondemand.com",
//     "clientid": "...", "clientsecret": "...",
//     "dependency": "agent-to-joule",
//     "callback": "https://sapdas.us10.sapdas.cloud.sap/api/agent/v1/callback/a2a" }
// Run from the project root: node test/ias-callback-test.mjs
import { readFileSync } from 'node:fs'

const c = JSON.parse(readFileSync('./ias.json', 'utf8'))
const dependency = c.dependency || 'agent-to-joule'

// 1. Token from IAS
const tokenRes = await fetch(`${c.tenant.replace(/\/+$/, '')}/oauth2/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: c.clientid,
    client_secret: c.clientsecret,
    resource: `urn:sap:identity:application:provider:name:${dependency}`,
    token_format: 'jwt'
  })
})
const tokenBody = await tokenRes.text()
if (!tokenRes.ok) {
  console.log(`IAS token: HTTP ${tokenRes.status}\n${tokenBody}`)
  process.exit(1)
}
const token = JSON.parse(tokenBody).access_token
const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
console.log('IAS token: OK. Claims:')
console.log(JSON.stringify({ iss: claims.iss, aud: claims.aud, sub: claims.sub, ias_apis: claims.ias_apis }, null, 2))

// 2. Callback to Joule
const cbRes = await fetch(c.callback, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    conversationid: 'test-conv',
    'x-correlationid': 'test-corr'
  },
  body: JSON.stringify({
    id: 'test-corr', jsonrpc: '2.0',
    result: { id: 't1', contextId: 'c1', kind: 'task', status: { state: 'completed' },
      artifacts: [{ artifactId: 'r1', parts: [{ kind: 'text', text: 'test' }] }] }
  })
})
console.log(`\nCallback: HTTP ${cbRes.status}`)
console.log((await cbRes.text()).slice(0, 1000) || '(empty body)')
