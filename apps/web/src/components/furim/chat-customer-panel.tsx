'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { Tag } from '@line-crm/shared'
import { api, fetchApi } from '@/lib/api'
import { toDisplayDateTime } from '@/app/data/datetime'
import type { AdminTableMeta } from '@/app/data/types'
import { readRow, tableHref, type Row } from '@/components/data/admin-client'
import FeaturePanel from '@/components/data/feature-panel'
import RelatedPanel from '@/components/data/related-panel'
import TagEditor from '@/components/friends/tag-editor'
import CouponManager from '@/components/friends/coupon-manager'
import CustomerFields from './customer-fields'

/**
 * 個別チャットの顧客パネル（Capsec #308・2026-09-17 くろさん OK）。
 * 会話を開いたまま、その人の顧客データの確認と編集・機能フラグ・タグ・クーポン・変更履歴まで、この 1 枚で終わらせる。
 * 部品は友だち管理（タグ・クーポン）と顧客DB の行ドロワー（機能フラグ・関連データ・編集の決まり）と共用する。
 *
 * 並び: 本人 → 要点 → タグ → クーポン → 個別メモ → 開閉（機能フラグ・顧客データの全項目・関連データ・リッチメニューと友だち情報）→ 変更履歴 5 件
 */

interface FriendDetail {
  id: string
  lineUserId: string
  displayName: string | null
  pictureUrl: string | null
  isFollowing: boolean
  metadata: Record<string, unknown>
  createdAt: string
  tags: Tag[]
}

interface ChatStatusInfo {
  status: 'unread' | 'in_progress' | 'resolved' | null
  notes: string | null
}

type PersonAuditItem = {
  id: string
  staff_name: string
  column_name: string
  old_value: string | null
  new_value: string | null
  created_at: string
  label: string
}

type RichMenuState = { kind: 'loading' } | { kind: 'error' } | { kind: 'data'; id: string | null; name: string | null; isDefault: boolean }

interface Props {
  friendId: string
  chatStatus?: ChatStatusInfo
  /** 重ねて出すとき（1280px 未満）の閉じるボタン */
  onClose?: () => void
  /** タグを変えたあと、チャットのヘッダーのタグを揃える */
  onTagsChanged?: (tags: Tag[]) => void
}

const CUSTOMERS = 'furim_customers'

const statusLabels: Record<NonNullable<ChatStatusInfo['status']>, { label: string; className: string }> = {
  unread: { label: '未対応', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
}

function text(v: unknown): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : String(v)
}

function yen(v: unknown): string {
  const n = Number(v)
  return v === null || v === undefined || v === '' || Number.isNaN(n) ? '' : `¥${n.toLocaleString('ja-JP')}`
}

function dateOnly(v: unknown): string {
  return toDisplayDateTime(v).slice(0, 10)
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '-'
  if (typeof value === 'string') return value || '-'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value)
  } catch {
    return '[unparseable]'
  }
}

