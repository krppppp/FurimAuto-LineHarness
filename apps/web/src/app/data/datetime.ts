import type { DateTimeStorage } from './types'

// apps/worker/src/furim/admin-schema.ts の toDisplayDateTime / toStorageDateTime と同じ変換（CSV は Worker 側で同じ表示にする）

type DateParts = { y: number; mo: number; d: number; h: number; mi: number; s: number }

const JST_OFFSET_MS = 9 * 60 * 60_000
const STORED_RE = /^(\d{4})-(\d{2})-(\d{2})([T ])(\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?(Z|[+-]\d{2}:?\d{2})?$/
const DISPLAY_RE = /^(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

function jstMsOf(p: DateParts): number {
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - JST_OFFSET_MS
}

function partsOfJst(ms: number): DateParts {
  const t = new Date(ms + JST_OFFSET_MS)
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() }
}

function validParts(p: DateParts): boolean {
  const q = partsOfJst(jstMsOf(p))
  return q.y === p.y && q.mo === p.mo && q.d === p.d && q.h === p.h && q.mi === p.mi && q.s === p.s
}

function parseDisplayDateTime(value: string): DateParts | null {
  const d = DISPLAY_RE.exec(value)
  if (!d) return null
  const parts: DateParts = { y: +d[1], mo: +d[2], d: +d[3], h: +d[4], mi: +d[5], s: d[6] ? +d[6] : 0 }
  return validParts(parts) ? parts : null
}

function parseStoredDateTime(value: string): { parts: DateParts; storage: DateTimeStorage; ms: boolean } | null {
  const m = STORED_RE.exec(value)
  if (m) {
    const naive: DateParts = { y: +m[1], mo: +m[2], d: +m[3], h: +m[5], mi: +m[6], s: m[7] ? +m[7] : 0 }
    if (!validParts(naive)) return null
    const ms = Boolean(m[8])
    const tz = m[9]
    if (!tz) return { parts: naive, storage: m[4] === ' ' ? 'space' : 'jst_naive', ms }
    let offsetMin = 0
    if (tz !== 'Z') {
      const sign = tz[0] === '-' ? -1 : 1
      const digits = tz.slice(1).replace(':', '')
      offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)))
    }
    const utcMs = Date.UTC(naive.y, naive.mo - 1, naive.d, naive.h, naive.mi, naive.s) - offsetMin * 60_000
    return { parts: partsOfJst(utcMs), storage: offsetMin === 540 ? 'jst' : 'utc', ms }
  }
  const parts = parseDisplayDateTime(value)
  return parts ? { parts, storage: 'slash', ms: false } : null
}

function displayOf(p: DateParts): string {
  return `${pad(p.y, 4)}/${pad(p.mo)}/${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`
}

export function toDisplayDateTime(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'string' ? value : String(value)
  const parsed = parseStoredDateTime(text.trim())
  return parsed ? displayOf(parsed.parts) : text
}

export function toStorageDateTime(input: string, original: unknown, fallback: DateTimeStorage): string {
  const text = input.trim()
  if (text === '') return ''
  const orig = original === null || original === undefined ? '' : String(original)
  const parts = parseDisplayDateTime(text)
  if (!parts) return orig !== '' && toDisplayDateTime(orig) === text ? orig : input
  const before = orig !== '' ? parseStoredDateTime(orig.trim()) : null
  if (before && jstMsOf(before.parts) === jstMsOf(parts)) return orig
  const storage = before ? before.storage : fallback
  const ms = before ? before.ms : storage !== 'space' && storage !== 'slash'
  const date = `${pad(parts.y, 4)}-${pad(parts.mo)}-${pad(parts.d)}`
  const time = `${pad(parts.h)}:${pad(parts.mi)}:${pad(parts.s)}`
  const frac = ms ? '.000' : ''
  switch (storage) {
    case 'jst':
      return `${date}T${time}${frac}+09:00`
    case 'jst_naive':
      return `${date}T${time}${frac}`
    case 'space':
      return `${date} ${time}`
    case 'slash':
      return displayOf(parts)
    case 'utc': {
      const iso = new Date(jstMsOf(parts)).toISOString()
      return ms ? iso : iso.replace(/\.\d{3}Z$/, 'Z')
    }
  }
}
