import express from 'express'
import path from 'path'
import pino from 'pino'
import makeWASocket, { fetchLatestBaileysVersion, useMultiFileAuthState } from '.'
import { makeCacheableSignalKeyStore } from './Utils/auth-utils'
import qrcode from 'qrcode-terminal'

const app = express()
app.use(express.json())

const logger = pino({ level: 'info' })

type Session = {
  id: string
  sock: any
  saveCreds: () => Promise<void>
  status: string
  qr?: string
}

const sessions = new Map<string, Session>()

function genId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

app.post('/connect', async (req, res) => {
  const providedId = req.body?.sessionId as string | undefined
  const sessionId = providedId || genId()

  if (sessions.has(sessionId)) {
    return res.json({ sessionId, status: 'already_exists' })
  }

  try {
    const folder = path.join(process.cwd(), 'sessions', sessionId)
    const { state, saveCreds } = await useMultiFileAuthState(folder)
    const { version } = await fetchLatestBaileysVersion()

    const sock = makeWASocket({
      version,
      logger,
      auth: {
        creds: state.creds,
        // caching keys improves performance
        keys: makeCacheableSignalKeyStore(state.keys, logger as any)
      }
    })

    const s: Session = { id: sessionId, sock, saveCreds, status: 'connecting' }
    sessions.set(sessionId, s)

    // connection updates
    sock.ev.on('connection.update', (update: any) => {
      const { connection, qr } = update as any
      if (qr) {
        s.qr = qr
        s.status = 'qr'
        try {
          // print a compact QR in the terminal for quick scanning
          qrcode.generate(qr, { small: true })
        } catch (e) {
          // ignore if terminal QR fails
        }
      }
      if (connection === 'open') {
        s.status = 'open'
      }
      if (connection === 'close') {
        s.status = 'closed'
      }
    })

    // save creds when updated
    sock.ev.on('creds.update', saveCreds)

    return res.json({ sessionId, status: s.status, qr: s.qr })
  } catch (error) {
    logger.error({ err: error }, 'failed to create session')
    return res.status(500).json({ error: String(error) })
  }
})

app.post('/send', async (req, res) => {
  const { sessionId, jid, text } = req.body || {}
  if (!sessionId || !jid || !text) return res.status(400).json({ error: 'sessionId, jid and text are required' })

  const s = sessions.get(sessionId)
  if (!s) return res.status(404).json({ error: 'session not found' })

  try {
    const result = await s.sock.sendMessage(jid, { text })
    return res.json({ ok: true, result })
  } catch (err) {
    logger.error({ err }, 'send failed')
    return res.status(500).json({ error: String(err) })
  }
})

app.get('/status/:sessionId', (req, res) => {
  const s = sessions.get(req.params.sessionId)
  if (!s) return res.status(404).json({ error: 'not found' })
  return res.json({ sessionId: s.id, status: s.status, qr: s.qr })
})

app.post('/disconnect', async (req, res) => {
  const { sessionId } = req.body || {}
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })
  const s = sessions.get(sessionId)
  if (!s) return res.status(404).json({ error: 'not found' })

  try {
    // best-effort logout
    try {
      await s.sock.logout?.()
    } catch {}
    sessions.delete(sessionId)
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: String(err) })
  }
})

const port = process.env.PORT ? Number(process.env.PORT) : 3000
app.listen(port, () => logger.info({ port }, 'Baileys API listening'))

// export for tests
export default app
