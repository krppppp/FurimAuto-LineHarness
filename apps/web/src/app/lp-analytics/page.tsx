'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'

/**
 * LP分析 — 一覧（リーダーボード）
 *
 * lp_events ビーコン（js/lp-metrics.js）のセッション集計を全LP横並びで表示する。
 * page は pathname の自動記録なので、新LPをアップするだけでここに出現する。
 * 任意列ソートで「勝ち訴求」を見つけ、行クリックで詳細へ。
 */

interface LpPageRow {
  page: string
  sessions: number
  adSessions: number
  mobileSessions: number
  ctaSessions: number
  friendAdds: number
  scroll50: number
  scroll90: number
  bounce3s: number
  avgMs: number | null
  lastSeenAt: string | null
}

type SortKey =
  | 'sessions'
  | 'ctaRate'
  | 'addRate'
  | 'scroll50Rate'
  | 'scroll90Rate'
  | 'bounceRate'
  | 'avgMs'

type SrcFilter = 'all' | 'ad' | 'organic'

const RANGE_PRESETS = [
  { key: '7d', label: '7日', days: 7 },
  { key: '30d', label: '30日', days: 30 },
  { key: '90d', label: '90日', days: 90 },
  { key: 'all', label: '全期間', days: null },
] as const

function rangeToQuery(days: number | null): { from: string; to: string } {
  const to = new Date()
  const from = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000) : new Date('2026-01-01')
  const fmt = (d: Date) => d.toISOString().slice(0, 10)
  return { from: fmt(from), to: fmt(to) }
}

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0)

