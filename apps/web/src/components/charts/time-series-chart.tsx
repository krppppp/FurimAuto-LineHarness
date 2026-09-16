'use client'

import { useState } from 'react'

export type ChartSeries = {
  key: string
  label: string
  kind: 'bar' | 'line'
  color: string
  /** 右軸に置く（金額と件数を重ねるとき） */
  right?: boolean
  format?: (n: number) => string
}

export type ChartPoint = { t: string } & Record<string, number | string>

interface Props {
  points: ChartPoint[]
  series: ChartSeries[]
  granularity: 'day' | 'month' | 'year'
  height?: number
}

const W = 960
const PAD = { top: 16, right: 56, bottom: 28, left: 56 }

/** 目盛りの丸め（friend-add-trend.html の nice() を移植） */
function niceMax(v: number): number {
  if (v <= 5) return 5
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const f = v / p
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10
  return n * p
}

/** 期間キー → 目盛りラベル（friend-add-trend.html の labelOf を移植） */
export function labelOf(granularity: 'day' | 'month' | 'year', key: string, full = false): string {
  if (granularity === 'day') {
    const [y, m, d] = key.split('-')
    return full ? `${y}/${Number(m)}/${Number(d)}` : `${Number(m)}/${Number(d)}`
  }
  if (granularity === 'month') {
    const [y, m] = key.split('-')
    return full ? `${y}年${Number(m)}月` : m === '01' ? `${y}/1` : `${Number(m)}月`
  }
  return full ? `${key}年` : key
}

export default function TimeSeriesChart({ points, series, granularity, height = 300 }: Props) {
  const [hover, setHover] = useState<number | null>(null)
  const H = height
  const innerW = W - PAD.left - PAD.right
  const innerH = H - PAD.top - PAD.bottom

  if (points.length === 0) {
    return <p className="py-10 text-center text-sm text-gray-400">この期間のデータはありません</p>
  }

  const val = (p: ChartPoint, k: string) => Number(p[k] ?? 0)
  const leftKeys = series.filter((s) => !s.right).map((s) => s.key)
  const rightKeys = series.filter((s) => s.right).map((s) => s.key)
  const maxOf = (keys: string[]) => niceMax(Math.max(1, ...points.flatMap((p) => keys.map((k) => val(p, k)))))
  const leftMax = maxOf(leftKeys.length ? leftKeys : ['__none'])
  const rightMax = maxOf(rightKeys.length ? rightKeys : ['__none'])

  const step = innerW / points.length
  const xOf = (i: number) => PAD.left + step * (i + 0.5)
  const yOf = (v: number, right: boolean) => PAD.top + innerH - (v / (right ? rightMax : leftMax)) * innerH

  // ラベルは最低 72px 間隔で間引く（friend-add-trend.html の showLabel と同じ考え方）
  const labelEvery = Math.max(1, Math.ceil(72 / step))
  const bars = series.filter((s) => s.kind === 'bar')
  const barW = Math.max(2, (step * 0.62) / Math.max(1, bars.length))

  const gridVals = [0, 0.25, 0.5, 0.75, 1]

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height }} role="img" onMouseLeave={() => setHover(null)}>
        {gridVals.map((g) => (
          <g key={g}>
            <line x1={PAD.left} x2={W - PAD.right} y1={PAD.top + innerH * (1 - g)} y2={PAD.top + innerH * (1 - g)} stroke="#f1f5f9" strokeWidth={1} />
            <text x={PAD.left - 8} y={PAD.top + innerH * (1 - g) + 4} textAnchor="end" fontSize={11} fill="#94a3b8">
              {Math.round(leftMax * g).toLocaleString('ja-JP')}
            </text>
            {rightKeys.length > 0 && (
              <text x={W - PAD.right + 8} y={PAD.top + innerH * (1 - g) + 4} textAnchor="start" fontSize={11} fill="#94a3b8">
                {Math.round(rightMax * g).toLocaleString('ja-JP')}
              </text>
            )}
          </g>
        ))}

        {points.map((p, i) =>
          bars.map((s, bi) => {
            const v = val(p, s.key)
            const y = yOf(v, !!s.right)
            const x = xOf(i) - (bars.length * barW) / 2 + bi * barW
            return <rect key={`${s.key}-${i}`} x={x} y={y} width={barW} height={Math.max(0, PAD.top + innerH - y)} fill={s.color} rx={2} />
          }),
        )}

        {series
          .filter((s) => s.kind === 'line')
          .map((s) => (
            <polyline
              key={s.key}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              points={points.map((p, i) => `${xOf(i)},${yOf(val(p, s.key), !!s.right)}`).join(' ')}
            />
          ))}

        {points.map((p, i) => (
          <g key={`x-${p.t}`}>
            {i % labelEvery === 0 && (
              <text x={xOf(i)} y={H - 8} textAnchor="middle" fontSize={11} fill="#94a3b8">
                {labelOf(granularity, p.t)}
              </text>
            )}
            <rect
              x={PAD.left + step * i}
              y={PAD.top}
              width={step}
              height={innerH}
              fill={hover === i ? '#0f172a' : 'transparent'}
              fillOpacity={hover === i ? 0.04 : 0}
              onMouseEnter={() => setHover(i)}
            />
          </g>
        ))}
      </svg>

      {hover !== null && points[hover] && (
        <div
          className="pointer-events-none absolute top-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs shadow-sm"
          style={{ left: `${Math.min(80, (hover / points.length) * 100)}%` }}
        >
          <p className="font-medium text-gray-700">{labelOf(granularity, points[hover].t, true)}</p>
          {series.map((s) => (
            <p key={s.key} className="mt-0.5 flex items-center gap-1.5 text-gray-600">
              <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
              {s.label}
              <span className="ml-auto pl-3 font-medium tabular-nums text-gray-900">
                {(s.format ?? ((n: number) => n.toLocaleString('ja-JP')))(val(points[hover], s.key))}
              </span>
            </p>
          ))}
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
        {series.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: s.color }} />
            {s.label}
            {s.right && <span className="text-gray-400">（右軸）</span>}
          </span>
        ))}
      </div>
    </div>
  )
}
