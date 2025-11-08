import express from 'express'
import path from 'path'
import pino from 'pino'
import makeWASocket, { fetchLatestBaileysVersion, useMultiFileAuthState } from '.'
import { makeCacheableSignalKeyStore } from './Utils/auth-utils'
import qrcode from 'qrcode-terminal'
import qrcodeLib from 'qrcode'
import { readdir, stat } from 'fs/promises'

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
  lastDisconnect?: {
    code?: number
    reason?: string
    raw?: any
    at: string
  }
  reconnectAttempts?: number
}

const sessions = new Map<string, Session>()
// map external user id -> sessionId
const userSessions = new Map<string, string>()

function genId() {
  return `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

async function createOrReconnectSession(sessionId: string, userId?: string, isReconnect = false) {
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

  let s = sessions.get(sessionId)
  if(!s) {
    s = { id: sessionId, sock, saveCreds, status: 'connecting', reconnectAttempts: 0 }
    sessions.set(sessionId, s)
  } else {
    // replace socket reference on reconnect
    s.sock = sock
    s.status = 'connecting'
  }
  if (userId) userSessions.set(userId, sessionId)

  sock.ev.on('connection.update', (update: any) => {
    const { connection, qr, lastDisconnect } = update as any
    if (qr) {
      s!.qr = qr
      s!.status = 'qr'
      try {
        qrcode.generate(qr, { small: true })
        qrcodeLib.toDataURL(qr).then((dataUrl: string) => { (s as any).qrDataUrl = dataUrl }).catch(() => {})
      } catch {}
    }
    if (connection === 'open') {
      s!.status = 'open'
      s!.reconnectAttempts = 0
    }
    if (connection === 'close') {
      s!.status = 'closed'
      const code = lastDisconnect?.error?.output?.statusCode
      const tag = lastDisconnect?.error?.data?.tag
      s!.lastDisconnect = {
        code,
        reason: tag || (lastDisconnect?.error?.message) || 'unknown',
        raw: lastDisconnect?.error,
        at: new Date().toISOString()
      }
      // decide if should reconnect (avoid if loggedOut / badSession)
      const loggedOutCodes = [401, 403, 405, 428, 440] // some known final codes
      const shouldReconnect = code && !loggedOutCodes.includes(code)
      if(shouldReconnect) {
        scheduleReconnect(s!, userId)
      }
    }
  })

  sock.ev.on('creds.update', saveCreds)
  return s
}

function scheduleReconnect(session: Session, userId?: string) {
  session.reconnectAttempts = (session.reconnectAttempts || 0) + 1
  const attempt = session.reconnectAttempts
  const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 1000 * 30) // cap at 30s
  logger.warn({ sessionId: session.id, attempt, backoffMs }, 'scheduling reconnect')
  setTimeout(() => {
    logger.info({ sessionId: session.id, attempt }, 'attempting reconnect')
    createOrReconnectSession(session.id, userId, true).catch(err => {
      logger.error({ err, sessionId: session.id }, 'reconnect failed')
      scheduleReconnect(session, userId)
    })
  }, backoffMs)
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
    const s = await createOrReconnectSession(sessionId, userId)
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
  return res.json({ sessionId: s.id, status: s.status, qr: s.qrDataUrl || s.qr, lastDisconnect: s.lastDisconnect, reconnectAttempts: s.reconnectAttempts })
})

// list active sessions (optionally filter by userId)
app.get('/sessions', (req: express.Request, res: express.Response) => {
  const userId = req.query.userId as string | undefined
  const list = Array.from(sessions.values())
    .filter(s => !userId || Array.from(userSessions.entries()).some(([u, sid]) => u === userId && sid === s.id))
    .map(s => {
      const mapping = Array.from(userSessions.entries()).find(([, sid]) => sid === s.id)
      return { sessionId: s.id, status: s.status, userId: mapping ? mapping[0] : null, reconnectAttempts: s.reconnectAttempts }
    })
  return res.json(list)
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

const port = process.env.PORT ? Number(process.env.PORT) : 3009

// on startup: load any existing session folders and attempt reconnection
async function loadExistingSessions() {
  const sessionsDir = path.join(process.cwd(), 'sessions')
  try {
    const entries = await readdir(sessionsDir)
    for (const name of entries) {
      try {
        const full = path.join(sessionsDir, name)
        const s = await stat(full)
        if (s.isDirectory()) {
          // if we don't already have it in memory, create/reconnect
          if (!sessions.has(name)) {
            logger.info({ sessionId: name }, 'loading session from disk')
            createOrReconnectSession(name).catch(err => {
              logger.error({ err, sessionId: name }, 'failed to load session on startup')
            })
          }
        }
      } catch (err) {
        // ignore single entry errors
        logger.warn({ err, entry: name }, 'skipping session entry')
      }
    }
  } catch (err: any) {
    // if folder doesn't exist, just skip
    if (err.code === 'ENOENT') {
      logger.info('no sessions directory, skipping load')
      return
    }
    logger.error({ err }, 'failed to read sessions directory')
  }
}

// start server and then load sessions
app.listen(port, async () => {
  logger.info({ port }, 'Baileys API listening')
  // try to restore sessions persisted on disk
  try {
    await loadExistingSessions()
  } catch (err) {
    logger.error({ err }, 'error while loading existing sessions')
  }
})

// export for tests
export default app
