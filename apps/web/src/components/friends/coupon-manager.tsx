'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '@/lib/api'
import type { StripeCouponItem, SubscriptionDiscount, FriendCouponState } from '@/lib/api'

interface Props {
  friendId: string
  friendName: string
}

// FurimAuto fork 独自: 友だちリストの展開パネル内で Stripe クーポンを付与・削除する。
// 付与はサブスクの discounts 配列へのスタック追加なので、複数サイト併用割引と共存する
// （併用割引・プラン由来の割引は deletable=false で削除リンクが出ない）。
// 付与の 3 分後に cron が LINE 通知を送る（削除すれば通知もキャンセル）。
// cron は 5 分間隔なので実際の通知は付与の 3〜8 分後。

const DEFAULT_MESSAGE = (couponName: string) =>
  `いつもFurimAutoをご利用いただきありがとうございます😊

「${couponName}」を付与いたしました🎁

次回のお支払いに自動で適用されます。
リッチメニューの「月額会員ページ」から適用状況をご確認いただけます♪`

// クーポン一覧はページ単位で1回だけ取得するモジュールキャッシュ。
// 友だちリスト表示時に friend-list-table が prefetchCoupons() で裏読みしておき、
// 各行の展開時は同じ Promise を使い回す（行ごと・展開ごとの再取得なし）。
// Stripe 側でクーポンを作り替えた直後は TTL 切れ or リロードで反映される。
const COUPONS_TTL_MS = 5 * 60_000
let couponsCache: { at: number; promise: Promise<StripeCouponItem[]> } | null = null

export function prefetchCoupons(): Promise<StripeCouponItem[]> {
  if (couponsCache && Date.now() - couponsCache.at < COUPONS_TTL_MS) return couponsCache.promise
  const promise = api.furimCoupons.list().then((res) => {
    if (!res.success) throw new Error(res.error)
    return res.data
  })
  couponsCache = { at: Date.now(), promise }
  promise.catch(() => {
    couponsCache = null
  })
  return promise
}

function offLabel(percentOff: number | null, amountOff: number | null): string {
  if (percentOff != null) return `${percentOff}%オフ`
  if (amountOff != null) return `¥${amountOff.toLocaleString('ja-JP')}オフ`
  return ''
}

function durationLabel(duration: string | null, durationInMonths?: number | null): string {
  if (duration === 'once') return '1回のみ'
  if (duration === 'forever') return '永続'
  if (duration === 'repeating' && durationInMonths) return `${durationInMonths}ヶ月`
  return ''
}

function couponLabel(c: StripeCouponItem): string {
  const parts = [offLabel(c.percentOff, c.amountOff), durationLabel(c.duration, c.durationInMonths)].filter(Boolean).join(' / ')
  return `${c.name ?? c.id}${parts ? `（${parts}）` : ''}`
}

function discountLabel(d: SubscriptionDiscount): string {
  const parts = [offLabel(d.percentOff, d.amountOff), durationLabel(d.duration)].filter(Boolean).join(' / ')
  return `${d.name}${parts ? `（${parts}）` : ''}`
}

// send_after (JST ISO) → "HH:MM頃"。DBは+09:00付きJSTなのでそのまま切り出す
function formatSendAfter(iso: string): string {
  return `${iso.slice(11, 16)}頃`
}

