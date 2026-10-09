'use client'

import { useCallback, useEffect, useState } from 'react'
import Header from '@/components/layout/header'
import { formatNumber, formatYen } from '@/components/charts/stat-card'
import TimeSeriesChart, { labelOf, type ChartPoint, type ChartSeries } from '@/components/charts/time-series-chart'
import DateRangePicker, { jstToday, rangeOf, selectionFromSearch, selectionToSearch, slash, type RangeSelection } from '@/components/furim/date-range-picker'

/**
 * 月次ダッシュボード（TB-1189）。選んだ期間を日・週・月ごとに出す（GET /api/furim/dashboard/monthly・期間の選択は TB-1265）。月額会員・新規加入・解約は Stripe、ほかは D1（TB-1192）。
 * 定義は apps/worker/src/furim/monthly-dashboard.ts。画面の注記と合わせて直す。
 */

const ROUTE_GROUPS = ['広告', '運用（SEO・SNS）', '拡張機能', '紹介', 'その他', '経路なし'] as const
const SEGMENT_KEYS = ['有料化', 'セグメント5〜8', 'セグメント4', 'セグメント3', 'セグメント1〜2', 'ブロック', '対象外'] as const

type Card = { value: number | null; prev: number | null }
type Granularity = 'day' | 'week' | 'month'
type Bucket = {
  t: string
  start: string
  end: string
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
  range: {
    start: string
    end: string
    all: boolean
    granularity: Granularity
    prevStart: string | null
    prevEnd: string | null
    asOf: string
    dataStart: string
    blockedSince: string | null
    blockedBeforeRecording?: { at: string; count: number }
  }
  buckets: Bucket[]
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
const UNIT: Record<Granularity, string> = { day: '日', week: '週', month: '月' }

/** 表の行の見出し。週と、範囲で切れた月は日付で出す */
function bucketLabel(g: Granularity, r: ChartPoint) {
  const start = String(r.start)
  const end = String(r.end)
  if (g === 'day') return labelOf('day', start, true)
  if (g === 'week') return `${slash(start)}〜${Number(end.slice(5, 7))}/${Number(end.slice(8, 10))}`
  const lastDay = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 0)).getUTCDate()
  const whole = start.endsWith('-01') && Number(end.slice(8, 10)) === lastDay
  return whole ? labelOf('month', String(r.t), true) : `${labelOf('month', String(r.t), true)}（${Number(start.slice(8, 10))}〜${Number(end.slice(8, 10))}日）`
}

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
        {card.prev !== null && (
          <span className="text-[11px] text-gray-400">
            {compare} {fmt(card.prev)}
          </span>
        )}
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

