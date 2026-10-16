'use client'

import { useEffect, useRef, useState } from 'react'

/**
 * 日付範囲の選択（TB-1265）。Stripe の「日付範囲」と同じ形: 左に早見 10 個、右に開始・終了の入力と 2 か月のカレンダー、下にクリア・適用。
 * 早見は開いた日を基準に毎回計算する（URL に残すのは早見の名前か、カレンダーで選んだ日付）。
 */

export const PRESETS = [
  { key: 'today', label: '今日' },
  { key: 'last7', label: '過去 7 日間' },
  { key: 'last4w', label: '過去 4 週間' },
  { key: 'last3m', label: '過去 3 か月' },
  { key: 'last6m', label: '過去 6 か月' },
  { key: 'last12m', label: '過去 12 か月' },
  { key: 'mtd', label: '今月（現在まで）' },
  { key: 'qtd', label: '今四半期（現在まで）' },
  { key: 'ytd', label: '今年（現在まで）' },
  { key: 'all', label: '全期間' },
] as const
export type PresetKey = (typeof PRESETS)[number]['key']

export type RangeSelection = { preset: PresetKey } | { from: string; to: string }

const pad = (n: number) => String(n).padStart(2, '0')
const fmt = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const parse = (ymd: string) => new Date(`${ymd}T00:00:00Z`)
export const addDays = (ymd: string, n: number) => fmt(new Date(parse(ymd).getTime() + n * 86400_000))
const addMonthsDay = (ymd: string, n: number) => {
  const d = parse(ymd)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n + 1, 0)).getUTCDate()
  return fmt(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, Math.min(d.getUTCDate(), last))))
}
export const jstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
const isDate = (v: string | null): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(parse(v).getTime())

/** 早見の期間。全期間の開始は 'all'（サーバーがデータのある最初の日にする） */
export function presetRange(key: PresetKey, today: string): { start: string; end: string } {
  const y = today.slice(0, 4)
  const m = Number(today.slice(5, 7))
  switch (key) {
    case 'today':
      return { start: today, end: today }
    case 'last7':
      return { start: addDays(today, -6), end: today }
    case 'last4w':
      return { start: addDays(today, -27), end: today }
    case 'last3m':
      return { start: addDays(addMonthsDay(today, -3), 1), end: today }
    case 'last6m':
      return { start: addDays(addMonthsDay(today, -6), 1), end: today }
    case 'last12m':
      return { start: addDays(addMonthsDay(today, -12), 1), end: today }
    case 'mtd':
      return { start: `${today.slice(0, 7)}-01`, end: today }
    case 'qtd':
      return { start: `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`, end: today }
    case 'ytd':
      return { start: `${y}-01-01`, end: today }
    case 'all':
      return { start: 'all', end: today }
  }
}

export function rangeOf(sel: RangeSelection, today: string) {
  return 'preset' in sel ? presetRange(sel.preset, today) : { start: sel.from, end: sel.to }
}

export const slash = (ymd: string) => `${ymd.slice(0, 4)}/${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`

export function selectionLabel(sel: RangeSelection) {
  if ('preset' in sel) return PRESETS.find((p) => p.key === sel.preset)?.label ?? ''
  return sel.from === sel.to ? slash(sel.from) : `${slash(sel.from)} 〜 ${slash(sel.to)}`
}

/** URL の ?range=<早見> か ?from=&to= を読む。無い・壊れているときは今年（現在まで） */
export function selectionFromSearch(search: string, today: string): RangeSelection {
  const q = new URLSearchParams(search)
  const r = q.get('range')
  if (PRESETS.some((p) => p.key === r)) return { preset: r as PresetKey }
  const from = q.get('from')
  const to = q.get('to')
  if (isDate(from) && isDate(to) && from <= to && to <= today) return { from, to }
  return { preset: 'ytd' }
}

