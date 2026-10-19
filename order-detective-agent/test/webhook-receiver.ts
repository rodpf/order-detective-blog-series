/**
 * Throwaway local webhook catcher for testing the async push path without
 * real Joule / BTP destination credentials. Logs every POST it receives,
 * timestamped, so you can see the `working` ack from `message/send` land
 * instantly and the later push(es) land seconds afterward on a separate
 * connection.
 *
 * Run standalone: `npx tsx test/webhook-receiver.ts` (or compile+node).
 * Point `taskPushNotificationConfig.url` at it, e.g. http://localhost:9000/callback,
 * and run the main server with SKIP_DEST_EXCHANGE=true so joule-client.ts
 * posts straight here instead of doing the real destination/IAS exchange.
 */
import express from 'express'

const PORT = Number(process.env.WEBHOOK_PORT ?? 9000)
const app = express()
app.use(express.json())

app.post('/callback', (req, res) => {
  const t = new Date().toISOString()
  console.log(`\n[webhook-receiver] ${t} received push:`)
  console.log(JSON.stringify(req.body, null, 2))
  res.status(200).json({ received: true })
})

app.listen(PORT, () => {
  console.log(`[webhook-receiver] listening on http://localhost:${PORT}/callback`)
})
