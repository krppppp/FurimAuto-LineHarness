'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Header from '@/components/layout/header'
import { getCsrfToken } from '@/lib/api'
import Segmented from '@/components/charts/segmented'
import StatCard, { formatNumber, formatYen } from '@/components/charts/stat-card'
import TimeSeriesChart, { labelOf, type ChartPoint, type ChartSeries } from '@/components/charts/time-series-chart'

/**
 * 管理画面トップ（Capsec #282 段階2 / #285）。
 *
 * 設計は .claude-company/departments/engineering/FurimAuto-LineHarness/2026-09-16-admin-top-dashboard-design.md。
 * 数字はすべて D1（GET /api/furim/dashboard）。マスタースプレッドシートには依存しない。
 * 区画ごとに ok を持ち、取得に失敗したところは 0 ではなく「—」と理由を出す。
 *
 * upstream マージではこのファイルを ours 固定にする（docs/furimauto/FORK_OVERLAY.md に登録済み）。
 */

type Granularity = 'day' | 'month' | 'year'
type Period = '3m' | '6m' | '1y' | 'all'

const GRANULARITIES: ReadonlyArray<{ value: Granularity; label: string }> = [
  { value: 'day', label: '日' },
  { value: 'month', label: '月' },
  { value: 'year', label: '年' },
]
const PERIODS: ReadonlyArray<{ value: Period; label: string }> = [
  { value: '3m', label: '3ヶ月' },
  { value: '6m', label: '6ヶ月' },
  { value: '1y', label: '1年' },
  { value: 'all', label: '全期間' },
]

type Failed = { ok: false; error: string }
type FriendsSection = { ok: true; series: Array<{ t: string; total: number; fromAds: number; byRoute: Record<string, number> }>; following: number }
type RevenueSection = {
  ok: true
  members: number
  series: Array<{ t: string; invoices: number; payers: number; revenueExclTax: number; revenueInclTax: number; newPaidInvoices: number; converted: number }>
}
type ChurnSection = { ok: true; series: Array<{ t: string; churned: number }>; blocked: number }
type AdSpendSection = { ok: true; series: Array<{ t: string; cost: number; clicks: number; impressions: number }>; lastImportedAt: string | null }
type TrialSection = { ok: true; active: number; endingSoon: number }
type AutomationDay = { t: string; runs: number; people: number; unidentified: number }
type AutomationSection = {
  ok: true
  series: AutomationDay[]
  target: AutomationDay & { medianRuns: number | null; medianPeople: number | null; byService: Array<{ service: string; runs: number; people: number }> }
  today: { t: string; asOf: string; runs: number; people: number; sameTimeAvg: number | null }
  sheetSync: { lastRunAt: string | null; note: string | null }
}
type Anomaly = {
  kind: string
  label: string
  count: number
  since: string | null
  href: string
  severity: 'red' | 'yellow'
  acked: { at: string; by: string; note: string | null } | null
  isNew: boolean
  details?: Array<{ label: string; sub: string; href: string }>
  note?: string
}
type AnomaliesSection = { ok: true; items: Anomaly[] }

type Dashboard = {
  success: boolean
  range: { from: string; to: string; granularity: Granularity; period: Period }
  sections: {
    friends: FriendsSection | Failed
    revenue: RevenueSection | Failed
    churn: ChurnSection | Failed
    adSpend: AdSpendSection | Failed
    trial: TrialSection | Failed
    automation?: AutomationSection | Failed
    anomalies: AnomaliesSection | Failed
  }
}

const COLORS = { automation: '#0d9488', people: '#4f46e5', friends: '#06C755', ads: '#2563eb', revenue: '#7c3aed', converted: '#f59e0b', churn: '#dc2626', cost: '#0ea5e9', cpa: '#ea580c' }