const fmtSec = (ms: number | null) => {
  if (!ms) return '—'
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`
}

export default function LpAnalyticsPage() {
  const [rows, setRows] = useState<LpPageRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [range, setRange] = useState<(typeof RANGE_PRESETS)[number]['key']>('30d')
  const [src, setSrc] = useState<SrcFilter>('all')
  const [sortKey, setSortKey] = useState<SortKey>('sessions')

  useEffect(() => {
    const preset = RANGE_PRESETS.find((r) => r.key === range)!
    const { from, to } = rangeToQuery(preset.days)
    setLoading(true)
    setError('')
    api.lpAnalytics
      .pages(`?from=${from}&to=${to}&src=${src}`)
      .then((res) => {
        if (res.success) setRows(res.data as LpPageRow[])
        else setError('LP分析データの取得に失敗しました')
      })
      .catch(() => setError('LP分析データの取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [range, src])

  const sorted = useMemo(() => {
    const metric = (r: LpPageRow): number => {
      switch (sortKey) {
        case 'sessions': return r.sessions
        case 'ctaRate': return pct(r.ctaSessions, r.sessions)
        case 'addRate': return pct(r.friendAdds, r.sessions)
        case 'scroll50Rate': return pct(r.scroll50, r.sessions)
        case 'scroll90Rate': return pct(r.scroll90, r.sessions)
        case 'bounceRate': return pct(r.bounce3s, r.sessions)
        case 'avgMs': return r.avgMs ?? 0
      }
    }
    return [...rows].sort((a, b) => metric(b) - metric(a))
  }, [rows, sortKey])

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, r) => ({
          sessions: acc.sessions + r.sessions,
          cta: acc.cta + r.ctaSessions,
          adds: acc.adds + r.friendAdds,
        }),
        { sessions: 0, cta: 0, adds: 0 },
      ),
    [rows],
  )

  const th = (label: string, key: SortKey | null, tooltip?: string) => (
    <th
      className={`px-4 py-3 text-right text-xs font-medium uppercase whitespace-nowrap ${
        key ? 'cursor-pointer select-none hover:text-blue-600' : ''
      } ${sortKey === key ? 'text-blue-600' : 'text-gray-500'}`}
      onClick={key ? () => setSortKey(key) : undefined}
      title={tooltip}
    >
      {label}
      {sortKey === key ? ' ▼' : ''}
    </th>
  )

  return (
    <div>
      <Header
        title="LP分析"
        description="LPごとの行動計測（スクロール・滞在・CTA・友だち追加）。新しいLPは公開するだけで自動的にここに並びます。行クリックで深掘り。"
      />

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-xl p-5 border border-gray-100">
          <p className="text-sm text-gray-500">総セッション</p>
          <p className="text-3xl font-bold text-gray-900 mt-1">{totals.sessions}</p>
        </div>
        <div className="bg-white rounded-xl p-5 border border-gray-100">
          <p className="text-sm text-gray-500">CTAクリック率</p>
          <p className="text-3xl font-bold text-blue-600 mt-1">{pct(totals.cta, totals.sessions)}%</p>
        </div>
        <div className="bg-white rounded-xl p-5 border border-gray-100">
          <p className="text-sm text-gray-500">友だち追加率</p>
          <p className="text-3xl font-bold text-green-600 mt-1">{pct(totals.adds, totals.sessions)}%</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {RANGE_PRESETS.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              className={`px-3 py-1.5 text-sm ${
                range === r.key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex rounded-lg border border-gray-200 overflow-hidden">
          {(
            [
              ['all', 'すべて'],
              ['ad', '広告のみ'],
              ['organic', 'オーガニック'],
            ] as Array<[SrcFilter, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setSrc(key)}
              className={`px-3 py-1.5 text-sm ${
                src === key ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="text-xs text-gray-400 ml-auto">
          列見出しクリックでソート（広告/オーガニックはgclid等クリックIDの有無で判定）
        </span>
      </div>

      {error && (
        <div className="p-3 rounded bg-red-50 border border-red-200 text-red-700 text-sm mb-4">
          {error}
        </div>
      )}

      {loading ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          読み込み中...
        </div>
      ) : sorted.length === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          この期間の計測データがありません。LPに lp-metrics.js が入っていれば、アクセスがあり次第ここに自動で並びます。
        </div>
      ) : (
        <div className="bg-white rounded-lg border border-gray-200 overflow-x-auto">
          <table className="w-full min-w-[1080px]">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">
                  LPページ
                </th>
                {th('セッション', 'sessions')}
                {th('CTA率', 'ctaRate', 'LINE CTAをクリックしたセッションの割合')}
                {th('追加率', 'addRate', 'LINE友だち追加まで到達したセッションの割合')}
                {th('50%到達', 'scroll50Rate', 'ページの50%以上スクロールした割合')}
                {th('完読', 'scroll90Rate', 'ページの90%以上スクロールした割合')}
                {th('3秒離脱', 'bounceRate', '滞在3秒未満で離脱した割合（FV即離脱の近似）')}
                {th('平均滞在', 'avgMs')}
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase whitespace-nowrap">
                  広告/全体
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {sorted.map((r) => (
                <tr key={r.page} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm font-medium">
                    <Link
                      href={`/lp-analytics/detail?page=${encodeURIComponent(r.page)}`}
                      className="text-blue-600 hover:underline font-mono"
                    >
                      {r.page}
                    </Link>
                  </td>
                  <td className="px-4 py-3 text-sm text-right font-semibold text-gray-900">
                    {r.sessions}
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-blue-600 font-semibold">
                    {pct(r.ctaSessions, r.sessions)}%
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-green-600 font-semibold">
                    {pct(r.friendAdds, r.sessions)}%
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-700">
                    {pct(r.scroll50, r.sessions)}%
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-700">
                    {pct(r.scroll90, r.sessions)}%
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-red-500">
                    {pct(r.bounce3s, r.sessions)}%
                  </td>
                  <td className="px-4 py-3 text-sm text-right text-gray-700">{fmtSec(r.avgMs)}</td>
                  <td className="px-4 py-3 text-sm text-right text-gray-500">
                    {r.adSessions}/{r.sessions}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
