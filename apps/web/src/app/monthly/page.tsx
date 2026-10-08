'use client'

import { useCallback, useEffect, useState } from 'react'
import Header from '@/components/layout/header'
import { formatNumber, formatYen } from '@/components/charts/stat-card'
import TimeSeriesChart, { labelOf, type ChartPoint, type ChartSeries } from '@/components/charts/time-series-chart'

/**
 * 月次ダッシュボード（TB-1189）。今年 1 月〜今月を月ごとに出す。数字はすべて D1（GET /api/furim/dashboard/monthly）。
 * 定義は apps/worker/src/furim/monthly-dashboard.ts。画面の注記と合わせて直す。
 */

const ROUTE_GROUPS = ['広告', '運用（SEO・SNS）', '拡張機能', '紹介', 'その他', '経路なし'] as const
const SEGMENT_KEYS = ['有料化', 'セグメント5〜8', 'セグメント4', 'セグメント3', 'セグメント1〜2', 'ブロック', '対象外'] as const

type Card = { value: number | null; prev: number | null }
type Month = {
  t: string
  friendsAdded: number
  blocked: number | null
  net: number | null
  members: number
  mrr: number
  newPaid: number
  churned: number
  trialStarted: number
  cohortPaid: number
  routesAdded: Record<string, number>
  routesPaid: Record<string, number>
  segments: Record<string, number>
}
type Monthly = {
  success: boolean
  range: { from: string; to: string; asOf: string; blockedSince: string | null }
  months: Month[]
  cards: Record<'friendsAdded' | 'net' | 'members' | 'mrr' | 'newPaid' | 'churned', Card>
  routeDetail: Array<{ route: string; group: string; added: number; paid: number }>
}

// 色は分類ごとに固定（dataviz の検証済みパレット）。経路なし・ブロックは灰色
const CAT = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4']
const GRAY = '#a3a3a3'
const LIGHT_GRAY = '#d4d4d4'
const ROUTE_COLORS: Record<string, string> = { 広告: CAT[0], '運用（SEO・SNS）': CAT[1], 拡張機能: CAT[2], 紹介: CAT[3], その他: CAT[4], 経路なし: GRAY }
// 段階は青の濃淡（濃いほど先まで進んだ）
const SEGMENT_COLORS: Record<string, string> = {
  有料化: '#104281',
  'セグメント5〜8': '#1c5cab',
  セグメント4: '#2a78d6',
  セグメント3: '#5598e7',
  'セグメント1〜2': '#86b6ef',
  ブロック: GRAY,
  対象外: LIGHT_GRAY,
}
const FUNNEL = { friends: '#86b6ef', trial: '#2a78d6', paid: '#104281' }