function SectionShell({
  title,
  note,
  href,
  linkLabel,
  failed,
  children,
}: {
  title: string
  note?: string
  href?: string
  linkLabel?: string
  failed?: string
  children: React.ReactNode
}) {
  return (
    <section className="mb-6 rounded-xl border border-gray-200 bg-white p-5">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-gray-900">{title}</h2>
          {note && <p className="mt-0.5 text-xs text-gray-400">{note}</p>}
        </div>
        {href && (
          <Link href={href} className="shrink-0 text-xs text-gray-500 hover:text-gray-800">
            {linkLabel ?? '詳しく見る'} →
          </Link>
        )}
      </div>
      {failed ? <p className="py-6 text-center text-sm text-red-600">取得に失敗しました（{failed}）</p> : children}
    </section>
  )
}

function DataTable({ rows, columns, granularity }: { rows: ChartPoint[]; columns: Array<{ key: string; label: string; yen?: boolean }>; granularity: Granularity }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-xs text-gray-500">
            <th className="px-3 py-2 text-left font-medium">期間</th>
            {columns.map((c) => (
              <th key={c.key} className="px-3 py-2 text-right font-medium">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...rows].reverse().map((r) => (
            <tr key={r.t} className="border-b border-gray-100">
              <td className="px-3 py-1.5 text-gray-600">{labelOf(granularity, r.t, true)}</td>
              {columns.map((c) => (
                <td key={c.key} className="px-3 py-1.5 text-right tabular-nums text-gray-900">
                  {c.yen ? formatYen(Number(r[c.key] ?? 0)) : formatNumber(Number(r[c.key] ?? 0))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

async function postAnomaly(path: 'ack' | 'unack', body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/furim/dashboard/anomalies/${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`API error: ${res.status}`)
}

function AnomalyRow({ a, onChanged }: { a: Anomaly; onChanged: () => void }) {
  const [busy, setBusy] = useState(false)
  const red = a.severity === 'red'
  const act = async (path: 'ack' | 'unack') => {
    setBusy(true)
    try {
      await postAnomaly(path, path === 'ack' ? { kind: a.kind, count: a.count, since: a.since } : { kind: a.kind })
      onChanged()
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className={`flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 text-sm ${a.acked ? 'opacity-60' : ''}`}>
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${red ? 'bg-red-500' : 'bg-amber-400'}`} />
      <Link href={a.href} className={`font-medium underline-offset-2 hover:underline ${red ? 'text-red-800' : 'text-amber-800'}`}>
        {a.label}
      </Link>
      {a.count > 0 && <span className="tabular-nums text-gray-600">{formatNumber(a.count)} 件</span>}
      {a.since && <span className="text-xs text-gray-500">初回 {a.since.slice(0, 16).replace('T', ' ')}</span>}
      {a.acked ? (
        <span className="ml-auto flex items-center gap-2 text-xs text-gray-500">
          確認済み {a.acked.by}・{a.acked.at.slice(0, 16).replace('T', ' ')}
          <button type="button" disabled={busy} onClick={() => void act('unack')} className="rounded border border-gray-300 bg-white px-2 py-0.5 hover:bg-gray-50 disabled:opacity-50">
            戻す
          </button>
        </span>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('ack')}
          className="ml-auto rounded border border-gray-300 bg-white px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          確認済みにする
        </button>
      )}
      {(a.details?.length || a.note) && (
        <div className="basis-full pl-5">
          {a.details && a.details.length > 0 && (
            <ul className="mt-1 space-y-0.5">
              {a.details.map((d) => (
                <li key={d.href} className="text-xs">
                  <Link href={d.href} className="font-medium text-gray-800 underline-offset-2 hover:underline">
                    {d.label}
                  </Link>
                  <span className="ml-2 text-gray-500">{d.sub}</span>
                </li>
              ))}
            </ul>
          )}
          {a.note && <p className="mt-1 text-[11px] text-gray-400">{a.note}</p>}
        </div>
      )}
    </li>
  )
}

function AnomalySection({ section, onChanged }: { section: AnomaliesSection | Failed; onChanged: () => void }) {
  const [showAcked, setShowAcked] = useState(false)
  const [openOld, setOpenOld] = useState(false)

  if (!section.ok) {
    return (
      <section className="mb-6 rounded-xl border border-red-200 bg-red-50 p-5">
        <h2 className="mb-2 text-base font-bold text-red-700">異常</h2>
        <p className="text-sm text-red-600">取得に失敗しました（{section.error}）</p>
      </section>
    )
  }

  const visible = section.items.filter((a) => showAcked || !a.acked)
  if (visible.length === 0 && section.items.length === 0) return null

  // 今日のできごと（直近 24 時間に初めて出たもの）と、続いているものを分ける
  const today = visible.filter((a) => a.isNew)
  const continuing = visible.filter((a) => !a.isNew)
  const ackedCount = section.items.filter((a) => a.acked).length

  return (
    <section className="mb-6 rounded-xl border border-red-200 bg-red-50 p-5">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-red-700">異常</h2>
        {ackedCount > 0 && (
          <button type="button" onClick={() => setShowAcked((v) => !v)} className="text-xs text-gray-500 hover:text-gray-800">
            {showAcked ? '確認済みを隠す' : `確認済みも表示（${ackedCount}）`}
          </button>
        )}
      </div>

      {today.length > 0 && (
        <>
          <p className="text-xs font-medium text-red-600">今日のできごと</p>
          <ul className="mb-2 divide-y divide-red-100">
            {today.map((a) => (
              <AnomalyRow key={a.kind} a={a} onChanged={onChanged} />
            ))}
          </ul>
        </>
      )}

      {continuing.length > 0 && (
        <>
          <button type="button" onClick={() => setOpenOld((v) => !v)} className="text-xs font-medium text-gray-600 hover:text-gray-900">
            {openOld ? '▾' : '▸'} 続いているもの（{continuing.length}）
          </button>
          {openOld && (
            <ul className="divide-y divide-red-100">
              {continuing.map((a) => (
                <AnomalyRow key={a.kind} a={a} onChanged={onChanged} />
              ))}
            </ul>
          )}
        </>
      )}

      {today.length === 0 && continuing.length === 0 && (
        <p className="text-sm text-gray-500">未確認の異常はありません</p>
      )}
    </section>
  )
}

export default function DashboardPage() {
  const [granularity, setGranularity] = useState<Granularity>('month')
  const [period, setPeriod] = useState<Period>('1y')
  const [asTable, setAsTable] = useState(false)
  const [data, setData] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  // 選んだ粒度と期間は URL に持たせる（再読み込みとリンク共有で同じ絵が出る）
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const g = q.get('g')
    const p = q.get('p')
    if (g === 'day' || g === 'month' || g === 'year') setGranularity(g)
    if (p === '3m' || p === '6m' || p === '1y' || p === 'all') setPeriod(p)
  }, [])

  const load = useCallback(async (g: Granularity, p: Period) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/furim/dashboard?granularity=${g}&period=${p}`, { credentials: 'include' })
      if (!res.ok) throw new Error(`API error: ${res.status}`)
      setData((await res.json()) as Dashboard)
    } catch (e) {
      setError(e instanceof Error ? e.message : '読み込みに失敗しました')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    q.set('g', granularity)
    q.set('p', period)
    window.history.replaceState(null, '', `?${q.toString()}`)
    void load(granularity, period)
  }, [granularity, period, load])

  const s = data?.sections
  const friends = s?.friends
  const revenue = s?.revenue
  const churn = s?.churn
  const adSpend = s?.adSpend
  const trial = s?.trial
  const automation = s?.automation
  const anomalies = s?.anomalies

  const failOf = (sec: { ok: boolean; error?: string } | undefined) => (sec && !sec.ok ? (sec.error ?? '不明なエラー') : undefined)

  // 広告費の区画は、費用と「広告経由の友だち追加」から実 CPA を出す
  const adPoints: ChartPoint[] =
    adSpend?.ok && friends?.ok
      ? adSpend.series.map((a) => {
          const f = friends.series.find((x) => x.t === a.t)
          const adFriends = f?.fromAds ?? 0
          return { t: a.t, cost: a.cost, cpa: adFriends > 0 ? Math.round(a.cost / adFriends) : 0, adFriends }
        })
      : []

  const friendSeries: ChartSeries[] = [
    { key: 'total', label: '友だち追加', kind: 'bar', color: COLORS.friends },
    { key: 'fromAds', label: 'うち広告経由', kind: 'line', color: COLORS.ads },
  ]
  const revenueSeries: ChartSeries[] = [
    { key: 'revenueExclTax', label: '課金実績（税抜）', kind: 'bar', color: COLORS.revenue, format: formatYen },
    { key: 'converted', label: '新規の有料転換', kind: 'line', color: COLORS.converted, right: true },
  ]
  const adSeries: ChartSeries[] = [
    { key: 'cost', label: '広告費', kind: 'bar', color: COLORS.cost, format: formatYen },
    { key: 'cpa', label: '実 CPA（友だち 1 人あたり）', kind: 'line', color: COLORS.cpa, right: true, format: formatYen },
  ]
  const churnSeries: ChartSeries[] = [{ key: 'churned', label: '解約', kind: 'bar', color: COLORS.churn }]
  const automationSeries: ChartSeries[] = [
    { key: 'runs', label: '件数', kind: 'bar', color: COLORS.automation },
    { key: 'people', label: '人数', kind: 'line', color: COLORS.people, right: true },
  ]
  const ratioText = (v: number, m: number | null) => (m && m > 0 ? `${Math.round((v / m) * 100)}%` : '—')

  return (
    <div>
      <Header
        title="ダッシュボード"
        description={data ? `${data.range.from} 〜 ${data.range.to}・数字はすべて D1 から` : '数字はすべて D1 から'}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Segmented options={GRANULARITIES} value={granularity} onChange={setGranularity} ariaLabel="粒度" />
            <Segmented options={PERIODS} value={period} onChange={setPeriod} ariaLabel="期間" />
            <button
              type="button"
              onClick={() => setAsTable((v) => !v)}
              className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
            >
              {asTable ? 'グラフ表示' : '表で見る'}
            </button>
          </div>
        }
      />

      {error && (
        <div className="mb-6 flex items-center justify-between rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span>読み込みに失敗しました（{error}）</span>
          <button type="button" onClick={() => void load(granularity, period)} className="rounded border border-red-300 bg-white px-2.5 py-1 text-xs hover:bg-red-50">
            再読み込み
          </button>
        </div>
      )}

      {loading && !data ? (
        <p className="text-sm text-gray-400">読み込み中...</p>
      ) : (
        <>
          {/* 異常: あるときだけ最上段に出す。無いときは区画ごと出さない（緑の帯は出さない） */}
          {anomalies && <AnomalySection section={anomalies} onChanged={() => void load(granularity, period)} />}

          <SectionShell title="友だち追加と流入別" href="/lp-analytics" linkLabel="LP 分析" failed={failOf(friends)}>
            {friends?.ok && (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="期間内の友だち追加" value={friends.series.reduce((a, b) => a + b.total, 0)} unit="人" />
                  <StatCard label="うち広告経由" value={friends.series.reduce((a, b) => a + b.fromAds, 0)} unit="人" />
                  <StatCard label="いま友だち（現在値）" value={friends.following} unit="人" href="/friends" />
                  <StatCard label="流入経路の数" value={new Set(friends.series.flatMap((x) => Object.keys(x.byRoute))).size} unit="種" href="/inflow-links" />
                </div>
                {asTable ? (
                  <DataTable rows={friends.series as unknown as ChartPoint[]} columns={[{ key: 'total', label: '友だち追加' }, { key: 'fromAds', label: 'うち広告経由' }]} granularity={granularity} />
                ) : (
                  <TimeSeriesChart points={friends.series as unknown as ChartPoint[]} series={friendSeries} granularity={granularity} />
                )}
                <div className="mt-3 flex flex-wrap gap-2">
                  {Object.entries(
                    friends.series.reduce<Record<string, number>>((acc, p) => {
                      for (const [k, v] of Object.entries(p.byRoute)) acc[k] = (acc[k] ?? 0) + v
                      return acc
                    }, {}),
                  )
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 8)
                    .map(([name, n]) => (
                      <span key={name} className="rounded-full bg-gray-100 px-2.5 py-1 text-xs text-gray-600">
                        {name} <span className="font-medium tabular-nums text-gray-900">{formatNumber(n)}</span>
                      </span>
                    ))}
                </div>
              </>
            )}
          </SectionShell>

          {/* 自動化の日別件数と人数（Capsec #296）。粒度・期間の切り替えとは別に、直近 14 日の確定分だけを出す */}
          <SectionShell
            title="自動化の日別件数と人数"
            note={
              automation?.ok
                ? `直近 14 日の確定分（${labelOf('day', automation.target.t, true)} まで）。件数は実行ログの行数、人数は LINE ID の数。社内・検証用は除く。シート取り込みの最終 ${automation.sheetSync.lastRunAt ? automation.sheetSync.lastRunAt.slice(0, 16).replace('T', ' ') : '記録なし'}`
                : undefined
            }
            href="/data/table?name=furim_execution_logs"
            linkLabel="実行ログ"
            failed={failOf(automation)}
          >
            {automation?.ok && (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard
                    label={`${labelOf('day', automation.target.t)} の件数`}
                    value={automation.target.runs}
                    unit="件"
                    hint={`直近 7 日の中央値 ${automation.target.medianRuns ?? '—'} 件の ${ratioText(automation.target.runs, automation.target.medianRuns)}`}
                  />
                  <StatCard
                    label={`${labelOf('day', automation.target.t)} の人数`}
                    value={automation.target.people}
                    unit="人"
                    hint={`直近 7 日の中央値 ${automation.target.medianPeople ?? '—'} 人の ${ratioText(automation.target.people, automation.target.medianPeople)}`}
                  />
                  <StatCard label="人を特定できない" value={automation.target.unidentified} unit="件" hint="LINE ID の無い行。件数にだけ入れている" />
                  <StatCard
                    label={`今日 ${automation.today.asOf} まで（参考）`}
                    value={automation.today.runs}
                    unit="件"
                    hint={`直近 7 日の同じ時刻まで 平均 ${automation.today.sameTimeAvg ?? '—'} 件・${automation.today.people} 人。シート分は最大 6 時間遅れて入るので判定には使わない`}
                  />
                </div>
                {asTable ? (
                  <DataTable
                    rows={automation.series as unknown as ChartPoint[]}
                    columns={[{ key: 'runs', label: '件数' }, { key: 'people', label: '人数' }, { key: 'unidentified', label: '人を特定できない' }]}
                    granularity="day"
                  />
                ) : (
                  <TimeSeriesChart points={automation.series as unknown as ChartPoint[]} series={automationSeries} granularity="day" height={240} />
                )}
                {automation.target.byService.length > 0 && (
                  <p className="mt-3 text-xs text-gray-500">
                    {labelOf('day', automation.target.t)} の販路別:{' '}
                    {automation.target.byService.map((b) => `${b.service} ${formatNumber(b.runs)} 件・${formatNumber(b.people)} 人`).join(' / ')}
                  </p>
                )}
              </>
            )}
          </SectionShell>

          <SectionShell
            title="月次課金実績"
            note="実際に入った課金の合計。定期収益の現在値（MRR）とは別物で、日割りや単発も含む"
            href="/conversions"
            linkLabel="コンバージョン"
            failed={failOf(revenue)}
          >
            {revenue?.ok && (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="いま月額会員（現在値）" value={revenue.members} unit="人" href="/data/table?name=furim_customers" />
                  <StatCard label="期間内の課金実績（税抜）" value={revenue.series.reduce((a, b) => a + b.revenueExclTax, 0)} unit="円" />
                  <StatCard label="期間内の有料転換" value={revenue.series.reduce((a, b) => a + b.converted, 0)} unit="人" hint="初めて課金が成立した人。1 人 1 回" />
                  <StatCard label="期間内の請求件数" value={revenue.series.reduce((a, b) => a + b.invoices, 0)} unit="件" href="/data/table?name=furim_payments" />
                </div>
                {asTable ? (
                  <DataTable
                    rows={revenue.series as unknown as ChartPoint[]}
                    columns={[
                      { key: 'revenueExclTax', label: '課金実績（税抜）', yen: true },
                      { key: 'revenueInclTax', label: '税込', yen: true },
                      { key: 'payers', label: '支払った人数' },
                      { key: 'converted', label: '有料転換' },
                    ]}
                    granularity={granularity}
                  />
                ) : (
                  <TimeSeriesChart points={revenue.series as unknown as ChartPoint[]} series={revenueSeries} granularity={granularity} />
                )}
              </>
            )}
          </SectionShell>

          <SectionShell
            title="広告費と実 CPA"
            note={adSpend?.ok ? `最終取り込み ${adSpend.lastImportedAt ? adSpend.lastImportedAt.slice(0, 16).replace('T', ' ') : 'なし'}・実 CPA は広告費 ÷ 広告経由の友だち追加` : undefined}
            href="/data/table?name=furim_ad_spend"
            linkLabel="広告費の明細"
            failed={failOf(adSpend) ?? failOf(friends)}
          >
            {adSpend?.ok && friends?.ok && (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="期間内の広告費" value={adSpend.series.reduce((a, b) => a + b.cost, 0)} unit="円" failed={adSpend.series.length === 0} hint={adSpend.series.length === 0 ? 'まだ取り込まれていません' : undefined} />
                  <StatCard label="広告経由の友だち" value={friends.series.reduce((a, b) => a + b.fromAds, 0)} unit="人" />
                  <StatCard
                    label="実 CPA"
                    value={(() => {
                      const cost = adSpend.series.reduce((a, b) => a + b.cost, 0)
                      const n = friends.series.reduce((a, b) => a + b.fromAds, 0)
                      return n > 0 ? Math.round(cost / n) : null
                    })()}
                    unit="円"
                    failed={adSpend.series.length === 0}
                  />
                  <StatCard label="クリック" value={adSpend.series.reduce((a, b) => a + b.clicks, 0)} unit="回" failed={adSpend.series.length === 0} />
                </div>
                {asTable ? (
                  <DataTable rows={adPoints} columns={[{ key: 'cost', label: '広告費', yen: true }, { key: 'adFriends', label: '広告経由の友だち' }, { key: 'cpa', label: '実 CPA', yen: true }]} granularity={granularity} />
                ) : (
                  <TimeSeriesChart points={adPoints} series={adSeries} granularity={granularity} />
                )}
              </>
            )}
          </SectionShell>

          <SectionShell title="解約" href="/data/table?name=furim_cancellations" linkLabel="解約履歴" failed={failOf(churn)}>
            {churn?.ok && (
              <>
                <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="期間内の解約" value={churn.series.reduce((a, b) => a + b.churned, 0)} unit="件" />
                  <StatCard
                    label="期間内の解約率"
                    value={(() => {
                      const c = churn.series.reduce((a, b) => a + b.churned, 0)
                      const payers = revenue?.ok ? revenue.series.reduce((a, b) => a + b.payers, 0) : 0
                      return payers > 0 ? Math.round((c / payers) * 1000) / 10 : null
                    })()}
                    unit="%"
                    hint="解約数 ÷ その期間に支払いがあった人数"
                    failed={!revenue?.ok}
                  />
                  <StatCard label="ブロック（現在値）" value={churn.blocked} unit="人" hint="離脱時刻の記録が無いため現在値のみ" />
                </div>
                {asTable ? (
                  <DataTable rows={churn.series as unknown as ChartPoint[]} columns={[{ key: 'churned', label: '解約' }]} granularity={granularity} />
                ) : (
                  <TimeSeriesChart points={churn.series as unknown as ChartPoint[]} series={churnSeries} granularity={granularity} height={220} />
                )}
              </>
            )}
          </SectionShell>

          <SectionShell title="試用中" href="/data/table?name=furim_customers" linkLabel="顧客マスター" failed={failOf(trial)}>
            {trial?.ok && (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <StatCard label="いま試用中" value={trial.active} unit="人" />
                <StatCard label="3 日以内に終わる" value={trial.endingSoon} unit="人" />
                <StatCard label="スコアリング" value={null} hint="ルールの確認へ" href="/scoring" failed />
                <StatCard label="システムの健康状態" value={null} hint="ヘルス画面へ" href="/health" failed />
              </div>
            )}
          </SectionShell>
        </>
      )}
    </div>
  )
}
