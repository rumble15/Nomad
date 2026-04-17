import React, { useState, useEffect, useRef, useCallback } from 'react'
import ReactDOM from 'react-dom'
import { ArrowUp, Trash2, Reply, ChevronUp, MessageCircle, Smile, X, Sparkles } from 'lucide-react'
import { collabApi } from '../../api/client'
import { useSettingsStore } from '../../store/settingsStore'
import { useCanDo } from '../../store/permissionsStore'
import { useTripStore } from '../../store/tripStore'
import { addListener, removeListener } from '../../api/websocket'
import { useTranslation } from '../../i18n'
import type { User } from '../../types'

interface ChatReaction {
  emoji: string
  count: number
  users: { id: number; username: string }[]
}

interface ChatMessage {
  id: number
  trip_id: number
  user_id: number
  text: string
  reply_to_id: number | null
  reactions: ChatReaction[]
  created_at: string
  user?: { username: string; avatar_url: string | null }
  reply_to?: ChatMessage | null
  is_gemini?: boolean
  system_name?: string
}

type GeminiExecutionMode = 'auto' | 'review' | 'force'

interface GeminiExecutionMeta {
  execution_id?: string
  execution_mode?: GeminiExecutionMode | string
  risk_level?: 'low' | 'medium' | 'high' | string
  approval_required?: boolean
  needs_approval?: boolean
  needs_clarification?: boolean
  duration_ms?: number
  counts?: {
    planned?: number
    success?: number
    skipped?: number
    error?: number
  }
}

interface GeminiExecutionResponse {
  success?: boolean
  message?: ChatMessage | null
  model?: string
  warnings?: string[]
  actions?: Array<{ type?: string }>
  execution?: Array<Record<string, unknown>>
  needs_approval?: boolean
  approval_required?: boolean
  needs_clarification?: boolean
  execution_id?: string
  execution_mode?: GeminiExecutionMode | string
  risk_level?: 'low' | 'medium' | 'high' | string
  duration_ms?: number
  execution_meta?: GeminiExecutionMeta
}

interface GeminiLastRun {
  executionId: string
  mode: GeminiExecutionMode
  risk: 'low' | 'medium' | 'high' | 'unknown'
  planned: number
  success: number
  skipped: number
  errors: number
  durationMs: number | null
  needsApproval: boolean
  needsClarification: boolean
}

interface GeminiPendingApproval {
  sourceMessageId: number
  instruction?: string
  executionId?: string
  risk: 'low' | 'medium' | 'high' | 'unknown'
  actionCount: number
}

const GEMINI_TEMPLATES = [
  {
    id: 'day-flow',
    label: 'Day Flow',
    prompt: 'Plane den heutigen Tag als klaren Ablauf mit Zeitfenstern, Orten und 1 Backup-Option.',
  },
  {
    id: 'budget-pass',
    label: 'Budget Pass',
    prompt: 'Erstelle ein kompaktes Budget mit den wichtigsten Kostenpunkten inklusive Kategorie und realistischen Preisen.',
  },
  {
    id: 'packing-optimizer',
    label: 'Packing Optimizer',
    prompt: 'Erzeuge eine priorisierte Packliste nach Wetter, Aktivitäten und Dauer mit Mengenangaben.',
  },
  {
    id: 'map-expansion',
    label: 'Map Expansion',
    prompt: 'Finde 5 passende Orte für diese Reise, priorisiere nach logistischer Nähe und füge nur sinnvolle Kandidaten hinzu.',
  },
]

const EMOJI_FONT_STACK = '"Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji", sans-serif'
const CHAT_TEXT_FONT_STACK = `var(--font-system), ${EMOJI_FONT_STACK}`

function TwemojiImg({ emoji, size = 20, style = {} }) {
  return (
    <span
      role="img"
      aria-label={emoji}
      style={{
        fontSize: size,
        lineHeight: 1,
        display: 'inline-block',
        verticalAlign: 'middle',
        fontFamily: EMOJI_FONT_STACK,
        ...style,
      }}
    >
      {emoji}
    </span>
  )
}

const EMOJI_CATEGORIES = {
  'Smileys': ['😀','😂','🥹','😍','🤩','😎','🥳','😭','🤔','👀','🙈','🫠','😴','🤯','🥺','😤','💀','👻','🫡','🤝'],
  'Reactions': ['❤️','🔥','👍','👎','👏','🎉','💯','✨','⭐','💪','🙏','😱','😂','💖','💕','🤞','✅','❌','⚡','🏆'],
  'Travel': ['✈️','🏖️','🗺️','🧳','🏔️','🌅','🌴','🚗','🚂','🛳️','🏨','🍽️','🍕','🍹','📸','🎒','⛱️','🌍','🗼','🎌'],
}

// SQLite stores UTC without 'Z' suffix — append it so JS parses as UTC
function parseUTC(s) { return new Date(s && !s.endsWith('Z') ? s + 'Z' : s) }

function formatTime(isoString, is12h) {
  const d = parseUTC(isoString)
  const h = d.getHours()
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (is12h) {
    const period = h >= 12 ? 'PM' : 'AM'
    const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h
    return `${h12}:${mm} ${period}`
  }
  return `${String(h).padStart(2, '0')}:${mm}`
}

function formatDateSeparator(isoString, t) {
  const d = parseUTC(isoString)
  const now = new Date()
  const yesterday = new Date(); yesterday.setDate(now.getDate() - 1)

  if (d.toDateString() === now.toDateString()) return t('collab.chat.today') || 'Today'
  if (d.toDateString() === yesterday.toDateString()) return t('collab.chat.yesterday') || 'Yesterday'

  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function shouldShowDateSeparator(msg, prevMsg) {
  if (!prevMsg) return true
  const d1 = parseUTC(msg.created_at).toDateString()
  const d2 = parseUTC(prevMsg.created_at).toDateString()
  return d1 !== d2
}

function asGeminiMode(value: unknown): GeminiExecutionMode {
  const raw = typeof value === 'string' ? value.toLowerCase().trim() : ''
  if (raw === 'review') return 'review'
  if (raw === 'force') return 'force'
  return 'auto'
}

function asGeminiRisk(value: unknown): 'low' | 'medium' | 'high' | 'unknown' {
  const raw = typeof value === 'string' ? value.toLowerCase().trim() : ''
  if (raw === 'low' || raw === 'medium' || raw === 'high') return raw
  return 'unknown'
}

function toFiniteInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.trunc(n))
}