export function selectionToSearch(sel: RangeSelection, search: string) {
  const q = new URLSearchParams(search)
  q.delete('range')
  q.delete('from')
  q.delete('to')
  if ('preset' in sel) q.set('range', sel.preset)
  else {
    q.set('from', sel.from)
    q.set('to', sel.to)
  }
  return `?${q.toString()}`
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土']

function MonthGrid({ ym, from, to, today, onPick }: { ym: string; from: string; to: string; today: string; onPick: (d: string) => void }) {
  const first = parse(`${ym}-01`)
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  const cells: Array<string | null> = [...Array(first.getUTCDay()).fill(null), ...Array.from({ length: days }, (_, i) => `${ym}-${pad(i + 1)}`)]
  return (
    <div className="w-full sm:w-[224px]">
      <p className="mb-2 text-center text-sm font-medium text-gray-800">
        {ym.slice(0, 4)}年{Number(ym.slice(5, 7))}月
      </p>
      <div className="grid grid-cols-7 text-center text-[11px] text-gray-400">
        {WEEK.map((w) => (
          <span key={w} className="py-1">
            {w}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-7 text-center text-sm">
        {cells.map((d, i) => {
          if (!d) return <span key={`e${i}`} />
          const disabled = d > today
          const edge = d === from || d === to
          const inside = !!from && !!to && d > from && d < to
          return (
            <button
              key={d}
              type="button"
              disabled={disabled}
              onClick={() => onPick(d)}
              className={`h-8 tabular-nums ${
                edge
                  ? 'rounded-md bg-blue-600 font-medium text-white'
                  : inside
                    ? 'bg-blue-50 text-blue-900'
                    : disabled
                      ? 'text-gray-300'
                      : 'rounded-md text-gray-700 hover:bg-gray-100'
              }`}
            >
              {Number(d.slice(8, 10))}
            </button>
          )
        })}
      </div>
    </div>
  )
}

const ymOf = (ymd: string) => ymd.slice(0, 7)
const shiftYm = (ym: string, n: number) => addMonthsDay(`${ym}-01`, n).slice(0, 7)

export default function DateRangePicker({
  value,
  dataStart,
  onChange,
}: {
  value: RangeSelection
  /** 全期間を選んだときにカレンダーに出す開始日 */
  dataStart: string | null
  onChange: (sel: RangeSelection) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<{ preset: PresetKey | null; from: string; to: string }>({ preset: null, from: '', to: '' })
  const [view, setView] = useState('')
  const box = useRef<HTMLDivElement>(null)
  const today = jstToday()

  const resolve = (sel: RangeSelection) => {
    const r = rangeOf(sel, today)
    return { from: r.start === 'all' ? (dataStart ?? r.end) : r.start, to: r.end }
  }

  const openPicker = () => {
    const r = resolve(value)
    setDraft({ preset: 'preset' in value ? value.preset : null, ...r })
    setView(shiftYm(ymOf(r.to), -1))
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])

  const pickPreset = (key: PresetKey) => {
    const r = resolve({ preset: key })
    setDraft({ preset: key, ...r })
    setView(shiftYm(ymOf(r.to), -1))
  }

  // 1 回目のクリックで開始、2 回目で終了（開始より前なら入れ替える）
  const pickDay = (d: string) => {
    setDraft((cur) => {
      if (!cur.from || cur.to) return { preset: null, from: d, to: '' }
      return d < cur.from ? { preset: null, from: d, to: cur.from } : { preset: null, from: cur.from, to: d }
    })
  }

  const setInput = (k: 'from' | 'to', v: string) => {
    if (!isDate(v) || v > today) return
    setDraft((cur) => ({ ...cur, preset: null, [k]: v }))
    setView(shiftYm(ymOf(v), k === 'from' ? 0 : -1))
  }

  const canApply = !!draft.preset || (isDate(draft.from) && isDate(draft.to) && draft.from <= draft.to)
  const apply = () => {
    if (!canApply) return
    onChange(draft.preset ? { preset: draft.preset } : { from: draft.from, to: draft.to })
    setOpen(false)
  }

  return (
    <div ref={box} className="relative">
      <button
        type="button"
        onClick={() => (open ? setOpen(false) : openPicker())}
        className="flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm hover:bg-gray-50"
      >
        <span className="text-gray-500">日付範囲</span>
        <span className="h-4 w-px bg-gray-300" />
        <span className="font-medium text-blue-700">{selectionLabel(value)}</span>
        <span className="text-xs text-gray-400">▾</span>
      </button>

      {open && (
        <div className="fixed inset-x-2 top-16 z-50 max-h-[calc(100vh-5rem)] overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl sm:absolute sm:inset-x-auto sm:left-0 sm:top-full sm:mt-2 sm:max-h-none sm:w-max">
          <div className="flex flex-col sm:flex-row">
            <ul className="flex flex-wrap gap-1 border-b border-gray-100 p-2 sm:w-44 sm:flex-col sm:flex-nowrap sm:gap-0 sm:border-b-0 sm:border-r">
              {PRESETS.map((p) => (
                <li key={p.key}>
                  <button
                    type="button"
                    onClick={() => pickPreset(p.key)}
                    className={`w-full rounded-md px-2.5 py-1.5 text-left text-sm ${
                      draft.preset === p.key ? 'bg-blue-50 font-medium text-blue-700' : 'text-gray-700 hover:bg-gray-50'
                    }`}
                  >
                    {p.label}
                  </button>
                </li>
              ))}
            </ul>
            <div className="p-3 sm:p-4">
              <div className="flex items-center gap-2">
                <label className="flex-1">
                  <span className="block text-[11px] text-gray-500">開始日</span>
                  <input
                    type="date"
                    value={draft.from}
                    max={today}
                    onChange={(e) => setInput('from', e.target.value)}
                    className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm tabular-nums"
                  />
                </label>
                <span className="mt-4 text-gray-400">→</span>
                <label className="flex-1">
                  <span className="block text-[11px] text-gray-500">終了日</span>
                  <input
                    type="date"
                    value={draft.to}
                    min={draft.from || undefined}
                    max={today}
                    onChange={(e) => setInput('to', e.target.value)}
                    className="mt-0.5 w-full rounded-md border border-gray-300 px-2 py-1 text-sm tabular-nums"
                  />
                </label>
              </div>
              <div className="mt-3 flex items-start gap-2">
                <button type="button" onClick={() => setView((v) => shiftYm(v, -1))} className="rounded px-2 py-1 text-gray-500 hover:bg-gray-100" aria-label="前の月">
                  ‹
                </button>
                <div className="flex flex-1 gap-6">
                  {view && <MonthGrid ym={view} from={draft.from} to={draft.to} today={today} onPick={pickDay} />}
                  <div className="hidden sm:block">
                    {view && <MonthGrid ym={shiftYm(view, 1)} from={draft.from} to={draft.to} today={today} onPick={pickDay} />}
                  </div>
                </div>
                <button type="button" onClick={() => setView((v) => shiftYm(v, 1))} className="rounded px-2 py-1 text-gray-500 hover:bg-gray-100" aria-label="次の月">
                  ›
                </button>
              </div>
              <div className="mt-3 flex items-center justify-end gap-2 border-t border-gray-100 pt-3">
                <button
                  type="button"
                  onClick={() => setDraft({ preset: null, from: '', to: '' })}
                  className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
                >
                  クリア
                </button>
                <button
                  type="button"
                  disabled={!canApply}
                  onClick={apply}
                  className="rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:bg-gray-300"
                >
                  適用
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