export default function CouponManager({ friendId, friendName }: Props) {
  const [state, setState] = useState<FriendCouponState | null>(null)
  const [coupons, setCoupons] = useState<StripeCouponItem[] | null>(null)
  const [selectedCouponId, setSelectedCouponId] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const loadState = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const res = await api.furimCoupons.get(friendId)
      if (res.success) setState(res.data)
      else setError(res.error)
    } catch {
      setError('クーポン情報の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [friendId])

  useEffect(() => {
    loadState()
  }, [loadState])

  // 一覧はプリフェッチ済みキャッシュから取る（friend-list-table が裏読みしている）
  useEffect(() => {
    let alive = true
    prefetchCoupons()
      .then((data) => { if (alive) setCoupons(data) })
      .catch(() => { if (alive) setError('クーポン一覧の取得に失敗しました') })
    return () => { alive = false }
  }, [])

  const handleSelectCoupon = (couponId: string) => {
    setSelectedCouponId(couponId)
    const coupon = coupons?.find((c) => c.id === couponId)
    setMessage(coupon ? DEFAULT_MESSAGE(coupon.name ?? coupon.id) : '')
  }

  const handleApply = async () => {
    const coupon = coupons?.find((c) => c.id === selectedCouponId)
    if (!coupon) return
    if (!confirm(`${friendName} さんに「${coupon.name ?? coupon.id}」を付与します。よろしいですか？\n（3分後にLINE通知が送られます。間違えた場合は削除すれば通知もキャンセルされます）`)) return
    setBusy(true)
    setError('')
    try {
      const res = await api.furimCoupons.apply(friendId, selectedCouponId, message)
      if (res.success) {
        setSelectedCouponId('')
        setMessage('')
        await loadState()
      } else {
        setError(res.error)
      }
    } catch {
      setError('クーポンの付与に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = async (d: SubscriptionDiscount) => {
    if (!confirm(`${friendName} さんの「${d.name}」を削除します。よろしいですか？\n（LINE通知が未送信ならキャンセルされます）`)) return
    setBusy(true)
    setError('')
    try {
      const res = await api.furimCoupons.remove(friendId, d.couponId)
      if (res.success) await loadState()
      else setError(res.error)
    } catch {
      setError('クーポンの削除に失敗しました')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <p className="text-xs font-semibold text-gray-500 mb-2">クーポン管理（Stripe・サブスク割引スタック）</p>

      {error && <p className="text-xs text-red-600 mb-2">{error}</p>}

      {loading ? (
        <p className="text-xs text-gray-400">読み込み中...</p>
      ) : !state ? null : !state.hasSubscription ? (
        <p className="text-xs text-gray-400">アクティブなサブスクリプションがありません（有料会員のみ付与できます）</p>
      ) : (
        <div className="space-y-2">
          {state.discounts.length > 0 ? (
            <div className="space-y-1">
              {state.discounts.map((d) => (
                <div key={d.couponId} className="flex items-center gap-2 flex-wrap">
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium ${d.deletable ? 'bg-amber-100 text-amber-800' : 'bg-gray-100 text-gray-600'}`}>
                    {discountLabel(d)}
                  </span>
                  {d.deletable ? (
                    <button
                      onClick={() => handleRemove(d)}
                      disabled={busy}
                      className="text-[11px] text-red-600 hover:text-red-700 underline disabled:opacity-50"
                    >
                      削除
                    </button>
                  ) : (
                    <span className="text-[10px] text-gray-400">プラン割引（削除不可）</span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-gray-400">適用中の割引はありません</p>
          )}

          {state.pendingNotification && (
            <p className="text-[11px] text-blue-600">
              {formatSendAfter(state.pendingNotification.sendAfter)}にLINE通知予定
              （クーポンを削除すれば通知もキャンセルされます。実送信は数分ずれることがあります）
            </p>
          )}

          <div className="space-y-2 pt-1">
            <div className="flex items-center gap-2">
              <select
                className="text-sm border border-gray-300 rounded-md px-2 py-1 max-w-full focus:outline-none focus:ring-2 focus:ring-green-500"
                value={selectedCouponId}
                onChange={(e) => handleSelectCoupon(e.target.value)}
                disabled={busy}
              >
                <option value="">クーポンを選択...</option>
                {(coupons ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{couponLabel(c)}</option>
                ))}
              </select>
            </div>

            {selectedCouponId && (
              <>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={7}
                  className="w-full text-sm border border-gray-300 rounded-md px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-500"
                  placeholder="LINE通知の本文"
                />
                <div className="flex items-center gap-2">
                  <button
                    onClick={handleApply}
                    disabled={busy || !message.trim()}
                    className="px-3 py-1 text-xs font-medium rounded-md text-white disabled:opacity-50 transition-opacity"
                    style={{ backgroundColor: '#06C755' }}
                  >
                    {busy ? '処理中...' : '付与する'}
                  </button>
                  <button
                    onClick={() => { setSelectedCouponId(''); setMessage('') }}
                    disabled={busy}
                    className="px-3 py-1 text-xs font-medium rounded-md text-gray-600 bg-gray-200 hover:bg-gray-300 transition-colors"
                  >
                    キャンセル
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
