'use client'

import { Suspense, useEffect, useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { api } from '@/lib/api'
import Header from '@/components/layout/header'

/**
 * LP分析 — 詳細
 *
 * 1つのLPを深掘りする: スクロール到達ファネル / 滞在時間分布（FV即離脱の可視化）/
 * 日別推移 / 広告バリアント別（utm_campaign×utm_content）/ 深度×追加率クロス。
 * static export のため動的セグメントは使わず ?page= で対象を受ける
 * （inflow-links/detail と同じ規約）。
 */

interface LpDetailData {
  page: string
  totals: {
    sessions: number
    ctaSessions: number
    friendAdds: number
    adSessions: number
    adFriendAdds: number
    mobileSessions: number
    mobileCta: number
  }
  scrollFunnel: {
    reach25: number
    reach50: number
    reach75: number
    reach90: number
    deepFriendAdds: number
    shallowFriendAdds: number
  }
  timeBuckets: {
    under3s: number
    under10s: number
    under30s: number
    under60s: number
    over60s: number
  }
  daily: Array<{ day: string; sessions: number; ctaSessions: number; friendAdds: number }>
  variants: Array<{
    utmCampaign: string
    utmContent: string
    sessions: number
    ctaSessions: number
    friendAdds: number
    scroll50: number
  }>
}

type SrcFilter = 'all' | 'ad' | 'organic'

const RANGE_PRESETS = [
  { key: '7d', label: '7日', days: 7 },
  { key: '30d', label: '30日', days: 30 },
  { key: '90d', label: '90日', days: 90 },
  { key: 'all', label: '全期間', days: null },
] as const

const pct = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0)

function Bar({ label, value, total, color, note }: {
  label: string
  value: number
  total: number
  color: string
  note?: string
}) {
  const width = total > 0 ? Math.max(2, (value / total) * 100) : 0
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-sm text-gray-600 text-right">{label}</span>
      <div className="flex-1 bg-gray-100 rounded h-6 overflow-hidden">
        <div className={`h-full rounded ${color}`} style={{ width: `${width}%` }} />
      </div>
      <span className="w-28 shrink-0 text-sm text-gray-800">
        {value}
        <span className="text-gray-400"> ({pct(value, total)}%)</span>
      </span>
      {note && <span className="text-xs text-gray-400">{note}</span>}
    </div>
  )
}