const pct = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 1000) / 10}%` : '—')

function Delta({ card, invert = false }: { card: Card; invert?: boolean }) {
  if (card.value === null || card.prev === null) return <span className="text-xs text-gray-400">比較なし</span>
  if (card.prev === 0) return <span className="text-xs text-gray-400">前は 0</span>
  const r = ((card.value - card.prev) / Math.abs(card.prev)) * 100
  const up = r > 0
  const good = invert ? !up : up
  const color = r === 0 ? 'text-gray-500 bg-gray-100' : good ? 'text-emerald-700 bg-emerald-50' : 'text-red-700 bg-red-50'
  return (
    <span className={`rounded px-1.5 py-0.5 text-xs font-medium tabular-nums ${color}`}>
      {r === 0 ? '±0%' : `${up ? '▲' : '▼'} ${Math.abs(Math.round(r * 10) / 10)}%`}
    </span>
  )
}

function KpiCard({ label, card, yen, unit, compare, invert }: { label: string; card: Card; yen?: boolean; unit?: string; compare: string; invert?: boolean }) {
  const fmt = (n: number | null) => (n === null ? '—' : yen ? formatYen(n) : formatNumber(n))
  return (
    <div className="h-full rounded-xl border border-gray-200 bg-white px-4 py-3">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-gray-900">
        {fmt(card.value)}
        {card.value !== null && unit && <span className="ml-1 text-sm font-normal text-gray-500">{unit}</span>}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <Delta card={card} invert={invert} />
        <span className="text-[11px] text-gray-400">
          {compare} {fmt(card.prev)}
        </span>
      </div>
    </div>
  )
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6 rounded-xl border border-gray-200 bg-white p-4 sm:p-5">
      <h2 className="text-base font-bold text-gray-900">{title}</h2>
      {note && <p className="mt-0.5 text-xs text-gray-400">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  )
}

type Column = { key: string; label: string; yen?: boolean; text?: (r: ChartPoint) => string }

function MonthTable({ rows, columns }: { rows: ChartPoint[]; columns: Column[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs text-gray-500">
            <th className="sticky left-0 bg-white px-3 py-2 text-left font-medium">月</th>
            {columns.map((c) => (
              <th key={c.key} className="whitespace-nowrap px-3 py-2 text-right font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.t} className="border-b border-gray-100">
              <td className="sticky left-0 whitespace-nowrap bg-white px-3 py-1.5 text-gray-600">{labelOf('month', r.t, true)}</td>
              {columns.map((c) => {
                const v = r[c.key]
                const s = c.text ? c.text(r) : v === null || v === undefined ? '—' : c.yen ? formatYen(Number(v)) : formatNumber(Number(v))
                return (
                  <td key={c.key} className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-gray-900">
                    {s}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function ChartOrTable({ asTable, points, series, columns, stacked, height }: { asTable: boolean; points: ChartPoint[]; series: ChartSeries[]; columns: Column[]; stacked?: boolean; height?: number }) {
  return asTable ? (
    <MonthTable rows={points} columns={columns} />
  ) : (
    // スマホでは縮めずに横にスクロールさせる（目盛りの文字が読めなくなるため）
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        <TimeSeriesChart points={points} series={series} granularity="month" stacked={stacked} height={height ?? 260} />
      </div>
    </div>
  )
}

export default function MonthlyDashboardPage() {
  const [data, setData] = useState<Monthly | null>(null)
  const [asTable, setAsTable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/furim/dashboard/monthly`, { credentials: 'include' })
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      setData((await res.json()) as Monthly)
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const months = data?.months ?? []
  const base: ChartPoint[] = months.map((m) => ({
    t: m.t,
    friendsAdded: m.friendsAdded,
    blocked: m.blocked,
    net: m.net,
    members: m.members,
    mrr: m.mrr,
    // グラフの目盛りが狭い画面で切れないように万円で描く（表は円のまま）
    mrrMan: Math.round(m.mrr / 1000) / 10,
    newPaid: m.newPaid,
    churned: m.churned,
    trialStarted: m.trialStarted,
    cohortPaid: m.cohortPaid,
  }))
  const routesAdded: ChartPoint[] = months.map((m) => ({ t: m.t, ...m.routesAdded }))
  const routesPaid: ChartPoint[] = months.map((m) => ({ t: m.t, ...m.routesPaid }))
  const segments: ChartPoint[] = months.map((m) => {
    const s = m.segments
    return {
      t: m.t,
      有料化: s['有料化'] ?? 0,
      'セグメント5〜8': s['セグメント5〜8'] ?? 0,
      セグメント4: s['セグメント4'] ?? 0,
      セグメント3: s['セグメント3'] ?? 0,
      'セグメント1〜2': (s['セグメント1'] ?? 0) + (s['セグメント2'] ?? 0),
      ブロック: s['ブロック'] ?? 0,
      対象外: s['対象外'] ?? 0,
    }
  })

  const routeSeries: ChartSeries[] = ROUTE_GROUPS.map((g) => ({ key: g, label: g, kind: 'bar', color: ROUTE_COLORS[g] }))
  const routeColumns: Column[] = ROUTE_GROUPS.map((g) => ({ key: g, label: g }))
  const segmentSeries: ChartSeries[] = SEGMENT_KEYS.map((g) => ({ key: g, label: g, kind: 'bar', color: SEGMENT_COLORS[g] }))
  const blockedSince = data?.range.blockedSince ? data.range.blockedSince.slice(0, 10).replace(/-/g, '/') : null
  const asOf = data?.range.asOf ? data.range.asOf.slice(0, 16).replace('T', ' ') : ''
  const day = data?.range.asOf ? Number(data.range.asOf.slice(8, 10)) : 0

  return (
    <div>
      <Header
        title="月次ダッシュボード"
        description={data ? `${labelOf('month', data.range.from, true)} 〜 ${labelOf('month', data.range.to, true)}（${asOf} 時点）・数字はすべて D1 から・社内と検証用の友だちは除く` : '数字はすべて D1 から'}
        action={
          <button
            type="button"
            onClick={() => setAsTable((v) => !v)}
            className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            {asTable ? 'グラフで見る' : '表で見る'}
          </button>
        }
      />

      {error && (
        <div className="mb-6 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>読み込みに失敗しました（{error}）</span>
          <button type="button" onClick={() => void load()} className="rounded border border-red-300 bg-white px-2.5 py-1 text-xs hover:bg-red-50">
            再読み込み
          </button>
        </div>
      )}

      {loading && !data ? (
        <p className="text-sm text-gray-400">読み込み中...</p>
      ) : data ? (
        <>
          <div className="mb-2 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <KpiCard label="今月の友だち追加" card={data.cards.friendsAdded} unit="人" compare={`前月 ${day} 日まで`} />
            <KpiCard label="今月の純増（追加 − ブロック）" card={data.cards.net} unit="人" compare={`前月 ${day} 日まで`} />
            <KpiCard label="月額会員（いま）" card={data.cards.members} unit="人" compare="前月末" />
            <KpiCard label="MRR（税抜・いま）" card={data.cards.mrr} yen compare="前月末" />
            <KpiCard label="今月の新規加入" card={data.cards.newPaid} unit="人" compare={`前月 ${day} 日まで`} />
            <KpiCard label="今月の解約" card={data.cards.churned} unit="人" compare={`前月 ${day} 日まで`} invert />
          </div>
          <p className="mb-6 text-[11px] text-gray-400">
            今月の途中の数字は、前月の同じ日時までと比べています。会員と MRR は前月末と比べています。
          </p>

          <Section
            title="LINE 友だち追加とブロック"
            note={`友だち追加は初めて友だちになった人（再追加は含まない）。ブロックは ${blockedSince ?? '—'} から記録があり、それより前の月は「—」`}
          >
            <ChartOrTable
              asTable={asTable}
              points={base}
              series={[
                { key: 'friendsAdded', label: '友だち追加', kind: 'bar', color: CAT[0] },
                { key: 'blocked', label: 'ブロック', kind: 'bar', color: CAT[1] },
              ]}
              columns={[
                { key: 'friendsAdded', label: '友だち追加' },
                { key: 'blocked', label: 'ブロック' },
                { key: 'net', label: '純増' },
              ]}
            />
          </Section>

          <div>
            <Section title="月額会員数（月末）" note="月末時点で Stripe のサブスクが有効（active・支払い遅れの past_due。試用中は入らない）な顧客。Stripe の画面と同じ数で、社内アカウントも入る。今月はいまの時点">
              <ChartOrTable
                asTable={asTable}
                points={base}
                series={[{ key: 'members', label: '月額会員', kind: 'line', color: CAT[0] }]}
                columns={[{ key: 'members', label: '月額会員' }]}
                height={220}
              />
            </Section>
            <Section title="MRR（税抜）" note="月末時点の会員の、サブスクごとの直近の定期請求（割引後・税抜）の合計。請求の額をそのまま使うので、初月の割引や月の途中のプラン変更の差額が入った請求はその額で入る">
              <ChartOrTable
                asTable={asTable}
                points={base}
                series={[{ key: 'mrrMan', label: 'MRR（税抜・万円）', kind: 'bar', color: CAT[0], format: (n) => `${n.toLocaleString('ja-JP')} 万円` }]}
                columns={[{ key: 'mrr', label: 'MRR（税抜）', yen: true }]}
                height={220}
              />
            </Section>
          </div>

          <Section title="新規加入と解約" note="新規加入は Stripe の顧客が初めて有効になった月（試用のあとは試用が終わった月）。解約はサブスクが終わった顧客（前後 7 日に同じ顧客の別のサブスクが有効ならプランの切り替えとして除く）">
            <ChartOrTable
              asTable={asTable}
              points={base}
              series={[
                { key: 'newPaid', label: '新規加入', kind: 'bar', color: CAT[0] },
                { key: 'churned', label: '解約', kind: 'bar', color: CAT[1] },
              ]}
              columns={[
                { key: 'newPaid', label: '新規加入' },
                { key: 'churned', label: '解約' },
                { key: 'netPaid', label: '差し引き', text: (r) => formatNumber(Number(r.newPaid) - Number(r.churned)) },
              ]}
            />
          </Section>

          <Section
            title="ファネル（友だち追加 → 試用開始 → 有料化）"
            note="友だち追加した月ごとに、いま時点でどこまで進んだか。試用開始はキーコードを発行した人（発行日時の記録が無いため追加した月で数える）。有料化は 0 円でない定期の請求があった人"
          >
            <ChartOrTable
              asTable={asTable}
              points={base}
              series={[
                { key: 'friendsAdded', label: '友だち追加', kind: 'bar', color: FUNNEL.friends },
                { key: 'trialStarted', label: '試用開始', kind: 'bar', color: FUNNEL.trial },
                { key: 'cohortPaid', label: '有料化', kind: 'bar', color: FUNNEL.paid },
              ]}
              columns={[
                { key: 'friendsAdded', label: '友だち追加' },
                { key: 'trialStarted', label: '試用開始' },
                { key: 'trialRate', label: '追加→試用', text: (r) => pct(Number(r.trialStarted), Number(r.friendsAdded)) },
                { key: 'cohortPaid', label: '有料化' },
                { key: 'paidRate', label: '試用→有料', text: (r) => pct(Number(r.cohortPaid), Number(r.trialStarted)) },
                { key: 'allRate', label: '追加→有料', text: (r) => pct(Number(r.cohortPaid), Number(r.friendsAdded)) },
              ]}
            />
            {!asTable && (
              <div className="mt-3 overflow-x-auto">
                <MonthTable
                  rows={base}
                  columns={[
                    { key: 'trialRate', label: '追加→試用', text: (r) => pct(Number(r.trialStarted), Number(r.friendsAdded)) },
                    { key: 'paidRate', label: '試用→有料', text: (r) => pct(Number(r.cohortPaid), Number(r.trialStarted)) },
                    { key: 'allRate', label: '追加→有料', text: (r) => pct(Number(r.cohortPaid), Number(r.friendsAdded)) },
                  ]}
                />
              </div>
            )}
          </Section>

          <div>
            <Section title="流入経路別の友だち追加" note="ref_code の頭（ad_・org_・ext_）で分類。紹介は紹介リンク・紹介の記録がある人。経路なしは ref_code が空の人">
              <ChartOrTable asTable={asTable} points={routesAdded} series={routeSeries} columns={routeColumns} stacked />
            </Section>
            <Section title="流入経路別の新規加入" note="その月に新規加入した人を、友だち追加したときの流入経路で分けたもの">
              <ChartOrTable asTable={asTable} points={routesPaid} series={routeSeries} columns={routeColumns} stacked />
            </Section>
          </div>

          <Section
            title="セグメント別（友だち追加した月ごとの、いまの段階）"
            note="セグメントはステップ配信と同じ判定（1 未回答・2 回答済み・3 キーコード発行済み・4 端末認証済み・5〜8 メルカリ URL 登録以降）。有料化とブロックを先に分ける"
          >
            <ChartOrTable asTable={asTable} points={segments} series={segmentSeries} columns={SEGMENT_KEYS.map((g) => ({ key: g, label: g }))} stacked />
          </Section>

          <Section title="流入経路ごとの合計（期間内）" note="経路の名前は流入経路（entry_routes）の登録名">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead>
                  <tr className="border-b border-gray-200 text-xs text-gray-500">
                    <th className="px-3 py-2 text-left font-medium">流入経路</th>
                    <th className="px-3 py-2 text-left font-medium">分類</th>
                    <th className="px-3 py-2 text-right font-medium">友だち追加</th>
                    <th className="px-3 py-2 text-right font-medium">新規加入</th>
                  </tr>
                </thead>
                <tbody>
                  {data.routeDetail.map((r) => (
                    <tr key={r.route} className="border-b border-gray-100">
                      <td className="px-3 py-1.5 text-gray-900">{r.route}</td>
                      <td className="px-3 py-1.5 text-gray-600">
                        <span className="mr-1.5 inline-block h-2 w-2 rounded-sm" style={{ backgroundColor: ROUTE_COLORS[r.group] ?? GRAY }} />
                        {r.group}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-900">{formatNumber(r.added)}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-gray-900">{formatNumber(r.paid)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </>
      ) : null}
    </div>
  )
}