function Section({ id, title, badge, children }: { id: string; title: string; badge?: string; children: ReactNode }) {
  const storageKey = `furim:chat-panel:open:${id}`
  const [open, setOpen] = useState(false)
  useEffect(() => {
    try {
      setOpen(localStorage.getItem(storageKey) === '1')
    } catch {
      /* 保存できない環境では閉じたまま */
    }
  }, [storageKey])
  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(storageKey, v ? '0' : '1')
      } catch {
        /* noop */
      }
      return !v
    })
  }
  return (
    <div className="px-4 py-2">
      <button type="button" onClick={toggle} className="w-full flex items-center gap-1.5 py-1 min-h-[36px] lg:min-h-0 text-left">
        <svg className={`w-3 h-3 text-gray-400 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-[11px] font-medium text-gray-600">{title}</span>
        {badge && <span className="text-[10px] text-gray-400">{badge}</span>}
      </button>
      {open && children}
    </div>
  )
}

function SummaryItem({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-gray-500 whitespace-nowrap">{label}</dt>
      <dd className="text-gray-900 min-w-0 break-all">{children}</dd>
    </div>
  )
}

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setDone(true)
          setTimeout(() => setDone(false), 1500)
        } catch {
          /* noop */
        }
      }}
      className="ml-1.5 px-1.5 rounded border border-gray-300 text-[10px] text-gray-600 hover:bg-gray-50"
    >
      {done ? 'コピー済' : 'コピー'}
    </button>
  )
}

export default function ChatCustomerPanel({ friendId, chatStatus, onClose, onTagsChanged }: Props) {
  const [friend, setFriend] = useState<FriendDetail | null>(null)
  const [friendError, setFriendError] = useState('')
  const [allTags, setAllTags] = useState<Tag[]>([])
  const [tagError, setTagError] = useState('')
  const [customer, setCustomer] = useState<{ table: AdminTableMeta; row: Row } | null>(null)
  const [customerState, setCustomerState] = useState<'loading' | 'found' | 'none' | 'error'>('loading')
  const [richMenu, setRichMenu] = useState<RichMenuState>({ kind: 'loading' })
  const [audit, setAudit] = useState<PersonAuditItem[] | null>(null)

  const loadFriend = useCallback(async () => {
    try {
      const res = await api.friends.get(friendId)
      if (res.success && res.data) {
        const f = res.data as unknown as FriendDetail
        setFriend(f)
        return f
      }
      setFriendError('友だち情報を取得できませんでした')
    } catch (e) {
      setFriendError(e instanceof Error ? e.message : '友だち情報を取得できませんでした')
    }
    return null
  }, [friendId])

  const loadAudit = useCallback(async (lineUserId: string) => {
    try {
      const res = await fetchApi<{ success: boolean; data: PersonAuditItem[] }>(`/api/furim/person-audit/${encodeURIComponent(lineUserId)}?limit=5`)
      setAudit(res.success ? res.data : [])
    } catch {
      setAudit([])
    }
  }, [])

  useEffect(() => {
    let alive = true
    setFriend(null)
    setFriendError('')
    setCustomer(null)
    setCustomerState('loading')
    setRichMenu({ kind: 'loading' })
    setAudit(null)
    setTagError('')
    ;(async () => {
      const f = await loadFriend()
      if (!alive || !f) return
      loadAudit(f.lineUserId)
      try {
        const res = await readRow(CUSTOMERS, f.lineUserId)
        if (!alive) return
        if (res.success && res.meta?.table) {
          setCustomer({ table: res.meta.table, row: res.data })
          setCustomerState('found')
        } else {
          setCustomerState(res.status === 404 ? 'none' : 'error')
        }
      } catch {
        if (alive) setCustomerState('error')
      }
    })()
    api.tags.list().then((res) => { if (alive && res.success) setAllTags(res.data) }).catch(() => {})
    api.friends.richMenu(friendId)
      .then((res) => { if (alive) setRichMenu(res.success && res.data ? { kind: 'data', ...res.data } : { kind: 'error' }) })
      .catch(() => { if (alive) setRichMenu({ kind: 'error' }) })
    return () => {
      alive = false
    }
  }, [friendId, loadFriend, loadAudit])

  const refreshAudit = () => {
    if (friend) loadAudit(friend.lineUserId)
  }

  const handleTagsChanged = async () => {
    const f = await loadFriend()
    if (f) {
      onTagsChanged?.(f.tags)
      loadAudit(f.lineUserId)
    }
  }

  const row = customer?.row
  const keyCode = text(row?.key_code)
  const lastPaid = yen(row?._last_paid_amount)

  return (
    <div className="w-full h-full xl:w-80 2xl:w-[360px] xl:flex-shrink-0 bg-white xl:rounded-lg xl:shadow-sm xl:border border-gray-200 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-200 bg-gray-50 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">顧客</h3>
        {onClose && (
          <button type="button" onClick={onClose} className="p-2 -mr-2 text-gray-500 hover:text-gray-700" aria-label="閉じる">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {friendError ? (
          <div className="p-4 text-xs text-red-600">{friendError}</div>
        ) : !friend ? (
          <div className="p-4 text-xs text-gray-400">読み込み中...</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {/* ① 本人 */}
            <div className="p-4 flex items-start gap-3">
              {friend.pictureUrl ? (
                <img src={friend.pictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
              ) : (
                <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                  <span className="text-gray-500 text-base">{(friend.displayName || '?').charAt(0)}</span>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-gray-900 truncate">{friend.displayName || '名前なし'}</p>
                <p className="text-[11px] text-gray-400 mt-0.5">登録日: {dateOnly(friend.createdAt)}</p>
                <div className="flex flex-wrap items-center gap-1 mt-1">
                  {chatStatus?.status && statusLabels[chatStatus.status] && (
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${statusLabels[chatStatus.status].className}`}>
                      {statusLabels[chatStatus.status].label}
                    </span>
                  )}
                  {!friend.isFollowing && <span className="px-1.5 rounded text-[10px] font-medium bg-gray-100 text-gray-500">ブロック済</span>}
                </div>
              </div>
            </div>

            {/* ② 要点 */}
            <div className="p-4">
              {customerState === 'loading' ? (
                <p className="text-xs text-gray-400">顧客データを読み込み中...</p>
              ) : customerState === 'none' ? (
                <p className="text-xs text-gray-500">顧客DB に未登録（無料・キーコード未発行）</p>
              ) : customerState === 'error' || !row ? (
                <p className="text-xs text-red-600">顧客データを取得できませんでした</p>
              ) : (
                <>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <SummaryItem label="プラン">{text(row.plan_label) || <span className="text-gray-300">—</span>}</SummaryItem>
                    <SummaryItem label="期間">
                      {row.subscription_start_at || row.subscription_end_at ? (
                        `${dateOnly(row.subscription_start_at) || '—'} 〜 ${dateOnly(row.subscription_end_at) || '—'}`
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </SummaryItem>
                    <SummaryItem label="キーコード">
                      {keyCode ? (
                        <span className="inline-flex items-center flex-wrap">
                          <span className="font-mono">{keyCode}</span>
                          <CopyButton value={keyCode} />
                        </span>
                      ) : (
                        <span className="text-gray-300">未発行</span>
                      )}
                    </SummaryItem>
                    <SummaryItem label="直近の支払い">
                      {lastPaid ? `${lastPaid}${row._last_paid_at ? `（${dateOnly(row._last_paid_at)}）` : ''}` : <span className="text-gray-300">なし</span>}
                    </SummaryItem>
                    <SummaryItem label="通算">{`${Number(row._payment_count ?? 0)} 回 ${yen(row._payment_total ?? 0)}`}</SummaryItem>
                    <SummaryItem label="チケット">{`コピー出品 ${Number(row.copy_tickets ?? 0)}・30 日無料 ${Number(row.free30_ticket ?? 0)}`}</SummaryItem>
                  </dl>
                  <a
                    href={tableHref(CUSTOMERS, { open: friend.lineUserId })}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block mt-2 text-[11px] text-green-700 hover:underline"
                  >
                    顧客DBで開く ↗
                  </a>
                </>
              )}
            </div>

            {/* ③ タグ */}
            <div className="p-4">
              <h4 className="text-[11px] font-medium text-gray-500 mb-1.5">タグ</h4>
              {tagError && <p className="text-xs text-red-600 mb-1">{tagError}</p>}
              <TagEditor friendId={friend.id} tags={friend.tags} allTags={allTags} onChanged={handleTagsChanged} onError={setTagError} />
            </div>

            {/* ④ クーポン */}
            <div className="p-4">
              <CouponManager friendId={friend.id} friendName={friend.displayName ?? ''} onChanged={refreshAudit} />
            </div>

            {/* ⑤ 個別メモ */}
            {chatStatus?.notes && (
              <div className="p-4">
                <h4 className="text-[11px] font-medium text-gray-500 mb-1.5">個別メモ</h4>
                <p className="text-xs text-gray-700 whitespace-pre-wrap break-words">{chatStatus.notes}</p>
              </div>
            )}

            {customer && (
              <>
                <Section id="features" title="機能フラグ" badge="切り替えの前に確認">
                  <FeaturePanel lineUserId={friend.lineUserId} displayName={friend.displayName ?? ''} confirmToggle compact onChanged={refreshAudit} />
                </Section>
                <Section id="fields" title="顧客データの全項目" badge="項目ごとに編集">
                  <CustomerFields
                    table={customer.table}
                    row={customer.row}
                    onSaved={(updated) => {
                      setCustomer({ table: customer.table, row: updated })
                      refreshAudit()
                    }}
                  />
                </Section>
                <Section id="related" title="関連データ">
                  <RelatedPanel table={customer.table} row={customer.row} compact />
                </Section>
              </>
            )}

            <Section id="line" title="リッチメニュー・友だち情報">
              <div className="py-2 space-y-3 text-xs">
                <div>
                  <div className="text-[11px] text-gray-500 mb-0.5">リッチメニュー</div>
                  {richMenu.kind === 'loading' ? (
                    <span className="text-gray-400">読み込み中...</span>
                  ) : richMenu.kind === 'error' ? (
                    <span className="text-red-500">取得に失敗しました</span>
                  ) : richMenu.id === null ? (
                    <span className="text-gray-400">未設定</span>
                  ) : (
                    <span className="text-gray-700">
                      {richMenu.name ?? '(名前なし)'}
                      {richMenu.isDefault && <span className="ml-1.5 px-1.5 rounded text-[10px] bg-gray-100 text-gray-500">デフォルト</span>}
                    </span>
                  )}
                </div>
                <div>
                  <div className="text-[11px] text-gray-500 mb-0.5">LINE ユーザーID</div>
                  <span className="font-mono text-gray-600 break-all select-all">{friend.lineUserId}</span>
                </div>
                {friend.metadata &&
                  Object.entries(friend.metadata).map(([key, value]) => (
                    <div key={key}>
                      <div className="text-[10px] text-gray-400 uppercase tracking-wide">{key}</div>
                      <div className="text-gray-700 whitespace-pre-wrap break-words">{renderValue(value)}</div>
                    </div>
                  ))}
              </div>
            </Section>

            {/* 変更履歴（直近 5 件） */}
            <div className="p-4">
              <h4 className="text-[11px] font-medium text-gray-500 mb-1.5">変更履歴（直近 5 件）</h4>
              {audit === null ? (
                <p className="text-xs text-gray-400">読み込み中...</p>
              ) : audit.length === 0 ? (
                <p className="text-xs text-gray-400">まだ変更はありません</p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {audit.map((a) => (
                    <li key={a.id}>
                      <div className="text-[10px] text-gray-400">
                        {toDisplayDateTime(a.created_at).slice(0, 16)}・{a.staff_name}
                      </div>
                      <div className="text-gray-700 break-all">
                        {a.label}: <span className="text-gray-400 line-through">{a.old_value ?? '(なし)'}</span> → {a.new_value ?? '(なし)'}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