function LpDetailInner() {
  const searchParams = useSearchParams()
  const page = searchParams.get('page') || ''
  const [data, setData] = useState<LpDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [range, setRange] = useState<(typeof RANGE_PRESETS)[number]['key']>('30d')
  const [src, setSrc] = useState<SrcFilter>('all')

  useEffect(() => {
    if (!page) return
    const preset = RANGE_PRESETS.find((r) => r.key === range)!
    const to = new Date().toISOString().slice(0, 10)
    const from = preset.days
      ? new Date(Date.now() - preset.days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
      : '2026-01-01'
    setLoading(true)
    setError('')
    api.lpAnalytics
      .detail(`?page=${encodeURIComponent(page)}&from=${from}&to=${to}&src=${src}`)
      .then((res) => {
        if (res.success) setData(res.data as LpDetailData)
        else setError('データの取得に失敗しました')
      })
      .catch(() => setError('データの取得に失敗しました'))
      .finally(() => setLoading(false))
  }, [page, range, src])

  if (!page) {
    return (
      <div className="p-8 text-gray-400">
        対象LPが指定されていません。<Link href="/lp-analytics" className="text-blue-600 hover:underline">一覧へ戻る</Link>
      </div>
    )
  }

  const t = data?.totals
  const sf = data?.scrollFunnel
  const tb = data?.timeBuckets
  const sessions = t?.sessions ?? 0

  return (
    <div>
      <Header
        title={`LP分析: ${page}`}
        description="スクロール到達・滞在時間・広告バリアント別のパフォーマンスを深掘りします。"
      />

      <div className="mb-4">
        <Link href="/lp-analytics" className="text-sm text-blue-600 hover:underline">
          ← LP一覧へ戻る
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2 mb-6">
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
      ) : !data || sessions === 0 ? (
        <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-400">
          この期間の計測データがありません。
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            <div className="bg-white rounded-xl p-5 border border-gray-100">
              <p className="text-sm text-gray-500">セッション</p>
              <p className="text-3xl font-bold text-gray-900 mt-1">{sessions}</p>
              <p className="text-xs text-gray-400 mt-1">
                広告 {t!.adSessions} / モバイル {t!.mobileSessions}
              </p>
            </div>
            <div className="bg-white rounded-xl p-5 border border-gray-100">
              <p className="text-sm text-gray-500">CTAクリック率</p>
              <p className="text-3xl font-bold text-blue-600 mt-1">
                {pct(t!.ctaSessions, sessions)}%
              </p>
              <p className="text-xs text-gray-400 mt-1">{t!.ctaSessions}セッション</p>
            </div>
            <div className="bg-white rounded-xl p-5 border border-gray-100">
              <p className="text-sm text-gray-500">友だち追加率</p>
              <p className="text-3xl font-bold text-green-600 mt-1">
                {pct(t!.friendAdds, sessions)}%
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {t!.friendAdds}人（うち広告 {t!.adFriendAdds}）
              </p>
            </div>
            <div className="bg-white rounded-xl p-5 border border-gray-100">
              <p className="text-sm text-gray-500">3秒未満離脱</p>
              <p className="text-3xl font-bold text-red-500 mt-1">
                {pct(tb!.under3s, sessions)}%
              </p>
              <p className="text-xs text-gray-400 mt-1">FV即離脱の近似</p>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
            <div className="bg-white rounded-xl p-6 border border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">スクロール到達ファネル</h3>
              <div className="space-y-3">
                <Bar label="表示" value={sessions} total={sessions} color="bg-gray-400" />
                <Bar label="25%到達" value={sf!.reach25} total={sessions} color="bg-blue-300" />
                <Bar label="50%到達" value={sf!.reach50} total={sessions} color="bg-blue-400" />
                <Bar label="75%到達" value={sf!.reach75} total={sessions} color="bg-blue-500" />
                <Bar label="完読(90%)" value={sf!.reach90} total={sessions} color="bg-blue-600" />
                <Bar label="CTA" value={t!.ctaSessions} total={sessions} color="bg-emerald-500" />
                <Bar label="友だち追加" value={t!.friendAdds} total={sessions} color="bg-green-600" />
              </div>
              <p className="text-xs text-gray-400 mt-4">
                追加者の読了度: 75%以上読んで追加 {sf!.deepFriendAdds}人 / 75%未満で追加{' '}
                {sf!.shallowFriendAdds}人
              </p>
            </div>

            <div className="bg-white rounded-xl p-6 border border-gray-100">
              <h3 className="text-sm font-semibold text-gray-700 mb-4">滞在時間の分布</h3>
              <div className="space-y-3">
                <Bar label="〜3秒" value={tb!.under3s} total={sessions} color="bg-red-400" note="即離脱" />
                <Bar label="3〜10秒" value={tb!.under10s} total={sessions} color="bg-orange-400" />
                <Bar label="10〜30秒" value={tb!.under30s} total={sessions} color="bg-yellow-400" />
                <Bar label="30〜60秒" value={tb!.under60s} total={sessions} color="bg-lime-500" />
                <Bar label="60秒〜" value={tb!.over60s} total={sessions} color="bg-green-500" note="熟読" />
              </div>
              <p className="text-xs text-gray-400 mt-4">
                モバイルCTA率: {pct(t!.mobileCta, t!.mobileSessions)}%（モバイル{' '}
                {t!.mobileSessions}セッション中 {t!.mobileCta}）
              </p>
            </div>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 mb-8 overflow-x-auto">
            <h3 className="text-sm font-semibold text-gray-700 px-6 pt-5 pb-3">日別推移</h3>
            <table className="w-full min-w-[560px]">
              <thead className="bg-gray-50 border-y border-gray-200">
                <tr>
                  <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase">日付</th>
                  <th className="px-6 py-2 text-right text-xs font-medium text-gray-500 uppercase">セッション</th>
                  <th className="px-6 py-2 text-right text-xs font-medium text-gray-500 uppercase">CTA</th>
                  <th className="px-6 py-2 text-right text-xs font-medium text-gray-500 uppercase">追加</th>
                  <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase w-1/3">推移</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.daily.map((d) => {
                  const maxSessions = Math.max(...data.daily.map((x) => x.sessions), 1)
                  return (
                    <tr key={d.day}>
                      <td className="px-6 py-2 text-sm text-gray-700">{d.day}</td>
                      <td className="px-6 py-2 text-sm text-right text-gray-900">{d.sessions}</td>
                      <td className="px-6 py-2 text-sm text-right text-blue-600">{d.ctaSessions}</td>
                      <td className="px-6 py-2 text-sm text-right text-green-600">{d.friendAdds}</td>
                      <td className="px-6 py-2">
                        <div className="bg-gray-100 rounded h-3 overflow-hidden">
                          <div
                            className="h-full bg-blue-400 rounded"
                            style={{ width: `${(d.sessions / maxSessions) * 100}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
            <h3 className="text-sm font-semibold text-gray-700 px-6 pt-5 pb-1">
              広告バリアント別（utm_campaign × utm_content）
            </h3>
            <p className="text-xs text-gray-400 px-6 pb-3">
              広告のfinal URLに utm_content を付ければ、同一LP内で訴求バリアント別の比較ができます。
            </p>
            <table className="w-full min-w-[720px]">
              <thead className="bg-gray-50 border-y border-gray-200">
                <tr>
                  <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase">campaign</th>
                  <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 uppercase">content</th>
                  <th className="px-6 py-2 text-right text-xs font-medium text-gray-500 uppercase">セッション</th>
                  <th className="px-6 py-2 text-right text-xs font-medium text-gray-500 uppercase">CTA率</th>
                  <th className="px-6 py-2 text-right text-xs font-medium text-gray-500 uppercase">追加率</th>
                  <th className="px-6 py-2 text-right text-xs font-medium text-gray-500 uppercase">50%到達</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.variants.map((v, i) => (
                  <tr key={i}>
                    <td className="px-6 py-2 text-sm font-mono text-gray-700">{v.utmCampaign}</td>
                    <td className="px-6 py-2 text-sm font-mono text-gray-700">{v.utmContent}</td>
                    <td className="px-6 py-2 text-sm text-right text-gray-900">{v.sessions}</td>
                    <td className="px-6 py-2 text-sm text-right text-blue-600">
                      {pct(v.ctaSessions, v.sessions)}%
                    </td>
                    <td className="px-6 py-2 text-sm text-right text-green-600">
                      {pct(v.friendAdds, v.sessions)}%
                    </td>
                    <td className="px-6 py-2 text-sm text-right text-gray-700">
                      {pct(v.scroll50, v.sessions)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

export default function LpDetailPage() {
  return (
    <Suspense fallback={<div className="p-8 text-gray-400">読み込み中...</div>}>
      <LpDetailInner />
    </Suspense>
  )
}