function formatDurationMs(value: number | null): string {
  if (!value || value <= 0) return 'n/a'
  if (value < 1000) return `${value} ms`
  const seconds = value / 1000
  return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`
}

function buildGeminiLastRun(data: GeminiExecutionResponse): GeminiLastRun | null {
  const meta = data.execution_meta || {}
  const counts = meta.counts || {}
  const executionRows = Array.isArray(data.execution) ? data.execution : []
  const fallbackSuccess = executionRows.filter((entry) => String((entry as Record<string, unknown>).status || '').toLowerCase() === 'ok').length
  const fallbackSkipped = executionRows.filter((entry) => String((entry as Record<string, unknown>).status || '').toLowerCase() === 'skipped').length
  const fallbackErrors = executionRows.filter((entry) => String((entry as Record<string, unknown>).status || '').toLowerCase() === 'error').length

  const executionId = typeof meta.execution_id === 'string'
    ? meta.execution_id
    : (typeof data.execution_id === 'string' ? data.execution_id : '')
  if (!executionId) return null

  const planned = toFiniteInt(counts.planned) ?? (Array.isArray(data.actions) ? data.actions.length : executionRows.length)
  const success = toFiniteInt(counts.success) ?? fallbackSuccess
  const skipped = toFiniteInt(counts.skipped) ?? fallbackSkipped
  const errors = toFiniteInt(counts.error) ?? fallbackErrors

  return {
    executionId,
    mode: asGeminiMode(meta.execution_mode ?? data.execution_mode),
    risk: asGeminiRisk(meta.risk_level ?? data.risk_level),
    planned,
    success,
    skipped,
    errors,
    durationMs: toFiniteInt(meta.duration_ms ?? data.duration_ms),
    needsApproval: !!(meta.needs_approval || meta.approval_required || data.needs_approval || data.approval_required),
    needsClarification: !!(meta.needs_clarification || data.needs_clarification),
  }
}

/* ── Emoji Picker ── */
interface EmojiPickerProps {
  onSelect: (emoji: string) => void
  onClose: () => void
  anchorRef: React.RefObject<HTMLElement | null>
  containerRef: React.RefObject<HTMLElement | null>
}

function EmojiPicker({ onSelect, onClose, anchorRef, containerRef }: EmojiPickerProps) {
  const [cat, setCat] = useState(Object.keys(EMOJI_CATEGORIES)[0])
  const ref = useRef(null)

  const getPos = () => {
    const container = containerRef?.current
    const anchor = anchorRef?.current
    if (container && anchor) {
      const cRect = container.getBoundingClientRect()
      const aRect = anchor.getBoundingClientRect()
      return { bottom: window.innerHeight - aRect.top + 16, left: cRect.left + cRect.width / 2 - 140 }
    }
    return { bottom: 80, left: 0 }
  }
  const pos = getPos()

  useEffect(() => {
    const close = (e) => {
      if (ref.current && ref.current.contains(e.target)) return
      if (anchorRef?.current && anchorRef.current.contains(e.target)) return
      onClose()
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onClose, anchorRef])

  return ReactDOM.createPortal(
    <div ref={ref} style={{
      position: 'fixed', bottom: pos.bottom, left: pos.left, zIndex: 10000,
      background: 'var(--bg-card)', border: '1px solid var(--border-faint)', borderRadius: 16,
      boxShadow: '0 8px 32px rgba(0,0,0,0.18)', width: 280, overflow: 'hidden',
    }}>
      {/* Category tabs */}
      <div style={{ display: 'flex', borderBottom: '1px solid var(--border-faint)', padding: '6px 8px', gap: 2 }}>
        {Object.keys(EMOJI_CATEGORIES).map(c => (
          <button key={c} onClick={() => setCat(c)} style={{
            flex: 1, padding: '4px 0', borderRadius: 6, border: 'none', cursor: 'pointer',
            background: cat === c ? 'var(--bg-hover)' : 'transparent',
            color: 'var(--text-primary)', fontSize: 10, fontWeight: 600, fontFamily: 'inherit',
          }}>
            {c}
          </button>
        ))}
      </div>
      {/* Emoji grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(10, 1fr)', gap: 2, padding: 8 }}>
        {EMOJI_CATEGORIES[cat].map((emoji, i) => (
          <button key={i} onClick={() => onSelect(emoji)} style={{
            width: 28, height: 28, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none', cursor: 'pointer', borderRadius: 6,
            padding: 2, transition: 'transform 0.1s',
          }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.transform = 'scale(1.2)' }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.transform = 'scale(1)' }}
          >
            <TwemojiImg emoji={emoji} size={20} />
          </button>
        ))}
      </div>
    </div>,
    document.body
  )
}

/* ── Reaction Quick Menu (right-click) ── */
const QUICK_REACTIONS = ['❤️', '😂', '👍', '😮', '😢', '🔥', '👏', '🎉']

interface ReactionMenuProps {
  x: number
  y: number
  onReact: (emoji: string) => void
  onClose: () => void
}

function ReactionMenu({ x, y, onReact, onClose }: ReactionMenuProps) {
  const ref = useRef(null)

  useEffect(() => {
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose() }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [onClose])

  // Clamp to viewport
  const menuWidth = 156
  const clampedLeft = Math.max(menuWidth / 2 + 8, Math.min(x, window.innerWidth - menuWidth / 2 - 8))

  return (
    <div ref={ref} style={{
      position: 'fixed', top: y - 80, left: clampedLeft, transform: 'translateX(-50%)', zIndex: 10000,
      background: 'var(--bg-card)', border: '1px solid var(--border-faint)', borderRadius: 16,
      boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: '6px 8px',
      display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 2, width: menuWidth,
    }}>
      {QUICK_REACTIONS.map(emoji => (
        <button key={emoji} onClick={() => onReact(emoji)} style={{
          width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', cursor: 'pointer', borderRadius: '50%',
          padding: 3, transition: 'transform 0.1s, background 0.1s',
        }}
          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.2)'; e.currentTarget.style.background = 'var(--bg-hover)' }}
          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.background = 'none' }}
        >
          <TwemojiImg emoji={emoji} size={18} />
        </button>
      ))}
    </div>
  )
}

/* ── Message Text with clickable URLs ── */
interface MessageTextProps {
  text: string
}

function MessageText({ text }: MessageTextProps) {
  const parts = text.split(URL_REGEX)
  const urls = text.match(URL_REGEX) || []
  const result = []
  parts.forEach((part, i) => {
    if (part) result.push(part)
    if (urls[i]) result.push(
      <a key={i} href={urls[i]} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline', textUnderlineOffset: 2, opacity: 0.85 }}>
        {urls[i]}
      </a>
    )
  })
  return <span style={{ fontFamily: CHAT_TEXT_FONT_STACK }}>{result}</span>
}

/* ── Link Preview ── */
const URL_REGEX = /https?:\/\/[^\s<>"']+/g
const previewCache = {}

interface LinkPreviewProps {
  url: string
  tripId: number
  own: boolean
  onLoad: (() => void) | undefined
}

function LinkPreview({ url, tripId, own, onLoad }: LinkPreviewProps) {
  const [data, setData] = useState(previewCache[url] || null)
  const [loading, setLoading] = useState(!previewCache[url])

  useEffect(() => {
    if (previewCache[url]) return
    collabApi.linkPreview(tripId, url).then(d => {
      previewCache[url] = d
      setData(d)
      setLoading(false)
      if (d?.title || d?.description || d?.image) onLoad?.()
    }).catch(() => setLoading(false))
  }, [url, tripId])

  if (loading || !data || (!data.title && !data.description && !data.image)) return null

  const domain = (() => { try { return new URL(url).hostname.replace('www.', '') } catch { return '' } })()

  return (
    <a href={url} target="_blank" rel="noopener noreferrer" style={{
      display: 'block', textDecoration: 'none', marginTop: 6, borderRadius: 12, overflow: 'hidden',
      border: own ? '1px solid rgba(255,255,255,0.15)' : '1px solid var(--border-faint)',
      background: own ? 'rgba(255,255,255,0.1)' : 'var(--bg-secondary)',
      maxWidth: 280, transition: 'opacity 0.15s',
    }}
      onMouseEnter={e => e.currentTarget.style.opacity = '0.85'}
      onMouseLeave={e => e.currentTarget.style.opacity = '1'}
    >
      {data.image && (
        <img src={data.image} alt="" style={{ width: '100%', height: 140, objectFit: 'cover', display: 'block' }}
          onError={e => e.target.style.display = 'none'} />
      )}
      <div style={{ padding: '8px 10px' }}>
        {domain && (
          <div style={{ fontSize: 10, fontWeight: 600, color: own ? 'rgba(255,255,255,0.5)' : 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 2 }}>
            {data.site_name || domain}
          </div>
        )}
        {data.title && (
          <div style={{ fontSize: 12, fontWeight: 600, color: own ? '#fff' : 'var(--text-primary)', lineHeight: 1.3, marginBottom: 2, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {data.title}
          </div>
        )}
        {data.description && (
          <div style={{ fontSize: 11, color: own ? 'rgba(255,255,255,0.7)' : 'var(--text-muted)', lineHeight: 1.3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {data.description}
          </div>
        )}
      </div>
    </a>
  )
}

/* ── Reaction Badge with NOMAD tooltip ── */
interface ReactionBadgeProps {
  reaction: ChatReaction
  currentUserId: number
  onReact: () => void
}

function ReactionBadge({ reaction, currentUserId, onReact }: ReactionBadgeProps) {
  const [hover, setHover] = useState(false)
  const [pos, setPos] = useState({ top: 0, left: 0 })
  const ref = useRef(null)
  const names = reaction.users.map(u => u.username).join(', ')

  return (
    <>
      <button ref={ref} onClick={onReact}
        onMouseEnter={() => {
          if (ref.current) {
            const rect = ref.current.getBoundingClientRect()
            setPos({ top: rect.top - 6, left: rect.left + rect.width / 2 })
          }
          setHover(true)
        }}
        onMouseLeave={() => setHover(false)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 2, padding: '1px 3px',
          borderRadius: 99, border: 'none', cursor: 'pointer', fontFamily: 'inherit',
          background: 'transparent', transition: 'transform 0.1s',
        }}
      >
        <TwemojiImg emoji={reaction.emoji} size={16} />
        {reaction.count > 1 && <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-muted)', minWidth: 8 }}>{reaction.count}</span>}
      </button>
      {hover && names && ReactDOM.createPortal(
        <div style={{
          position: 'fixed', top: pos.top, left: pos.left, transform: 'translate(-50%, -100%)',
          pointerEvents: 'none', zIndex: 10000, whiteSpace: 'nowrap',
          background: 'var(--bg-card, white)', color: 'var(--text-primary, #111827)',
          fontSize: 11, fontWeight: 500, padding: '5px 10px', borderRadius: 8,
          boxShadow: '0 4px 12px rgba(0,0,0,0.15)', border: '1px solid var(--border-faint, #e5e7eb)',
        }}>
          {names}
        </div>,
        document.body
      )}
    </>
  )
}

/* ── Main Component ── */
interface CollabChatProps {
  tripId: number
  currentUser: User
}

export default function CollabChat({ tripId, currentUser }: CollabChatProps) {
  const { t } = useTranslation()
  const is12h = useSettingsStore(s => s.settings.time_format) === '12h'
  const can = useCanDo()
  const trip = useTripStore((s) => s.trip)
  const selectedDayId = useTripStore((s) => s.selectedDayId)
  const canEdit = can('collab_edit', trip)

  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState(null)
  const [hoveredId, setHoveredId] = useState(null)
  const [sending, setSending] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [reactMenu, setReactMenu] = useState(null) // { msgId, x, y }
  const [deletingIds, setDeletingIds] = useState(new Set())
  const [executingGeminiId, setExecutingGeminiId] = useState<number | null>(null)
  const [geminiExecutionMode, setGeminiExecutionMode] = useState<GeminiExecutionMode>('auto')
  const [geminiLastRun, setGeminiLastRun] = useState<GeminiLastRun | null>(null)
  const [geminiPendingApproval, setGeminiPendingApproval] = useState<GeminiPendingApproval | null>(null)

  const containerRef = useRef(null)
  const messagesRef = useRef(messages)
  messagesRef.current = messages
  const scrollRef = useRef(null)
  const textareaRef = useRef(null)
  const emojiBtnRef = useRef(null)
  const isAtBottom = useRef(true)

  const scrollToBottom = useCallback((behavior = 'auto') => {
    const el = scrollRef.current
    if (!el) return
    requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight, behavior }))
  }, [])

  const checkAtBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    isAtBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }, [])

  /* ── load messages ── */
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    collabApi.getMessages(tripId).then(data => {
      if (cancelled) return
      const msgs = (Array.isArray(data) ? data : data.messages || []).map(m => m.deleted ? { ...m, _deleted: true } : m)
      setMessages(msgs)
      setHasMore(msgs.length >= 100)
      setLoading(false)
      setTimeout(() => scrollToBottom(), 30)
    }).catch(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [tripId, scrollToBottom])

  useEffect(() => {
    setGeminiPendingApproval(null)
    setGeminiLastRun(null)
    setGeminiExecutionMode('auto')
  }, [tripId])

  /* ── load more ── */
  const handleLoadMore = useCallback(async () => {
    if (loadingMore || messages.length === 0) return
    setLoadingMore(true)
    const el = scrollRef.current
    const prevHeight = el ? el.scrollHeight : 0
    try {
      const data = await collabApi.getMessages(tripId, messages[0]?.id)
      const older = (Array.isArray(data) ? data : data.messages || []).map(m => m.deleted ? { ...m, _deleted: true } : m)
      if (older.length === 0) { setHasMore(false) }
      else {
        setMessages(prev => [...older, ...prev])
        setHasMore(older.length >= 100)
        requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - prevHeight })
      }
    } catch {} finally { setLoadingMore(false) }
  }, [tripId, loadingMore, messages])

  /* ── websocket ── */
  useEffect(() => {
    const handler = (event) => {
      if (event.type === 'collab:message:created' && String(event.tripId) === String(tripId)) {
        setMessages(prev => prev.some(m => m.id === event.message.id) ? prev : [...prev, event.message])
        if (isAtBottom.current) setTimeout(() => scrollToBottom('smooth'), 30)
      }
      if (event.type === 'collab:message:deleted' && String(event.tripId) === String(tripId)) {
        setMessages(prev => prev.map(m => m.id === event.messageId ? { ...m, _deleted: true } : m))
        if (isAtBottom.current) setTimeout(() => scrollToBottom('smooth'), 50)
      }
      if (event.type === 'collab:message:reacted' && String(event.tripId) === String(tripId)) {
        setMessages(prev => prev.map(m => m.id === event.messageId ? { ...m, reactions: event.reactions } : m))
      }
    }
    addListener(handler)
    return () => removeListener(handler)
  }, [tripId, scrollToBottom])

  /* ── auto-resize textarea ── */
  const handleTextChange = useCallback((e) => {
    setText(e.target.value)
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      const h = Math.min(ta.scrollHeight, 100)
      ta.style.height = h + 'px'
      ta.style.overflowY = ta.scrollHeight > 100 ? 'auto' : 'hidden'
    }
  }, [])

  const executeGeminiForMessage = useCallback(async (
    sourceMessageId: number,
    opts?: { instruction?: string; mode?: GeminiExecutionMode }
  ) => {
    const mode = opts?.mode || geminiExecutionMode
    const payload: Record<string, unknown> = {
      execution_mode: mode,
      ...(selectedDayId ? { active_day_id: selectedDayId } : {}),
      ...(opts?.instruction ? { instruction: opts.instruction } : {}),
    }

    const data = await collabApi.executeGeminiIdea(tripId, sourceMessageId, payload) as GeminiExecutionResponse
    if (data?.message) {
      setMessages(prev => prev.some(m => m.id === data.message!.id) ? prev : [...prev, data.message])
      if (isAtBottom.current) setTimeout(() => scrollToBottom('smooth'), 40)
    }

    const lastRun = buildGeminiLastRun(data)
    if (lastRun) setGeminiLastRun(lastRun)

    const needsApproval = !!(data.needs_approval || data.approval_required || data.execution_meta?.needs_approval || data.execution_meta?.approval_required)
    if (needsApproval) {
      setGeminiPendingApproval({
        sourceMessageId,
        instruction: opts?.instruction,
        executionId: (data.execution_meta?.execution_id as string) || data.execution_id,
        risk: asGeminiRisk(data.execution_meta?.risk_level || data.risk_level),
        actionCount: Array.isArray(data.actions) ? data.actions.length : 0,
      })
    } else if (mode === 'force' || !needsApproval) {
      setGeminiPendingApproval(null)
    }

    return data
  }, [geminiExecutionMode, tripId, selectedDayId, scrollToBottom])

  /* ── send ── */
  const handleSend = useCallback(async () => {
    const body = text.trim()
    if (!body || sending) return

    const geminiCmdMatch = body.match(/^@gemini\b\s*(.*)$/i)
    const geminiInstruction = geminiCmdMatch ? (geminiCmdMatch[1] || '').trim() : null

    const sourceReply = replyTo
    setSending(true)
    try {
      const payload = { text: body }
      if (sourceReply) payload.reply_to = sourceReply.id
      const data = await collabApi.sendMessage(tripId, payload)
      if (data?.message) {
        setMessages(prev => prev.some(m => m.id === data.message.id) ? prev : [...prev, data.message])
      }

      setText('')
      setReplyTo(null)
      setShowEmoji(false)
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.overflowY = 'hidden'
      }
      isAtBottom.current = true
      setTimeout(() => scrollToBottom('smooth'), 50)

      const replyTargetsGemini = !!sourceReply?.is_gemini
      const shouldAutoGeminiReply = !geminiCmdMatch && replyTargetsGemini

      if (geminiCmdMatch || shouldAutoGeminiReply) {
        // If the replied message is already from Gemini, use the newly posted user message as source.
        // Otherwise preserve the explicit "reply as source" behavior for normal messages.
        const sourceMessageId = (sourceReply && !replyTargetsGemini) ? sourceReply.id : data?.message?.id
        const instruction = geminiCmdMatch ? (geminiInstruction || undefined) : undefined
        if (sourceMessageId) {
          setExecutingGeminiId(sourceMessageId)
          try {
            await executeGeminiForMessage(sourceMessageId, { instruction, mode: geminiExecutionMode })
          } catch {
            // Best effort: chat message is still posted even if Gemini execution fails.
          } finally {
            setExecutingGeminiId(null)
          }
        }
      }
    } catch {} finally { setSending(false) }
  }, [text, sending, replyTo, scrollToBottom, executeGeminiForMessage, geminiExecutionMode])

  const handleGeminiExecute = useCallback(async (msg) => {
    if (!msg || msg.is_gemini || executingGeminiId !== null) return
    setExecutingGeminiId(msg.id)
    try {
      await executeGeminiForMessage(msg.id, { mode: geminiExecutionMode })
    } catch {
      // Best effort UI action.
    } finally {
      setExecutingGeminiId(null)
    }
  }, [executingGeminiId, executeGeminiForMessage, geminiExecutionMode])

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend() }
  }, [handleSend])

  const handleDelete = useCallback(async (msgId) => {
    requestAnimationFrame(() => {
      setDeletingIds(prev => new Set(prev).add(msgId))
    })
    setTimeout(async () => {
      try {
        await collabApi.deleteMessage(tripId, msgId)
        setMessages(prev => prev.map(m => m.id === msgId ? { ...m, _deleted: true } : m))
      } catch {}
      setDeletingIds(prev => { const s = new Set(prev); s.delete(msgId); return s })
    }, 400)
  }, [tripId])

  const handleReact = useCallback(async (msgId, emoji) => {
    setReactMenu(null)
    try {
      const data = await collabApi.reactMessage(tripId, msgId, emoji)
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, reactions: data.reactions } : m))
    } catch {}
  }, [tripId])

  const handleEmojiSelect = useCallback((emoji) => {
    setText(prev => prev + emoji)
    textareaRef.current?.focus()
  }, [])

  const setComposerText = useCallback((nextText) => {
    setText(nextText)
    requestAnimationFrame(() => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      ta.style.height = 'auto'
      const h = Math.min(ta.scrollHeight, 100)
      ta.style.height = h + 'px'
      ta.style.overflowY = ta.scrollHeight > 100 ? 'auto' : 'hidden'
    })
  }, [])

  const prependGeminiCommand = useCallback((prefix) => {
    const trimmed = text.trim()
    if (!trimmed) {
      setComposerText(prefix)
      return
    }
    if (/^@gemini\b/i.test(trimmed)) {
      setComposerText(text)
      return
    }
    setComposerText(`${prefix}${trimmed}`)
  }, [text, setComposerText])

  const handleGeminiAssistClick = useCallback(() => {
    prependGeminiCommand('@gemini ')
  }, [prependGeminiCommand])

  const handleGeminiWebSearchClick = useCallback(() => {
    prependGeminiCommand('@gemini Suche im Web nach: ')
  }, [prependGeminiCommand])

  const handleGeminiTemplateClick = useCallback((templatePrompt: string) => {
    setComposerText(`@gemini ${templatePrompt}`)
  }, [setComposerText])

  const handleApprovePending = useCallback(async () => {
    if (!geminiPendingApproval || executingGeminiId !== null) return
    setExecutingGeminiId(geminiPendingApproval.sourceMessageId)
    try {
      await executeGeminiForMessage(geminiPendingApproval.sourceMessageId, {
        instruction: geminiPendingApproval.instruction,
        mode: 'force',
      })
    } catch {
      // Best effort: the review state remains visible.
    } finally {
      setExecutingGeminiId(null)
    }
  }, [geminiPendingApproval, executingGeminiId, executeGeminiForMessage])

  const handleRejectPending = useCallback(() => {
    setGeminiPendingApproval(null)
  }, [])

  const isOwn = (msg) => !msg.is_gemini && String(msg.user_id) === String(currentUser.id)
  const isGeminiCommand = /^@gemini\b/i.test(text.trim())

  const geminiModeLabel = geminiExecutionMode === 'auto'
    ? 'Hybrid Auto'
    : geminiExecutionMode === 'review'
      ? 'Review First'
      : 'Force Mode'

  const geminiLastRunTone = geminiLastRun?.risk === 'high'
    ? { border: '#f97316', bg: 'rgba(249,115,22,0.12)', text: '#9a3412' }
    : geminiLastRun?.risk === 'medium'
      ? { border: '#f59e0b', bg: 'rgba(245,158,11,0.12)', text: '#92400e' }
      : geminiLastRun?.risk === 'low'
        ? { border: '#16a34a', bg: 'rgba(22,163,74,0.12)', text: '#166534' }
        : { border: 'var(--border-primary)', bg: 'var(--bg-secondary)', text: 'var(--text-secondary)' }

  // Check if message is only emoji (1-3 emojis, no other text)
  const isEmojiOnly = (text) => {
    const emojiRegex = /^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}[\uFE0F]?(?:\u200D\p{Extended_Pictographic}[\uFE0F]?)*){1,3}$/u
    return emojiRegex.test(text.trim())
  }

  /* ── Loading ── */
  if (loading) {
    return (
      <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'center' }}>
        <div style={{ width: 24, height: 24, border: '2px solid var(--border-faint)', borderTopColor: 'var(--accent)', borderRadius: '50%', animation: 'spin .7s linear infinite' }} />
        <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      </div>
    )
  }

  /* ── Main ── */
  return (
    <div ref={containerRef} style={{
      display: 'flex',
      flexDirection: 'column',
      flex: 1,
      overflow: 'hidden',
      position: 'relative',
      minHeight: 0,
      height: '100%',
      background: 'radial-gradient(120% 120% at 50% 0%, var(--bg-secondary) 0%, var(--bg-card) 58%)',
    }}>
      {/* Messages */}
      {messages.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, color: 'var(--text-faint)', padding: 32 }}>
          <MessageCircle size={40} strokeWidth={1.2} style={{ opacity: 0.4 }} />
          <span style={{ fontSize: 14, fontWeight: 600 }}>{t('collab.chat.empty')}</span>
          <span style={{ fontSize: 12, opacity: 0.6 }}>{t('collab.chat.emptyDesc') || ''}</span>
        </div>
      ) : (
        <div ref={scrollRef} onScroll={checkAtBottom} className="chat-scroll" style={{
          flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: '10px 14px 8px', WebkitOverflowScrolling: 'touch',
          display: 'flex', flexDirection: 'column', gap: 1,
        }}>
          {hasMore && (
            <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0 10px' }}>
              <button onClick={handleLoadMore} disabled={loadingMore} style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
                color: 'var(--text-muted)', background: 'var(--bg-secondary)', border: '1px solid var(--border-faint)',
                borderRadius: 99, padding: '5px 14px', cursor: 'pointer', fontFamily: 'inherit',
              }}>
                <ChevronUp size={13} />
                {loadingMore ? '...' : t('collab.chat.loadMore')}
              </button>
            </div>
          )}

          {messages.map((msg, idx) => {
            const isGemini = !!msg.is_gemini
            const own = isOwn(msg)
            const prevMsg = messages[idx - 1]
            const nextMsg = messages[idx + 1]
            const isNewGroup = idx === 0 || String(prevMsg?.user_id) !== String(msg.user_id)
            const isLastInGroup = !nextMsg || String(nextMsg?.user_id) !== String(msg.user_id)
            const showDate = shouldShowDateSeparator(msg, prevMsg)
            const showAvatar = !own && isLastInGroup
            const bigEmoji = isEmojiOnly(msg.text)
            const hasReply = msg.reply_text || msg.reply_to
            // Deleted message placeholder
            if (msg._deleted) {
              return (
                <React.Fragment key={msg.id}>
                  {showDate && (
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 0 6px' }}>
                      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', background: 'var(--bg-secondary)', padding: '3px 12px', borderRadius: 99, letterSpacing: 0.3, textTransform: 'uppercase' }}>
                        {formatDateSeparator(msg.created_at, t)}
                      </span>
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '4px 0' }}>
                    <span style={{ fontSize: 11, color: 'var(--text-faint)', fontStyle: 'italic' }}>
                      {msg.username} {t('collab.chat.deletedMessage') || 'deleted a message'} · {formatTime(msg.created_at, is12h)}
                    </span>
                  </div>
                </React.Fragment>
              )
            }

            // Bubble border radius — iMessage style tails
            const br = own
              ? `18px 18px ${isLastInGroup ? '4px' : '18px'} 18px`
              : `18px 18px 18px ${isLastInGroup ? '4px' : '18px'}`

            return (
              <React.Fragment key={msg.id}>
                {/* Date separator */}
                {showDate && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '14px 0 6px' }}>
                    <span style={{
                      fontSize: 10, fontWeight: 600, color: 'var(--text-faint)',
                      background: 'var(--bg-secondary)', padding: '3px 12px', borderRadius: 99,
                      letterSpacing: 0.3, textTransform: 'uppercase',
                    }}>
                      {formatDateSeparator(msg.created_at, t)}
                    </span>
                  </div>
                )}

                <div style={{
                  display: 'flex', alignItems: own ? 'flex-end' : 'flex-start',
                  flexDirection: own ? 'row-reverse' : 'row',
                  gap: 6, marginTop: isNewGroup ? 10 : 1,
                  paddingLeft: own ? 40 : 0, paddingRight: own ? 0 : 40,
                  transition: 'transform 0.3s ease, opacity 0.3s ease, max-height 0.3s ease',
                  ...(deletingIds.has(msg.id) ? { transform: 'scale(0.3)', opacity: 0, maxHeight: 0, marginTop: 0, overflow: 'hidden' } : {}),
                }}>
                  {/* Avatar slot for others */}
                  {!own && (
                    <div style={{ width: 28, flexShrink: 0, alignSelf: 'flex-end' }}>
                      {showAvatar && (
                        isGemini ? (
                          <div style={{
                            width: 28, height: 28, borderRadius: '50%',
                            background: 'linear-gradient(135deg, #1d4ed8, #2563eb)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            color: '#fff',
                          }}>
                            <Sparkles size={14} />
                          </div>
                        ) : msg.user_avatar ? (
                          <img src={msg.user_avatar} alt="" style={{ width: 28, height: 28, borderRadius: '50%', objectFit: 'cover' }} />
                        ) : (
                          <div style={{
                            width: 28, height: 28, borderRadius: '50%', background: 'var(--bg-tertiary)',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            fontSize: 11, fontWeight: 700, color: 'var(--text-muted)',
                          }}>
                            {(msg.username || '?')[0].toUpperCase()}
                          </div>
                        )
                      )}
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: own ? 'flex-end' : 'flex-start', maxWidth: '78%', minWidth: 0 }}>
                    {/* Username for others at group start */}
                    {!own && isNewGroup && (
                      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-faint)', marginBottom: 2, paddingLeft: 4 }}>
                        {msg.system_name || msg.username}
                      </span>
                    )}

                    {/* Bubble */}
                    <div
                      style={{ position: 'relative' }}
                      onMouseEnter={() => setHoveredId(msg.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onContextMenu={e => { e.preventDefault(); if (canEdit) setReactMenu({ msgId: msg.id, x: e.clientX, y: e.clientY }) }}
                      onTouchEnd={e => {
                        const now = Date.now()
                        const lastTap = e.currentTarget.dataset.lastTap || 0
                        if (now - lastTap < 300 && canEdit) {
                          e.preventDefault()
                          const touch = e.changedTouches?.[0]
                          if (touch) setReactMenu({ msgId: msg.id, x: touch.clientX, y: touch.clientY })
                        }
                        e.currentTarget.dataset.lastTap = now
                      }}
                    >
                      {bigEmoji ? (
                        <div style={{ fontSize: 40, lineHeight: 1.2, padding: '2px 0', fontFamily: EMOJI_FONT_STACK }}>
                          {msg.text}
                        </div>
                      ) : (
                        <div style={{
                          background: isGemini
                            ? 'linear-gradient(135deg, #1d4ed8, #2563eb)'
                            : own ? '#007AFF' : 'var(--bg-secondary)',
                          color: (own || isGemini) ? '#fff' : 'var(--text-primary)',
                          borderRadius: br, padding: hasReply ? '4px 4px 8px 4px' : '8px 14px',
                          fontSize: 14, lineHeight: 1.4, wordBreak: 'break-word', whiteSpace: 'pre-wrap',
                          fontFamily: CHAT_TEXT_FONT_STACK,
                        }}>
                          {/* Inline reply quote */}
                          {hasReply && (
                            <div style={{
                              padding: '5px 10px', marginBottom: 4, borderRadius: 12,
                              background: own ? 'rgba(255,255,255,0.15)' : 'var(--bg-tertiary)',
                              fontSize: 12, lineHeight: 1.3,
                            }}>
                              <div style={{ fontWeight: 600, fontSize: 11, opacity: 0.7, marginBottom: 1 }}>
                                {msg.reply_username || ''}
                              </div>
                              <div style={{ opacity: 0.8, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {(msg.reply_text || '').slice(0, 80)}
                              </div>
                            </div>
                          )}
                          {hasReply ? (
                            <div style={{ padding: '0 10px 4px' }}><MessageText text={msg.text} /></div>
                          ) : <MessageText text={msg.text} />}
                          {(msg.text.match(URL_REGEX) || []).slice(0, 1).map(url => (
                            <LinkPreview key={url} url={url} tripId={tripId} own={own} onLoad={() => { if (isAtBottom.current) setTimeout(() => scrollToBottom('smooth'), 50) }} />
                          ))}
                        </div>
                      )}

                      {/* Hover actions */}
                      <div style={{
                        position: 'absolute', top: -14,
                        display: 'flex', gap: 2,
                        opacity: hoveredId === msg.id ? 1 : 0,
                        pointerEvents: hoveredId === msg.id ? 'auto' : 'none',
                        transition: 'opacity .1s',
                        ...(own ? { left: -6 } : { right: -6 }),
                      }}>
                        {!isGemini && canEdit && (
                          <button
                            onClick={() => handleGeminiExecute(msg)}
                            title={t('collab.chat.geminiExecute') || 'Ask Gemini to execute this idea'}
                            disabled={executingGeminiId !== null}
                            style={{
                              width: 24, height: 24, borderRadius: '50%', border: 'none',
                              background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                              cursor: executingGeminiId !== null ? 'default' : 'pointer', color: 'var(--accent-text)', padding: 0,
                              boxShadow: '0 2px 8px rgba(0,0,0,0.15)', transition: 'transform 0.12s',
                              opacity: executingGeminiId !== null ? 0.6 : 1,
                            }}
                            onMouseEnter={e => { if (executingGeminiId === null) e.currentTarget.style.transform = 'scale(1.2)' }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)' }}
                          >
                            <Sparkles size={11} />
                          </button>
                        )}
                        <button onClick={() => setReplyTo(msg)} title={t('collab.chat.reply')} style={{
                          width: 24, height: 24, borderRadius: '50%', border: 'none',
                          background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', color: 'var(--accent-text)', padding: 0,
                          boxShadow: '0 2px 8px rgba(0,0,0,0.15)', transition: 'transform 0.12s',
                        }}
                          onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.2)' }}
                          onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)' }}
                        >
                          <Reply size={11} />
                        </button>
                        {own && canEdit && !isGemini && (
                          <button onClick={() => handleDelete(msg.id)} title={t('common.delete')} style={{
                            width: 24, height: 24, borderRadius: '50%', border: 'none',
                            background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', color: 'var(--accent-text)', padding: 0,
                            boxShadow: '0 2px 8px rgba(0,0,0,0.15)', transition: 'transform 0.12s, background 0.15s, color 0.15s',
                          }}
                            onMouseEnter={e => { e.currentTarget.style.transform = 'scale(1.2)'; e.currentTarget.style.background = '#ef4444'; e.currentTarget.style.color = '#fff' }}
                            onMouseLeave={e => { e.currentTarget.style.transform = 'scale(1)'; e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent-text)' }}
                          >
                            <Trash2 size={11} />
                          </button>
                        )}
                      </div>
                    </div>

                    {!isGemini && canEdit && (
                      <div style={{ marginTop: 4, paddingLeft: own ? 0 : 6, paddingRight: own ? 6 : 0 }}>
                        <button
                          onClick={() => handleGeminiExecute(msg)}
                          disabled={executingGeminiId !== null}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 5,
                            border: '1px solid var(--border-primary)',
                            background: 'var(--bg-card)',
                            color: 'var(--text-secondary)',
                            borderRadius: 999,
                            padding: '3px 9px',
                            fontSize: 10,
                            fontWeight: 700,
                            letterSpacing: 0.2,
                            cursor: executingGeminiId !== null ? 'default' : 'pointer',
                            opacity: executingGeminiId !== null ? 0.55 : 0.95,
                          }}
                        >
                          <Sparkles size={10} />
                          {t('collab.chat.geminiExecute') || 'Run with Gemini'}
                        </button>
                      </div>
                    )}

                    {/* Reactions — iMessage style floating badge */}
                    {msg.reactions?.length > 0 && (
                      <div style={{
                        display: 'flex', gap: 3, marginTop: -6, marginBottom: 4,
                        justifyContent: own ? 'flex-end' : 'flex-start',
                        paddingLeft: own ? 0 : 8, paddingRight: own ? 8 : 0,
                        position: 'relative', zIndex: 1,
                      }}>
                        <div style={{
                          display: 'inline-flex', alignItems: 'center', gap: 2, padding: '3px 6px',
                          borderRadius: 99, background: 'var(--bg-card)',
                          boxShadow: '0 1px 6px rgba(0,0,0,0.12)', border: '1px solid var(--border-faint)',
                        }}>
                          {msg.reactions.map(r => {
                            const myReaction = r.users.some(u => String(u.user_id) === String(currentUser.id))
                            return (
                              <ReactionBadge key={r.emoji} reaction={r} currentUserId={currentUser.id} onReact={() => { if (canEdit) handleReact(msg.id, r.emoji) }} />
                            )
                          })}
                        </div>
                      </div>
                    )}

                    {/* Timestamp — only on last message of group */}
                    {isLastInGroup && (
                      <span style={{ fontSize: 9, color: 'var(--text-faint)', marginTop: 2, padding: '0 4px' }}>
                        {formatTime(msg.created_at, is12h)}
                      </span>
                    )}
                  </div>
                </div>
              </React.Fragment>
            )
          })}
        </div>
      )}

      {/* Composer */}
      <div style={{
        flexShrink: 0,
        padding: '10px 12px calc(12px + env(safe-area-inset-bottom, 0px))',
        borderTop: '1px solid var(--border-faint)',
        background: 'linear-gradient(180deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0) 100%), var(--bg-card)',
        boxShadow: '0 -10px 24px rgba(0,0,0,0.08)',
      }}>
        {/* Reply preview */}
        {replyTo && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
            padding: '6px 10px', borderRadius: 10, background: 'var(--bg-secondary)',
            borderLeft: '3px solid #007AFF', fontSize: 12, color: 'var(--text-muted)',
          }}>
            <Reply size={12} style={{ flexShrink: 0, opacity: 0.5 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              <strong>{replyTo.system_name || replyTo.username || 'Unknown'}</strong>: {(replyTo.text || '').slice(0, 60)}
            </span>
            <button onClick={() => setReplyTo(null)} style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: 2, color: 'var(--text-faint)',
              display: 'flex', flexShrink: 0,
            }}>
              <X size={14} />
            </button>
          </div>
        )}

        {canEdit && (
          <div style={{ marginBottom: 10, border: '1px solid var(--border-faint)', borderRadius: 14, padding: 10, background: 'linear-gradient(135deg, rgba(37,99,235,0.08), rgba(56,189,248,0.06))' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <div style={{ width: 20, height: 20, borderRadius: '50%', background: 'linear-gradient(135deg, #1d4ed8, #2563eb)', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <Sparkles size={11} />
                </div>
                <strong style={{ fontSize: 12, color: 'var(--text-primary)' }}>Gemini Command Center</strong>
              </div>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.2, color: 'var(--text-secondary)', background: 'var(--bg-card)', border: '1px solid var(--border-primary)', borderRadius: 999, padding: '2px 8px' }}>
                {geminiModeLabel}
              </span>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {([
                { id: 'auto', label: 'Hybrid Auto' },
                { id: 'review', label: 'Review First' },
                { id: 'force', label: 'Force Mode' },
              ] as Array<{ id: GeminiExecutionMode; label: string }>).map((modeOption) => (
                <button
                  key={modeOption.id}
                  onClick={() => setGeminiExecutionMode(modeOption.id)}
                  style={{
                    border: '1px solid var(--border-primary)',
                    background: geminiExecutionMode === modeOption.id ? 'var(--bg-hover)' : 'var(--bg-card)',
                    color: 'var(--text-secondary)',
                    borderRadius: 999,
                    padding: '4px 10px',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  {modeOption.label}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              <button
                onClick={handleGeminiAssistClick}
                style={{
                  border: '1px solid var(--border-primary)',
                  background: isGeminiCommand ? 'var(--bg-hover)' : 'var(--bg-card)',
                  color: 'var(--text-secondary)',
                  borderRadius: 999,
                  padding: '4px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Gemini Assist
              </button>
              <button
                onClick={handleGeminiWebSearchClick}
                style={{
                  border: '1px solid var(--border-primary)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-secondary)',
                  borderRadius: 999,
                  padding: '4px 10px',
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                Web Search
              </button>
            </div>

            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {GEMINI_TEMPLATES.map((template) => (
                <button
                  key={template.id}
                  onClick={() => handleGeminiTemplateClick(template.prompt)}
                  style={{
                    border: '1px dashed var(--border-primary)',
                    background: 'var(--bg-card)',
                    color: 'var(--text-secondary)',
                    borderRadius: 10,
                    padding: '3px 9px',
                    fontSize: 10,
                    fontWeight: 700,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                  title={template.prompt}
                >
                  {template.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {geminiPendingApproval && (
          <div style={{ marginBottom: 10, border: '1px solid #f59e0b', background: 'rgba(245,158,11,0.12)', borderRadius: 12, padding: '8px 10px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#92400e', marginBottom: 3 }}>High-risk execution waiting for approval</div>
            <div style={{ fontSize: 11, color: '#78350f', marginBottom: 7 }}>
              Risk: {geminiPendingApproval.risk} · Planned actions: {geminiPendingApproval.actionCount}
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={handleApprovePending}
                disabled={executingGeminiId !== null}
                style={{
                  border: '1px solid #f59e0b',
                  background: '#f59e0b',
                  color: '#fff',
                  borderRadius: 8,
                  padding: '4px 10px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: executingGeminiId !== null ? 'default' : 'pointer',
                  opacity: executingGeminiId !== null ? 0.6 : 1,
                }}
              >
                Approve & Execute
              </button>
              <button
                onClick={handleRejectPending}
                style={{
                  border: '1px solid var(--border-primary)',
                  background: 'var(--bg-card)',
                  color: 'var(--text-secondary)',
                  borderRadius: 8,
                  padding: '4px 10px',
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}

        {geminiLastRun && (
          <div style={{ marginBottom: 10, border: `1px solid ${geminiLastRunTone.border}`, background: geminiLastRunTone.bg, borderRadius: 12, padding: '8px 10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
              <strong style={{ fontSize: 11, color: geminiLastRunTone.text }}>Last Gemini Run</strong>
              <span style={{ fontSize: 10, color: geminiLastRunTone.text, fontWeight: 700 }}>{geminiLastRun.risk.toUpperCase()} · {geminiLastRun.mode.toUpperCase()}</span>
            </div>
            <div style={{ marginTop: 5, display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 6 }}>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Planned: <strong>{geminiLastRun.planned}</strong></div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>OK: <strong>{geminiLastRun.success}</strong></div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Skipped: <strong>{geminiLastRun.skipped}</strong></div>
              <div style={{ fontSize: 10, color: 'var(--text-secondary)' }}>Errors: <strong>{geminiLastRun.errors}</strong></div>
            </div>
            <div style={{ marginTop: 5, fontSize: 10, color: 'var(--text-secondary)' }}>
              Runtime: {formatDurationMs(geminiLastRun.durationMs)} · ID: {geminiLastRun.executionId.slice(0, 8)}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 6 }}>
          {/* Emoji button */}
          {canEdit && (
            <button ref={emojiBtnRef} onClick={() => setShowEmoji(!showEmoji)} style={{
              width: 34, height: 34, borderRadius: '50%', border: 'none',
              background: showEmoji ? 'var(--bg-hover)' : 'transparent',
              color: 'var(--text-muted)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', padding: 0, flexShrink: 0, transition: 'background 0.15s',
            }}>
              <Smile size={20} />
            </button>
          )}

          <textarea
            ref={textareaRef}
            rows={1}
            disabled={!canEdit}
            style={{
              flex: 1, resize: 'none', border: '1px solid var(--border-primary)', borderRadius: 20,
              padding: '8px 14px', fontSize: 14, lineHeight: 1.4, fontFamily: CHAT_TEXT_FONT_STACK,
              background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none',
              maxHeight: 100, overflowY: 'hidden',
              opacity: canEdit ? 1 : 0.5,
            }}
            placeholder={
              geminiExecutionMode === 'review'
                ? 'Schreibe eine Nachricht oder starte @gemini im Review-First Modus...'
                : geminiExecutionMode === 'force'
                  ? 'Schreibe eine Nachricht oder starte @gemini im Force Modus...'
                  : t('collab.chat.placeholder')
            }
            value={text}
            onChange={handleTextChange}
            onKeyDown={handleKeyDown}
          />

          {/* Send */}
          {canEdit && (
            <button onClick={handleSend} disabled={!text.trim() || sending} style={{
              width: 34, height: 34, borderRadius: '50%', border: 'none',
              background: text.trim() ? '#007AFF' : 'var(--border-primary)',
              color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: text.trim() ? 'pointer' : 'default', flexShrink: 0,
              transition: 'background 0.15s',
            }}>
              <ArrowUp size={18} strokeWidth={2.5} />
            </button>
          )}
        </div>
        {executingGeminiId !== null && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-faint)', display: 'flex', alignItems: 'center', gap: 6 }}>
            <Sparkles size={12} style={{ opacity: 0.85 }} />
            <span>{t('collab.chat.geminiThinking') || 'Gemini thinks with active trip context...'}</span>
            {selectedDayId ? <span style={{ opacity: 0.8 }}>{`Day #${selectedDayId}`}</span> : null}
            <span style={{ opacity: 0.8 }}>{geminiModeLabel}</span>
          </div>
        )}
        {isGeminiCommand && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-faint)' }}>
            {t('collab.chat.geminiCommandHint') || 'Gemini execution starts after sending. High-risk plans request explicit approval unless force mode is used.'}
          </div>
        )}
      </div>

      {/* Emoji picker */}
      {showEmoji && <EmojiPicker onSelect={handleEmojiSelect} onClose={() => setShowEmoji(false)} anchorRef={emojiBtnRef} containerRef={containerRef} />}

      {/* Reaction quick menu (right-click) */}
      {reactMenu && ReactDOM.createPortal(
        <ReactionMenu x={reactMenu.x} y={reactMenu.y} onReact={(emoji) => handleReact(reactMenu.msgId, emoji)} onClose={() => setReactMenu(null)} />,
        document.body
      )}
    </div>
  )
}
