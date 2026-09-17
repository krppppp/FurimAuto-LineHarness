'use client'

import { useState, useEffect } from 'react'
import type { Tag } from '@line-crm/shared'
import type { FriendListItem } from '@/lib/api'
import FriendListRow from './friend-list-row'
import TagEditor from './tag-editor'
import CouponManager, { prefetchCoupons } from './coupon-manager'

interface Props {
  friends: FriendListItem[]
  allTags: Tag[]
  onRefresh: () => void
}

export default function FriendListTable({ friends, allTags, onRefresh }: Props) {
  // Inline tag-management expander. The row's primary click navigates to
  // /chats; tag editing stays available here as a secondary action because
  // the chats page's FriendInfoSidebar currently only displays tags (no
  // add/remove). Without this expander operators would lose the only path
  // to mutate friend tags from the admin UI.
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [error, setError] = useState('')

  // クーポン一覧を裏で先読み（モジュールキャッシュ）。行展開時の待ちをなくす
  useEffect(() => {
    prefetchCoupons().catch(() => {})
  }, [])

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
    setError('')
  }

  if (friends.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-12 text-center">
        <p className="text-gray-500">友だちが見つかりません</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden">
      {error && (
        <div className="px-4 py-3 bg-red-50 border-b border-red-100 text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* Header sits inside the same overflow container as the body so the
          column labels stay aligned with their values when the user scrolls
          horizontally on narrower viewports (e.g. desktop with sidebar open
          and the body forced to min-w-[900px]). */}
      <div className="overflow-x-auto">
        <div className="min-w-[900px]">
          <div className="hidden lg:grid grid-cols-[80px_220px_120px_1fr_280px] gap-3 px-4 py-2 bg-gray-50 border-b border-gray-200 text-[11px] font-semibold text-gray-500 uppercase tracking-wider">
            <div>対応マーク</div>
            <div>名前</div>
            <div>シナリオ</div>
            <div>受信メッセージ</div>
            <div>★つきタグ・友だち情報</div>
          </div>
          {friends.map((friend) => {
            const isExpanded = expandedId === friend.id

            return (
              <div key={friend.id}>
                <FriendListRow
                  friend={friend}
                  onTagEditClick={() => toggleExpand(friend.id)}
                />

                {isExpanded && (
                  <div className="bg-gray-50 px-6 py-4 border-b border-gray-100 space-y-3">
                    <div>
                      <p className="text-xs font-semibold text-gray-500 mb-1">LINE ユーザーID</p>
                      <p className="text-xs text-gray-600 font-mono break-all select-all">{friend.lineUserId}</p>
                    </div>
                    <p className="text-xs font-semibold text-gray-500 mb-2">タグ管理</p>
                    <TagEditor
                      friendId={friend.id}
                      tags={friend.tags}
                      allTags={allTags}
                      onChanged={onRefresh}
                      onError={setError}
                    />

                    {/* FurimAuto fork 独自: Stripe クーポン付与 */}
                    <div className="pt-3 border-t border-gray-200">
                      <CouponManager friendId={friend.id} friendName={friend.displayName} />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
