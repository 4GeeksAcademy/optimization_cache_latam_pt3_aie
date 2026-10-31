// Emisor de telemetría de Estante. Ver telemetry-plan.md y event-schemas.json.

const API_URL = import.meta.env.VITE_API_URL ?? '/api'
const ENDPOINT = `${API_URL}/events`
const APP_VERSION = '1.0.0'
const SCHEMA_VERSION = '1.0.0'
const EMITTER = 'estante-telemetry/1.0.0'

const MAX_BUFFERED_EVENTS = 20
const MAX_BATCH_SIZE = 50
const FLUSH_INTERVAL_MS = 5_000
const SESSION_IDLE_MS = 15 * 60_000

const SESSION_KEY = 'estante.telemetry.session'
const BUFFER_KEY = 'estante.telemetry.buffer'

// Eventos de usuario: interacción con la app (vistas).
export type UserEventProperties = {
  page_viewed: { path: string; page: 'catalog' | 'book_detail'; book_id?: number | null }
  book_detail_viewed: {
    book_id: number
    genre: string
    list_position: number | null
    search_query?: string | null
    has_stock?: boolean
  }
}
export type UserEventType = keyof UserEventProperties

// Eventos de error: fallos vistos por el usuario.
export type AppErrorProperties = {
  error_scope: 'render' | 'data_load' | 'route' | 'network'
  message: string
  path?: string | null
}

type EventContext = {
  app_version: string
  page_path: string | null
  referrer: string | null
  viewport_width: number | null
  os: string | null
  language: string | null
}

type EventMetadata = {
  sequence: number
  batch_id: string
  sent_at: string
  emitter: string
  locale: string | null
}

export type TelemetryEvent = {
  event_id: string
  timestamp: string
  session_id: string
  user_id: string | null
  event_type: string
  schema_version: string
  request_id: string
  source: 'frontend'
  context: EventContext
  metadata: EventMetadata
  properties: Record<string, unknown>
}

// batch_id/sent_at/emitter se completan al enviar el lote.
type BufferedEvent = Omit<TelemetryEvent, 'metadata'> & {
  metadata: Pick<EventMetadata, 'sequence' | 'locale'>
}

type Session = { id: string; last_activity: number; sequence: number }

let buffer: BufferedEvent[] = []
let flushing = false
let initialized = false

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function persistBuffer() {
  try {
    if (buffer.length) localStorage.setItem(BUFFER_KEY, JSON.stringify(buffer))
    else localStorage.removeItem(BUFFER_KEY)
  } catch {
    // localStorage lleno o bloqueado: el buffer sigue en memoria.
  }
}

function nextSession(): Session {
  const now = Date.now()
  const stored = readJson<Session>(SESSION_KEY)
  const session =
    stored && now - stored.last_activity < SESSION_IDLE_MS
      ? stored
      : { id: crypto.randomUUID(), last_activity: now, sequence: 0 }
  session.last_activity = now
  session.sequence += 1
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(session)) } catch { /* sin persistencia */ }
  return session
}

function buildContext(): EventContext {
  return {
    app_version: APP_VERSION,
    page_path: window.location.pathname.slice(0, 300),
    referrer: document.referrer ? document.referrer.slice(0, 300) : null,
    viewport_width: window.innerWidth ?? null,
    os: null,
    language: navigator.language?.slice(0, 35) ?? null,
  }
}

function enqueue(eventType: string, properties: Record<string, unknown>) {
  const session = nextSession()
  buffer.push({
    event_id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    session_id: session.id,
    user_id: null,
    event_type: eventType,
    schema_version: SCHEMA_VERSION,
    request_id: crypto.randomUUID(),
    source: 'frontend',
    context: buildContext(),
    metadata: { sequence: session.sequence, locale: navigator.language?.slice(0, 35) ?? null },
    properties,
  })
  persistBuffer()
}

function toBatch(events: BufferedEvent[]): { events: TelemetryEvent[] } {
  const batch_id = crypto.randomUUID()
  const sent_at = new Date().toISOString()
  return {
    events: events.map((event) => ({
      ...event,
      metadata: { ...event.metadata, batch_id, sent_at, emitter: EMITTER },
    })),
  }
}

// Limpia del buffer local (memoria + localStorage) los eventos ya entregados o descartados.
function removeFromBuffer(events: BufferedEvent[]) {
  const sent = new Set(events.map((event) => event.event_id))
  buffer = buffer.filter((event) => !sent.has(event.event_id))
  persistBuffer()
}

export async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return
  flushing = true
  const batch = buffer.slice(0, MAX_BATCH_SIZE)
  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(toBatch(batch)),
      keepalive: true,
    })
    if (response.ok) {
      removeFromBuffer(batch)
    } else if (response.status >= 400 && response.status < 500) {
      // Error de formato: reintentar no ayuda, se descarta el lote.
      console.warn(`[telemetry] lote rechazado (${response.status}), ${batch.length} eventos descartados`)
      removeFromBuffer(batch)
    }
    // 5xx: se conserva el lote para el siguiente intento.
  } catch {
    // Error de red: se conserva el lote para el siguiente intento.
  } finally {
    flushing = false
  }
}

function flushWithBeacon() {
  if (buffer.length === 0) return
  const batch = buffer.slice(0, MAX_BATCH_SIZE)
  const blob = new Blob([JSON.stringify(toBatch(batch))], { type: 'application/json' })
  if (navigator.sendBeacon?.(ENDPOINT, blob)) removeFromBuffer(batch)
}

export function trackEvent<T extends UserEventType>(eventType: T, properties: UserEventProperties[T]) {
  enqueue(eventType, properties)
  if (buffer.length >= MAX_BUFFERED_EVENTS) void flush()
}

// Los errores se envían de inmediato para no depender del temporizador.
export function trackError(properties: AppErrorProperties) {
  enqueue('app_error', {
    ...properties,
    message: properties.message.slice(0, 500),
    path: (properties.path ?? window.location.pathname).slice(0, 300),
  })
  void flush()
}

export function initTelemetry() {
  if (initialized) return
  initialized = true

  // Recupera eventos que no se llegaron a enviar en la visita anterior.
  const pending = readJson<BufferedEvent[]>(BUFFER_KEY) ?? []
  const known = new Set(buffer.map((event) => event.event_id))
  buffer = [...pending.filter((event) => !known.has(event.event_id)), ...buffer]
  persistBuffer()

  window.setInterval(() => void flush(), FLUSH_INTERVAL_MS)
  window.addEventListener('pagehide', flushWithBeacon)
  window.addEventListener('error', (event) => trackError({ error_scope: 'render', message: event.message || 'Error desconocido' }))
  window.addEventListener('unhandledrejection', (event) =>
    trackError({ error_scope: 'network', message: String(event.reason?.message ?? event.reason ?? 'Promesa rechazada') }),
  )
}