function BucketTable({ rows, columns, granularity }: { rows: ChartPoint[]; columns: Column[]; granularity: Granularity }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs text-gray-500">
            <th className="sticky left-0 bg-white px-3 py-2 text-left font-medium">{UNIT[granularity]}</th>
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
              <td className="sticky left-0 whitespace-nowrap bg-white px-3 py-1.5 text-gray-600">{bucketLabel(granularity, r)}</td>
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

function ChartOrTable({
  asTable,
  granularity,
  points,
  series,
  columns,
  stacked,
  height,
}: {
  asTable: boolean
  granularity: Granularity
  points: ChartPoint[]
  series: ChartSeries[]
  columns: Column[]
  stacked?: boolean
  height?: number
}) {
  return asTable ? (
    <BucketTable rows={points} columns={columns} granularity={granularity} />
  ) : (
    // スマホでは縮めずに横にスクロールさせる（目盛りの文字が読めなくなるため）
    <div className="overflow-x-auto">
      <div className="min-w-[640px]">
        {/* 週は始まりの日を目盛りにする */}
        <TimeSeriesChart points={points} series={series} granularity={granularity === 'month' ? 'month' : 'day'} stacked={stacked} height={height ?? 260} />
      </div>
    </div>
  )
}

export default function MonthlyDashboardPage() {
  const [data, setData] = useState<Monthly | null>(null)
  const [asTable, setAsTable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [sel, setSel] = useState<RangeSelection | null>(null)

  // 選んだ範囲は URL に残す（再読み込み・共有しても同じ範囲で開く）。初期値は今年（現在まで）
  useEffect(() => {
    setSel(selectionFromSearch(window.location.search, jstToday()))
  }, [])

  const load = useCallback(async (s: RangeSelection) => {
    setLoading(true)
    setError('')
    try {
      const r = rangeOf(s, jstToday())
      const q = new URLSearchParams({ start: r.start, end: r.end })
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/furim/dashboard/monthly?${q.toString()}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      setData((await res.json()) as Monthly)
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!sel) return
    window.history.replaceState(null, '', selectionToSearch(sel, window.location.search))
    void load(sel)
  }, [sel, load])

  const months = data?.buckets ?? []
  const g: Granularity = data?.range.granularity ?? 'month'
  const span = (m: Bucket) => ({ t: m.t, start: m.start, end: m.end })
  const base: ChartPoint[] = months.map((m) => ({
    ...span(m),
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
  const routesAdded: ChartPoint[] = months.map((m) => ({ ...span(m), ...m.routesAdded }))
  const routesPaid: ChartPoint[] = months.map((m) => ({ ...span(m), ...m.routesPaid }))
  const segments: ChartPoint[] = months.map((m) => {
    const s = m.segments
    return {
      ...span(m),
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
  const backlog = data?.range.blockedBeforeRecording
  const backlogNote = backlog
    ? `2026/6 のブロック数は載せ替え前の累計（記録が始まる前にブロックしていた ${formatNumber(backlog.count)} 人）をまとめて ${backlog.at.slice(5, 10).replace('-', '/')} に計上。`
    : ''
  const asOf = data?.range.asOf ? data.range.asOf.slice(0, 16).replace('T', ' ') : ''
  const rg = data?.range
  const endsToday = !!rg && rg.end === rg.asOf.slice(0, 10)
  // カードの比較先は短く出す（今年なら年を省く）。同じ時刻までの断りは下の注記に書く
  const short = (d: string) => (d.slice(0, 4) === rg?.asOf.slice(0, 4) ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : slash(d))
  const prevSpan = rg?.prevStart && rg.prevEnd ? (rg.prevStart === rg.prevEnd ? short(rg.prevStart) : `${short(rg.prevStart)}〜${short(rg.prevEnd)}`) : ''
  const prevLabel = prevSpan ? `前の期間（${prevSpan}）` : '前の期間'
  const prevEndLabel = rg?.prevEnd ? `前の期間末（${short(rg.prevEnd)}）` : '前の期間末'
  const stockLabel = endsToday ? 'いま' : '期間末'
  const unit = UNIT[g]

  return (
    <div>
      <Header
        title="月次ダッシュボード"
        description={data ? `${slash(data.range.start)} 〜 ${slash(data.range.end)}（${asOf} 時点・${unit}ごと）・月額会員・新規加入・解約は Stripe、ほかは D1 から（友だちの数字は社内と検証用を除く）` : '月額会員・新規加入・解約は Stripe、ほかは D1 から'}
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

      <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-1">
        {sel && <DateRangePicker value={sel} dataStart={data?.range.dataStart ?? null} onChange={setSel} />}
        {loading && data && <span className="text-xs text-gray-400">読み込み中...</span>}
      </div>

      {error && (
        <div className="mb-6 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>読み込みに失敗しました（{error}）</span>
          <button type="button" onClick={() => sel && void load(sel)} className="rounded border border-red-300 bg-white px-2.5 py-1 text-xs hover:bg-red-50">
            再読み込み
          </button>
        </div>
      )}

      {loading && !data ? (
        <p className="text-sm text-gray-400">読み込み中...</p>
      ) : data ? (
        <>
          <div className="mb-2 grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
            <KpiCard label="友だち追加（期間内）" card={data.cards.friendsAdded} unit="人" compare={prevLabel} />
            <KpiCard label="純増（追加 − ブロック）" card={data.cards.net} unit="人" compare={prevLabel} />
            <KpiCard label={`月額会員（${stockLabel}）`} card={data.cards.members} unit="人" compare={prevEndLabel} />
            <KpiCard label={`MRR（税抜・${stockLabel}）`} card={data.cards.mrr} yen compare={prevEndLabel} />
            <KpiCard label="新規加入（期間内）" card={data.cards.newPaid} unit="人" compare={prevLabel} />
            <KpiCard label="解約（期間内）" card={data.cards.churned} unit="人" compare={prevLabel} invert />
          </div>
          <p className="mb-6 text-[11px] text-gray-400">
            {data.range.all
              ? '全期間はデータのある最初の日（友だち・Stripe の古い方）から今日まで。前の期間が無いので比べていません。'
              : `期間内の合計と期間末の値を、ひとつ前の同じ長さの期間と比べています${endsToday ? '（今日を含むときは、前の期間も同じ時刻まで）' : ''}。`}
          </p>

          <Section
            title="LINE 友だち追加とブロック"
            note={`友だち追加は初めて友だちになった人（再追加は含まない）。ブロックは ${blockedSince ?? '—'} から記録がある。${backlogNote}それより前の${unit}は「—」`}
          >
            <ChartOrTable
              asTable={asTable}
              granularity={g}
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
            <Section title={`月額会員数（${unit}末）`} note={`${unit}末時点で Stripe のサブスクが有効（active・支払い遅れの past_due。試用中は入らない）な顧客。Stripe の画面と同じ数で、社内アカウントも入る。今日を含む${unit}はいまの時点`}>
              <ChartOrTable
                asTable={asTable}
                granularity={g}
                points={base}
                series={[{ key: 'members', label: '月額会員', kind: 'line', color: CAT[0] }]}
                columns={[{ key: 'members', label: '月額会員' }]}
                height={220}
              />
            </Section>
            <Section title="MRR（税抜）" note={`${unit}末時点の会員の、サブスクごとの直近の定期請求（割引後・税抜）の合計。請求の額をそのまま使うので、初月の割引や月の途中のプラン変更の差額が入った請求はその額で入る`}>
              <ChartOrTable
                asTable={asTable}
                granularity={g}
                points={base}
                series={[{ key: 'mrrMan', label: 'MRR（税抜・万円）', kind: 'bar', color: CAT[0], format: (n) => `${n.toLocaleString('ja-JP')} 万円` }]}
                columns={[{ key: 'mrr', label: 'MRR（税抜）', yen: true }]}
                height={220}
              />
            </Section>
          </div>

          <Section title="新規加入と解約" note={`新規加入は Stripe の顧客が初めて有効になった${unit}（試用のあとは試用が終わった${unit}）。解約はサブスクが終わった顧客（前後 7 日に同じ顧客の別のサブスクが有効ならプランの切り替えとして除く）`}>
            <ChartOrTable
              asTable={asTable}
              granularity={g}
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
            note={`友だち追加した${unit}ごとに、いま時点でどこまで進んだか。試用開始はキーコードを発行した人（発行日時の記録が無いため追加した${unit}で数える）。有料化は 0 円でない定期の請求があった人`}
          >
            <ChartOrTable
              asTable={asTable}
              granularity={g}
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
                <BucketTable
                  granularity={g}
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
              <ChartOrTable asTable={asTable} granularity={g} points={routesAdded} series={routeSeries} columns={routeColumns} stacked />
            </Section>
            <Section title="流入経路別の新規加入" note={`その${unit}に新規加入した人を、友だち追加したときの流入経路で分けたもの`}>
              <ChartOrTable asTable={asTable} granularity={g} points={routesPaid} series={routeSeries} columns={routeColumns} stacked />
            </Section>
          </div>

          <Section
            title={`セグメント別（友だち追加した${unit}ごとの、いまの段階）`}
            note="セグメントはステップ配信と同じ判定（1 未回答・2 回答済み・3 キーコード発行済み・4 端末認証済み・5〜8 メルカリ URL 登録以降）。有料化とブロックを先に分ける"
          >
            <ChartOrTable asTable={asTable} granularity={g} points={segments} series={segmentSeries} columns={SEGMENT_KEYS.map((g) => ({ key: g, label: g }))} stacked />
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
