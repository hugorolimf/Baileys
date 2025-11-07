import express from 'express'
import path from 'path'
import pino from 'pino'
import makeWASocket, { fetchLatestBaileysVersion, useMultiFileAuthState } from '.'
import { makeCacheableSignalKeyStore } from './Utils/auth-utils'
import qrcode from 'qrcode-terminal'
import qrcodeLib from 'qrcode'

const app = express()
app.use(express.json())

const logger = pino({ level: 'info' })

type Session = {
  id: string
  sock: any
  saveCreds: () => Promise<void>
  status: string
  qr?: string
  qrDataUrl?: string
}

const sessions = new Map<string, Session>()
// map external user id -> sessionId
const userSessions = new Map<string, string>()

function genId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

app.post('/connect', async (req: express.Request, res: express.Response) => {
  const providedId = req.body?.sessionId as string | undefined
  const userId = req.body?.userId as string | undefined

  // if userId already has a session, return it
  if (userId && userSessions.has(userId)) {
    const existing = userSessions.get(userId) as string
    const s = sessions.get(existing)
    return res.json({ sessionId: existing, status: s?.status, qr: s?.qrDataUrl })
  }
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
    if (userId) userSessions.set(userId, sessionId)

    // connection updates
    sock.ev.on('connection.update', (update: any) => {
      const { connection, qr } = update as any
      if (qr) {
        s.qr = qr
        s.status = 'qr'
        try {
          // print a compact QR in the terminal for quick scanning
          qrcode.generate(qr, { small: true })
          // also generate a data URL PNG for the client to fetch
          try {
            qrcodeLib.toDataURL(qr).then((dataUrl: string) => {
              ;(s as any).qrDataUrl = dataUrl
            }).catch(() => {})
          } catch {}
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

    return res.json({ sessionId, status: s.status, qr: s.qrDataUrl || s.qr })
  } catch (error) {
    logger.error({ err: error }, 'failed to create session')
    return res.status(500).json({ error: String(error) })
  }
})

app.post('/send', async (req: express.Request, res: express.Response) => {
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

app.get('/status/:sessionId', (req: express.Request, res: express.Response) => {
  const sessionId = req.params.sessionId as string | undefined
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })
  const s = sessions.get(sessionId)
  if (!s) return res.status(404).json({ error: 'not found' })
  return res.json({ sessionId: s.id, status: s.status, qr: s.qrDataUrl || s.qr })
})

// return QR as dataURL for the client (convenience endpoint)
app.get('/qr/:sessionId', (req: express.Request, res: express.Response) => {
  const sessionId = req.params.sessionId as string | undefined
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' })
  const s = sessions.get(sessionId)
  if (!s) return res.status(404).json({ error: 'not found' })
  const dataUrl = s.qrDataUrl || s.qr
  if (!dataUrl) return res.status(404).json({ error: 'qr not available yet' })
  return res.json({ sessionId: s.id, qr: dataUrl })
})

app.post('/disconnect', async (req: express.Request, res: express.Response) => {
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
    // remove any userSessions pointing to this session
    for (const [u, sid] of userSessions.entries()) if (sid === sessionId) userSessions.delete(u)
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: String(err) })
  }
})

const port = process.env.PORT ? Number(process.env.PORT) : 3000
app.listen(port, () => logger.info({ port }, 'Baileys API listening'))

// export for tests
export default app
