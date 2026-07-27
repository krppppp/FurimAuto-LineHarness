'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { parseStickerMessageContent, stickerFallback } from '@line-crm/shared'
import { api, fetchApi } from '@/lib/api'
import { UNANSWERED_REFRESH_EVENT } from '@/lib/events'
import { useAccount } from '@/contexts/account-context'
import CcPromptButton from '@/components/cc-prompt-button'
import FlexPreviewComponent from '@/components/flex-preview'
import FriendInfoSidebar from '@/components/chats/friend-info-sidebar'
import { type ImageUploaderValue } from '@/components/shared/image-uploader'

interface Chat {
  id: string
  friendId: string
  friendName: string
  friendPictureUrl: string | null
  operatorId: string | null
  status: 'unread' | 'in_progress' | 'resolved'
  notes: string | null
  lastMessageAt: string | null
  lastMessageContent: string | null
  lastMessageDirection: 'incoming' | 'outgoing' | null
  lastMessageType: string | null
  createdAt: string
  updatedAt: string
}

interface ChatMessage {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

interface ChatDetail extends Chat {
  friendName: string
  friendPictureUrl: string | null
  messages?: ChatMessage[]
}

interface SearchResult {
  friendId: string
  friendName: string | null
  friendPictureUrl: string | null
  matchCount: number
  lastMatchAt: string | null
}

type StatusFilter = 'all' | 'unread' | 'in_progress' | 'resolved'

const statusConfig: Record<Chat['status'], { label: string; className: string }> = {
  unread: { label: '未読', className: 'bg-red-100 text-red-700' },
  in_progress: { label: '対応中', className: 'bg-yellow-100 text-yellow-700' },
  resolved: { label: '解決済', className: 'bg-green-100 text-green-700' },
}

const statusFilters: { key: StatusFilter; label: string }[] = [
  { key: 'all', label: '全て' },
  { key: 'unread', label: '未読' },
  { key: 'in_progress', label: '対応中' },
  { key: 'resolved', label: '解決済' },
]

// 一覧の1ページ件数。worker 側 /api/chats のデフォルト LIMIT と揃える。
const CHAT_PAGE_SIZE = 300
// 開いている会話のポーリング間隔（LINE風のリアルタイム更新）。一覧はその3倍間隔
const CHAT_DETAIL_POLL_MS = 5000
const CHAT_LIST_POLL_MS = 15000

function StickerMessageImage({ content }: { content: string }) {
  const [failed, setFailed] = useState(false)
  const sticker = parseStickerMessageContent(content)
  const fallback = stickerFallback(content)

  if (!sticker || failed) return <span>{fallback}</span>

  return (
    <img
      src={sticker.stickerUrl}
      alt={fallback}
      className="max-h-[140px] max-w-[140px] object-contain"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  )
}

function formatDatetime(iso: string | null): string {
  if (!iso) return '-'
  return new Date(iso).toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sameYmd(aIso: string, bIso: string): boolean {
  const a = new Date(aIso)
  const b = new Date(bIso)
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function formatYmdSlash(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`
}

// メッセージ内検索の該当文字列を <mark> で黄色ハイライトする
function highlightQuery(text: string, query: string): React.ReactNode {
  if (!query) return text
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase()
      ? <mark key={i} className="bg-yellow-300 rounded-sm text-inherit">{part}</mark>
      : part
  )
}

const ccPrompts = [
  {
    title: 'チャット対応テンプレート',
    prompt: `チャット対応で使えるテンプレートメッセージを作成してください。
1. よくある質問への回答テンプレート（挨拶、FAQ、サポート）
2. クレーム対応用の丁寧な返信テンプレート
3. フォローアップメッセージのテンプレート
手順を示してください。`,
  },
  {
    title: '未対応チャット確認',
    prompt: `未対応のチャットを確認し、対応優先度を整理してください。
1. 未読・対応中のチャット数を集計
2. 最終メッセージからの経過時間で優先度を判定
3. 長時間未対応のチャットへの対応アクションを提案
結果をレポートしてください。`,
  },
]

interface FriendItem {
  id: string
  displayName: string
  pictureUrl: string | null
  isFollowing: boolean
}

interface MessageLog {
  id: string
  direction: 'incoming' | 'outgoing'
  messageType: string
  content: string
  createdAt: string
}

function DirectMessagePanel({ friendId, friend, onBack, onSent }: {
  friendId: string
  friend: FriendItem | null
  onBack: () => void
  onSent: () => void
}) {
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [messages, setMessages] = useState<MessageLog[]>([])
  const [loadingMessages, setLoadingMessages] = useState(true)
  const isComposingRef = useRef(false)
  const sendLockRef = useRef(false)

  useEffect(() => {
    const loadMessages = async () => {
      setLoadingMessages(true)
      try {
        const res = await fetchApi<{ success: boolean; data: MessageLog[] }>(
          `/api/friends/${friendId}/messages`
        )
        if (res.success) setMessages(res.data)
      } catch { /* silent */ }
      setLoadingMessages(false)
    }
    loadMessages()
  }, [friendId])

  const handleSend = async () => {
    if (!message.trim() || sending || sendLockRef.current) return
    sendLockRef.current = true
    setSending(true)
    try {
      await fetchApi(`/api/friends/${friendId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: message, messageType: 'text' }),
      })
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(),
        direction: 'outgoing',
        messageType: 'text',
        content: message,
        createdAt: new Date().toISOString(),
      }])
      setMessage('')
    } catch { /* silent */ }
    setSending(false)
    sendLockRef.current = false
  }

  function renderContent(msg: MessageLog) {
    if (msg.messageType === 'text') return msg.content
    if (msg.messageType === 'flex') {
      try {
        const parsed = JSON.parse(msg.content)
        // Extract ALL text from flex (up to 200 chars)
        const texts: string[] = []
        const collectText = (obj: Record<string, unknown>) => {
          if (texts.join(' ').length > 200) return
          if (obj.type === 'text' && typeof obj.text === 'string') {
            const t = (obj.text as string).trim()
            if (t && !t.startsWith('{{')) texts.push(t)
          }
          for (const key of ['header', 'body', 'footer']) {
            if (obj[key]) collectText(obj[key] as Record<string, unknown>)
          }
          if (Array.isArray(obj.contents)) {
            for (const c of obj.contents) collectText(c as Record<string, unknown>)
          }
        }
        collectText(parsed)
        return texts.slice(0, 4).join('\n') || '[Flex Message]'
      } catch { return '[Flex Message]' }
    }
    if (msg.messageType === 'sticker') {
      return <StickerMessageImage content={msg.content} />
    }
    return `[${msg.messageType}]`
  }

  return (
    <div className="flex flex-col h-full">
      <div className="px-4 py-4 border-b border-gray-200 flex items-center gap-3">
        <button onClick={onBack} className="lg:hidden text-gray-400 hover:text-gray-600">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        {friend?.pictureUrl ? (
          <img src={friend.pictureUrl} alt="" className="w-8 h-8 rounded-full" />
        ) : (
          <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center">
            <span className="text-gray-500 text-xs">{(friend?.displayName || '?').charAt(0)}</span>
          </div>
        )}
        <div>
          <p className="text-sm font-bold text-gray-900">{friend?.displayName || '不明'}</p>
          <p className="text-xs text-gray-400">メッセージ履歴</p>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {loadingMessages ? (
          <p className="text-center text-gray-400 text-sm">読み込み中...</p>
        ) : messages.length === 0 ? (
          <p className="text-center text-gray-400 text-sm">メッセージ履歴がありません</p>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} className={`flex ${msg.direction === 'outgoing' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[75%] rounded-2xl px-4 py-2 ${
                msg.direction === 'outgoing'
                  ? 'bg-green-500 text-white'
                  : 'bg-gray-100 text-gray-900'
              }`}>
                <div className="text-sm whitespace-pre-wrap break-words">{renderContent(msg)}</div>
                <p className={`text-xs mt-1 ${msg.direction === 'outgoing' ? 'text-green-200' : 'text-gray-400'}`}>
                  {new Date(msg.createdAt).toLocaleString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="px-4 py-3 border-t border-gray-200">
        <div className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onCompositionStart={() => { isComposingRef.current = true }}
            onCompositionEnd={() => { isComposingRef.current = false }}
            onKeyDown={(e) => {
              // IME変換確定のEnterでは送信しない
              if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="メッセージを入力..."
            className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent"
          />
          <button
            onClick={handleSend}
            disabled={!message.trim() || sending}
            className="px-4 py-2 rounded-lg text-white text-sm font-medium disabled:opacity-50"
            style={{ backgroundColor: '#06C755' }}
          >
            {sending ? '...' : '送信'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function ChatsPage() {
  const { selectedAccountId } = useAccount()
  const [chats, setChats] = useState<Chat[]>([])
  const [allFriends, setAllFriends] = useState<FriendItem[]>([])
  const [selectedChatId, setSelectedChatId] = useState<string | null>(null)
  const [selectedFriendId, setSelectedFriendId] = useState<string | null>(null)
  const [chatDetail, setChatDetail] = useState<ChatDetail | null>(null)
  // チャットヘッダーに一目でタグを出すため、開いている friend のタグを取得する。
  const [headerTags, setHeaderTags] = useState<Array<{ id: string; name: string; color: string }>>([])
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const statusFilterRef = useRef<StatusFilter>('all')
  const unansweredOnlyRef = useRef(false)
  const [unansweredOnly, setUnansweredOnly] = useState(() => {
    if (typeof window === 'undefined') return false
    return new URLSearchParams(window.location.search).get('unanswered') === '1'
  })

  // チャット一覧検索（メッセージ本文 / LINE表示名）。入力から300ms後にリアルタイム検索する。
  const [searchQuery, setSearchQuery] = useState('')
  const [searchType, setSearchType] = useState<'message' | 'user'>('message')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const isSearching = searchQuery.trim().length > 0

  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      setSearchResults([])
      setSearchLoading(false)
      return
    }
    setSearchLoading(true)
    const timer = setTimeout(async () => {
      try {
        const res = await api.chats.search({ q, type: searchType, accountId: selectedAccountId || undefined })
        if (res.success) setSearchResults(res.data)
      } catch {
        // サイレント失敗（一覧側の error 表示を検索の失敗で汚さない）
      } finally {
        setSearchLoading(false)
      }
    }, 300)
    return () => clearTimeout(timer)
  }, [searchQuery, searchType, selectedAccountId])

  // 開いている friend のタグをヘッダー表示用に取得（friend変更時のみ）
  useEffect(() => {
    const fid = chatDetail?.friendId
    if (!fid) { setHeaderTags([]); return }
    let cancelled = false
    api.friends.get(fid).then((res) => {
      if (cancelled) return
      const tags = (res.success && res.data)
        ? ((res.data as unknown as { tags?: Array<{ id: string; name: string; color: string }> }).tags ?? [])
        : []
      setHeaderTags(tags)
    }).catch(() => { if (!cancelled) setHeaderTags([]) })
    return () => { cancelled = true }
  }, [chatDetail?.friendId])

  // unansweredOnly 変更時に URL を書き戻す
  useEffect(() => {
    if (typeof window === 'undefined') return
    const urlParams = new URLSearchParams(window.location.search)
    if (unansweredOnly) urlParams.set('unanswered', '1')
    else urlParams.delete('unanswered')
    const qs = urlParams.toString()
    const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
    window.history.replaceState(null, '', url)
  }, [unansweredOnly])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMoreChats, setHasMoreChats] = useState(false)
  const [detailLoading, setDetailLoading] = useState(false)
  const [error, setError] = useState('')
  const [messageContent, setMessageContent] = useState('')
  const [pendingImage, setPendingImage] = useState<ImageUploaderValue | null>(null)
  const [sending, setSending] = useState(false)
  const sendLockRef = useRef(false)
  const [notes, setNotes] = useState('')
  const [savingNotes, setSavingNotes] = useState(false)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const isComposingRef = useRef(false)
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // メッセージ内検索（開いているチャット内をブラウザの Cmd+F のように検索）
  const [msgSearchOpen, setMsgSearchOpen] = useState(false)
  const [msgSearchQuery, setMsgSearchQuery] = useState('')
  const [msgSearchCurrentIndex, setMsgSearchCurrentIndex] = useState(0)
  const messageRefs = useRef<Record<string, HTMLDivElement | null>>({})

  const msgSearchMatches = useMemo(() => {
    const q = msgSearchQuery.trim()
    if (!q) return []
    return (chatDetail?.messages ?? [])
      .filter((m) => m.messageType === 'text' && m.content.includes(q))
      .map((m) => m.id)
  }, [msgSearchQuery, chatDetail?.messages])

  // クエリが変わったら先頭ヒットに戻す
  useEffect(() => { setMsgSearchCurrentIndex(0) }, [msgSearchQuery])

  // 現在のヒットが変わったら該当メッセージへスクロール移動
  useEffect(() => {
    if (msgSearchMatches.length === 0) return
    const id = msgSearchMatches[msgSearchCurrentIndex % msgSearchMatches.length]
    messageRefs.current[id]?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [msgSearchCurrentIndex, msgSearchMatches])

  const gotoPrevMatch = () => {
    if (msgSearchMatches.length === 0) return
    setMsgSearchCurrentIndex((i) => (i - 1 + msgSearchMatches.length) % msgSearchMatches.length)
  }
  const gotoNextMatch = () => {
    if (msgSearchMatches.length === 0) return
    setMsgSearchCurrentIndex((i) => (i + 1) % msgSearchMatches.length)
  }
  const closeMsgSearch = () => {
    setMsgSearchOpen(false)
    setMsgSearchQuery('')
  }

  // ページング用カーソル。表示リストは楽観更新で並び替わるため、
  // 「サーバから最後に受け取った行」を ref で保持して次ページの起点にする
  // (offset 方式だと新着で行が押し下げられた分が欠落する)。
  const nextCursorRef = useRef<{ at: string; id: string } | null>(null)

  const buildListParams = useCallback((cursor: { at: string; id: string } | null) => {
    const params: {
      status?: string; accountId?: string; unansweredOnly?: boolean;
      limit?: number; beforeAt?: string; beforeId?: string;
    } = {}
    if (statusFilter !== 'all' && !unansweredOnly) params.status = statusFilter
    if (selectedAccountId) params.accountId = selectedAccountId
    if (unansweredOnly) params.unansweredOnly = true
    else params.limit = CHAT_PAGE_SIZE
    if (cursor) {
      params.beforeAt = cursor.at
      params.beforeId = cursor.id
    }
    return params
  }, [statusFilter, selectedAccountId, unansweredOnly])

  const loadChats = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const chatRes = await api.chats.list(buildListParams(null))
      if (chatRes.success) {
        const rows = chatRes.data as unknown as Chat[]
        setChats(rows)
        const last = rows[rows.length - 1]
        nextCursorRef.current = last?.lastMessageAt ? { at: last.lastMessageAt, id: last.id } : null
        // ページ丁度いっぱい返ってきた = 続きがある可能性が高い (unansweredOnly は全件返る)
        setHasMoreChats(!unansweredOnly && rows.length === CHAT_PAGE_SIZE)
      }
    } catch {
      setError('チャットの読み込みに失敗しました。もう一度お試しください。')
    } finally {
      setLoading(false)
    }
  }, [buildListParams, unansweredOnly])

  // 「さらに読み込む」— サーバ由来カーソルの続きを取得して末尾に追加する。
  // 楽観更新との競合に備えて既存 id は除外し、重複表示を防ぐ。
  const loadMoreChats = useCallback(async () => {
    if (loadingMore) return
    const cursor = nextCursorRef.current
    if (!cursor) {
      setHasMoreChats(false)
      return
    }
    setLoadingMore(true)
    try {
      const chatRes = await api.chats.list(buildListParams(cursor))
      if (chatRes.success) {
        const rows = chatRes.data as unknown as Chat[]
        setChats((prev) => {
          const seen = new Set(prev.map((c) => c.id))
          return [...prev, ...rows.filter((r) => !seen.has(r.id))]
        })
        const last = rows[rows.length - 1]
        nextCursorRef.current = last?.lastMessageAt ? { at: last.lastMessageAt, id: last.id } : null
        setHasMoreChats(rows.length === CHAT_PAGE_SIZE)
      }
    } catch {
      setError('チャットの追加読み込みに失敗しました。')
    } finally {
      setLoadingMore(false)
    }
  }, [loadingMore, buildListParams])

  // Friends list (for the "new direct message" modal) — loaded lazily in the background
  // Previously fetched 800 friends in parallel with chats, which blocked the initial render.
  const loadAllFriends = useCallback(async () => {
    try {
      const friendRes = await api.friends.list({ accountId: selectedAccountId || undefined, limit: '800' })
      if (friendRes.success) {
        setAllFriends((friendRes.data as unknown as { items: FriendItem[] }).items)
      }
    } catch { /* silent */ }
  }, [selectedAccountId])

  useEffect(() => { void loadAllFriends() }, [loadAllFriends])

  // Keep refs in sync so setChats updater can read the latest filter without stale closure
  useEffect(() => { statusFilterRef.current = statusFilter }, [statusFilter])
  useEffect(() => { unansweredOnlyRef.current = unansweredOnly }, [unansweredOnly])

  const loadChatDetail = useCallback(async (chatId: string) => {
    setDetailLoading(true)
    setError('')
    try {
      const res = await api.chats.get(chatId)
      if (res.success) {
        setChatDetail(res.data as unknown as ChatDetail)
        setNotes((res.data as unknown as ChatDetail).notes || '')
      } else {
        // API は 200 で success:false を返す可能性 (例: 404 lookup)。詳細を画面に出す。
        const errMsg = (res as { error?: string }).error ?? '不明なエラー'
        setError(`チャット詳細の読み込みに失敗しました: ${errMsg}`)
      }
    } catch (err) {
      // ネットワーク / parse / auth fail などの例外。empty catch だと原因不明だったので詳細を出す。
      const msg = err instanceof Error ? err.message : String(err)
      setError(`チャット詳細の読み込みに失敗しました: ${msg}`)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    loadChats()
  }, [loadChats])

  // Deep-link from other pages (e.g. /form-submissions): ?friend=<friendId>
  // chat list returns id = friend_id, so selectedChatId === friendId is correct.
  // If no chat exists yet, loadChatDetail will fail and the user can fall back to
  // the friend list — acceptable for now.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const params = new URLSearchParams(window.location.search)
    const friendId = params.get('friend')
    if (friendId) setSelectedChatId(friendId)
  }, [])

  useEffect(() => {
    if (selectedChatId) {
      loadChatDetail(selectedChatId)
    } else {
      setChatDetail(null)
    }
  }, [selectedChatId, loadChatDetail])

  // 既読相当の遷移: チャットを開いたら未読→対応中に自動更新（LINE準拠。
  // 「未読に戻す」ボタンで戻した場合は、次の新着まで未読のまま維持される）
  const markChatRead = useCallback(async (chatId: string) => {
    try {
      await api.chats.update(chatId, { status: 'in_progress' })
      setChats((prev) => prev.map((c) => c.id === chatId ? { ...c, status: 'in_progress' as const } : c))
      setChatDetail((prev) => (prev && prev.id === chatId) ? { ...prev, status: 'in_progress' as const } : prev)
      // 未読→対応中で未読が 1 件減るので、サイドバーの未読バッジを即時更新させる
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch { /* 既読化失敗は表示上の問題のみなので無視 */ }
  }, [])

  // LINE風リアルタイム更新: 開いている会話をポーリングして新着を反映する。
  // loadChatDetail と違い detailLoading や notes 入力を触らず、変化があった時だけ
  // state を更新する（再レンダリング・スクロール追従を最小化）。タブ非表示中は休む
  useEffect(() => {
    if (!selectedChatId) return
    let stopped = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const res = await api.chats.get(selectedChatId)
        if (stopped || !res.success) return
        const fresh = res.data as unknown as ChatDetail
        let changed = false
        setChatDetail((prev) => {
          if (!prev || prev.id !== fresh.id) return prev
          const prevMsgs = prev.messages ?? []
          const freshMsgs = fresh.messages ?? []
          const unchanged =
            prevMsgs.length === freshMsgs.length &&
            prevMsgs[prevMsgs.length - 1]?.id === freshMsgs[freshMsgs.length - 1]?.id &&
            prev.status === fresh.status
          if (!unchanged) changed = true
          return unchanged ? prev : fresh
        })
        // 開いて見ている最中に来た新着はその場で既読化（LINE と同じ挙動）
        if (changed && fresh.status === 'unread' && !document.hidden) {
          void markChatRead(fresh.id)
        }
        // 新着を検知したら一覧側の該当行も即時更新して先頭へ（15秒の一覧ポーリングを待たない）
        const lastMsg = (fresh.messages ?? [])[(fresh.messages ?? []).length - 1]
        if (changed && lastMsg) {
          setChats((prev) => {
            const updated = prev.map((c) => c.id === fresh.id ? {
              ...c,
              status: fresh.status,
              lastMessageAt: lastMsg.createdAt,
              lastMessageContent: lastMsg.messageType === 'text' ? lastMsg.content : null,
              lastMessageDirection: lastMsg.direction,
              lastMessageType: lastMsg.messageType,
            } : c)
            return [...updated].sort((a, b) => {
              const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
              const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
              return bt - at
            })
          })
        }
      } catch { /* ポーリング失敗は無視（次回に回復） */ }
    }
    const id = window.setInterval(tick, CHAT_DETAIL_POLL_MS)
    return () => {
      stopped = true
      window.clearInterval(id)
    }
  }, [selectedChatId, markChatRead])

  // 一覧の静かな更新: 既存行はサーバ値で置換、新規行は先頭に追加して
  // lastMessageAt 降順を維持する。loadChats と違い loading スピナーを出さない。
  // 15秒ポーリングとモバイルの pull-to-refresh の両方から使う
  const refreshChatList = useCallback(async () => {
    try {
      const chatRes = await api.chats.list(buildListParams(null))
      if (!chatRes.success) return
      const rows = chatRes.data as unknown as Chat[]
      setChats((prev) => {
        const byId = new Map(rows.map((r) => [r.id, r]))
        const merged = prev.map((c) => byId.get(c.id) ?? c)
        const seen = new Set(merged.map((c) => c.id))
        const added = rows.filter((r) => !seen.has(r.id))
        return [...added, ...merged].sort((a, b) => {
          const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
          const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
          return bt - at
        })
      })
    } catch { /* 失敗は無視（次回に回復） */ }
  }, [buildListParams])

  useEffect(() => {
    const tick = () => {
      if (document.hidden) return
      refreshChatList()
    }
    const id = window.setInterval(tick, CHAT_LIST_POLL_MS)
    return () => window.clearInterval(id)
  }, [refreshChatList])

  // モバイル: 一覧を下に引っ張って即時更新（pull-to-refresh）。
  // 一覧がスクロール最上部にある時だけ発動。しきい値 60px で離すと refreshChatList
  const listScrollRef = useRef<HTMLDivElement>(null)
  const pullStartYRef = useRef<number | null>(null)
  const [pullY, setPullY] = useState(0)
  const [pullRefreshing, setPullRefreshing] = useState(false)

  const handleListTouchStart = (e: React.TouchEvent) => {
    pullStartYRef.current = (listScrollRef.current?.scrollTop ?? 1) <= 0 ? e.touches[0].clientY : null
  }
  const handleListTouchMove = (e: React.TouchEvent) => {
    if (pullStartYRef.current == null || pullRefreshing) return
    const dy = e.touches[0].clientY - pullStartYRef.current
    if (dy > 0 && (listScrollRef.current?.scrollTop ?? 0) <= 0) {
      setPullY(Math.min(dy * 0.5, 80)) // 抵抗感を出すため実移動量の半分
    } else {
      setPullY(0)
    }
  }
  const handleListTouchEnd = async () => {
    if (pullStartYRef.current == null) return
    pullStartYRef.current = null
    if (pullY >= 60 && !pullRefreshing) {
      setPullRefreshing(true)
      setPullY(48)
      try {
        await refreshChatList()
      } finally {
        setPullRefreshing(false)
        setPullY(0)
      }
    } else {
      setPullY(0)
    }
  }

  // Surface deep-linked chats in the sidebar even when the current account
  // filter or status filter would exclude them — otherwise the user replies
  // and the conversation stays invisible until they refresh.
  // Re-runs when `chats` changes (e.g. after loadChats refetches on filter
  // change) so the synthetic entry is re-injected if the next API result
  // does not include it. Returning `prev` unchanged when already present
  // avoids any update loop.
  useEffect(() => {
    if (!chatDetail) return
    setChats((prev) => {
      if (prev.some((c) => c.id === chatDetail.id)) return prev
      // /api/chats/:id may not populate the lastMessage* fields; derive
      // from the messages array as a fallback so the sidebar preview is
      // not stuck on "(まだメッセージなし)".
      const lastMsg = chatDetail.messages?.[chatDetail.messages.length - 1]
      const entry: Chat = {
        id: chatDetail.id,
        friendId: chatDetail.friendId,
        friendName: chatDetail.friendName,
        friendPictureUrl: chatDetail.friendPictureUrl,
        operatorId: chatDetail.operatorId ?? null,
        status: chatDetail.status,
        notes: chatDetail.notes ?? null,
        lastMessageAt: chatDetail.lastMessageAt ?? lastMsg?.createdAt ?? null,
        lastMessageContent: chatDetail.lastMessageContent ?? lastMsg?.content ?? null,
        lastMessageDirection: chatDetail.lastMessageDirection ?? lastMsg?.direction ?? null,
        lastMessageType: chatDetail.lastMessageType ?? lastMsg?.messageType ?? null,
        createdAt: chatDetail.createdAt,
        updatedAt: chatDetail.updatedAt,
      }
      return [entry, ...prev]
    })
  }, [chatDetail, chats])

  // 詳細が新しくロードされたら最下部（＝最新メッセージ）までスクロールする。
  // そこから上にスクロールすれば過去のメッセージを辿れる（LINE受信画面と同じUX）。
  // ユーザーが手動でスクロールしたら delayed auto-scroll は発動させない。
  useEffect(() => {
    if (!chatDetail?.messages || chatDetail.messages.length === 0) return
    const el = messagesScrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
    let userScrolled = false
    const onScroll = () => {
      if (!messagesScrollRef.current) return
      const current = messagesScrollRef.current
      // 下端から一定以上離れたらユーザー操作とみなす
      if (current.scrollHeight - current.scrollTop - current.clientHeight > 20) {
        userScrolled = true
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // 画像/Flex の表示後に高さが増える場合に追従するフォロワー（ユーザーがスクロール済みなら発動させない）
    const id = window.setTimeout(() => {
      if (userScrolled || !messagesScrollRef.current) return
      messagesScrollRef.current.scrollTop = messagesScrollRef.current.scrollHeight
    }, 150)
    return () => {
      window.clearTimeout(id)
      el.removeEventListener('scroll', onScroll)
    }
  }, [chatDetail?.id, chatDetail?.messages?.length])

  // Auto-resize textarea as messageContent grows
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [messageContent])

  const handleSelectChat = (chatId: string) => {
    setSelectedChatId(chatId)
    setMessageContent('')
    setPendingImage(null)
    const row = chats.find((c) => c.id === chatId)
    if (row?.status === 'unread') void markChatRead(chatId)
  }

  // LINE風の画像送信: アイコンから端末のカメラ/ライブラリを開く。
  // 制約は ImageUploader と同じ (JPEG/PNG・1MB。LINE の previewImageUrl サイズ制限)
  const handleImageFile = useCallback(async (file: File | undefined) => {
    if (!file) return
    if (!['image/jpeg', 'image/png'].includes(file.type)) {
      setError('画像は JPEG または PNG のみ送信できます')
      return
    }
    if (file.size > 1024 * 1024) {
      setError('画像は 1MB 以下にしてください')
      return
    }
    setUploadingImage(true)
    setError('')
    try {
      const res = await api.uploads.image(file)
      if (res.success) {
        const url = res.data.url
        setPendingImage({ mode: 'line-image', originalContentUrl: url, previewImageUrl: url })
      } else {
        setError((res as { error?: string }).error ?? '画像のアップロードに失敗しました')
      }
    } catch {
      setError('画像のアップロードに失敗しました')
    } finally {
      setUploadingImage(false)
    }
  }, [])

  const handleSendMessage = async () => {
    if (!selectedChatId || sending || sendLockRef.current) return
    if (!messageContent.trim() && !pendingImage) return
    const sendingChatId = selectedChatId  // capture the chat id for this send
    sendLockRef.current = true
    setSending(true)
    try {
      const now = new Date().toISOString()
      // --- Image send path (runs first when image is present) ---
      if (pendingImage && pendingImage.mode === 'line-image') {
        const imgPayload = JSON.stringify({
          originalContentUrl: pendingImage.originalContentUrl,
          previewImageUrl: pendingImage.previewImageUrl,
        })
        await api.chats.send(sendingChatId, { messageType: 'image', content: imgPayload })
        setPendingImage(null)
        // Optimistic update for image
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          messages: [
            ...(prev.messages ?? []),
            {
              id: crypto.randomUUID(),
              direction: 'outgoing',
              messageType: 'image',
              content: imgPayload,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            lastMessageContent: '[画像]',
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'image' as const,
          } : c)
          // 未対応モード時は status filter を skip (worker 側で status を絞ってないため
          // 楽観更新で applied するとリストが歪む — Codex Round 1)
          let filtered = currentUnansweredOnly
            ? updated
            : (currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter))
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
      // --- Text send path (runs independently — both paths execute when both image and text are present) ---
      if (messageContent.trim()) {
        const content = messageContent.trim()
        await api.chats.send(sendingChatId, { content })
        setMessageContent('')
        // Optimistic update: append message locally instead of refetching (prevents scroll jump / full reload feel)
        // Only mutate chatDetail if it still corresponds to the chat we just sent to
        setChatDetail((prev) => (prev && prev.id === sendingChatId) ? {
          ...prev,
          lastMessageAt: now,
          status: 'in_progress',
          messages: [
            ...(prev.messages ?? []),
            {
              id: crypto.randomUUID(),
              direction: 'outgoing',
              messageType: 'text',
              content,
              createdAt: now,
            },
          ],
        } : prev)
        setChats((prev) => {
          // Skip reconciliation if the list no longer contains this chat (e.g. tab changed mid-send)
          const exists = prev.some((c) => c.id === sendingChatId)
          if (!exists) return prev
          const currentFilter = statusFilterRef.current
          const currentUnansweredOnly = unansweredOnlyRef.current
          const updated = prev.map((c) => c.id === sendingChatId ? {
            ...c,
            lastMessageAt: now,
            status: 'in_progress' as const,
            // 一覧の preview も即時更新する。incoming 優先ロジックで上書きされ得るが、
            // 楽観 UI では「operator が今送った文面」が一瞬見えるのが期待動作。
            // 次回 loadChats() で server 側の真の最新 (incoming 優先) に reconcile される。
            lastMessageContent: content,
            lastMessageDirection: 'outgoing' as const,
            lastMessageType: 'text' as const,
          } : c)
          // Drop rows that no longer match the current tab (e.g. replying from 未読 moves chat to in_progress)
          // 未対応モード時は status filter を skip (worker 側で status を絞ってないため
          // 楽観更新で applied するとリストが歪む — Codex Round 1)
          let filtered = currentUnansweredOnly
            ? updated
            : (currentFilter === 'all' ? updated : updated.filter((c) => c.status === currentFilter))
          if (currentUnansweredOnly) {
            // 未対応モードでは、自分が返信したばかりの chat はもう未対応ではないのでリストから除外
            filtered = filtered.filter((c) => c.id !== sendingChatId)
          }
          return [...filtered].sort((a, b) => {
            const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0
            const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0
            return bt - at
          })
        })
      }
      // 手動返信で未対応が 1 件減るので、サイドバーのバッジを即時更新させる
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch {
      setError('メッセージの送信に失敗しました。')
    } finally {
      setSending(false)
      sendLockRef.current = false
    }
  }

  const handleStatusUpdate = async (newStatus: Chat['status']) => {
    if (!selectedChatId) return
    try {
      await api.chats.update(selectedChatId, { status: newStatus })
      loadChatDetail(selectedChatId)
      loadChats()
      // 解決済/未読の切替は未対応バッジに影響するので即時更新させる
      window.dispatchEvent(new Event(UNANSWERED_REFRESH_EVENT))
    } catch {
      setError('ステータスの更新に失敗しました。')
    }
  }

  const handleSaveNotes = async () => {
    if (!selectedChatId) return
    setSavingNotes(true)
    try {
      await api.chats.update(selectedChatId, { notes })
      loadChatDetail(selectedChatId)
    } catch {
      setError('メモの保存に失敗しました。')
    } finally {
      setSavingNotes(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    // IME変換確定のEnterでは送信しない
    if (e.nativeEvent.isComposing || isComposingRef.current || e.keyCode === 229) return
    if (e.key !== 'Enter') return
    // 送信キーは Shift+Enter 固定（Enter単体は改行）。誤送信防止のため設定は設けない
    if (e.shiftKey) {
      e.preventDefault()
      handleSendMessage()
    }
  }

  return (
    <div>
      {/* Error */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
          {error}
        </div>
      )}

      {/* タイトル(Header)は縦幅節約のため非表示。モバイルは fixed で画面に固定し
          （ヘッダー/フッターが動かず、スクロールはメッセージ領域のみ）、
          デスクトップは従来どおり通常フロー + シェル余白差し引きの高さ */}
      <div className="fixed inset-0 lg:static flex gap-4 h-[100dvh] lg:h-[calc(100vh-116px)] bg-gray-50 lg:bg-transparent">
        {/* Left Panel: Chat List */}
        <div className={`w-full lg:w-96 lg:flex-shrink-0 bg-white rounded-none lg:rounded-lg shadow-sm border-0 lg:border border-gray-200 flex-col overflow-hidden ${selectedChatId ? 'hidden lg:flex' : 'flex'}`}>
          {/* タブ (全て / 未読 / 対応中 / 解決済) は意図的に削除。直近メッセージが見やすい LINE 風一覧を優先。 */}

          {/* 検索 — 検索ボタンは置かず、入力から300ms後にリアルタイム検索する */}
          <div className="px-3 pt-2 flex items-center gap-2">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="検索"
              className="flex-1 min-w-0 px-3 py-1.5 text-sm border border-gray-200 rounded-full focus:outline-none focus:ring-1 focus:ring-green-500"
            />
            <div className="flex-shrink-0 flex text-[11px] rounded-full border border-gray-200 overflow-hidden">
              <button
                type="button"
                onClick={() => setSearchType('message')}
                className={`px-2 py-1.5 transition-colors ${searchType === 'message' ? 'bg-green-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                メッセージ
              </button>
              <button
                type="button"
                onClick={() => setSearchType('user')}
                className={`px-2 py-1.5 transition-colors ${searchType === 'user' ? 'bg-green-500 text-white' : 'bg-white text-gray-500 hover:bg-gray-50'}`}
              >
                ユーザー
              </button>
            </div>
          </div>

          {/* Filter row */}
          <div className="px-3 py-2 border-b border-gray-100 flex flex-wrap items-center gap-2">
            {statusFilters.map((f) => (
              <button
                key={f.key}
                onClick={() => setStatusFilter(f.key)}
                disabled={unansweredOnly}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  statusFilter === f.key
                    ? 'bg-green-500 text-white'
                    : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                } ${unansweredOnly ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                {f.label}
              </button>
            ))}
            <label className="flex items-center gap-1.5 text-xs font-medium whitespace-nowrap ml-auto cursor-pointer select-none">
              <input
                type="checkbox"
                checked={unansweredOnly}
                onChange={(e) => setUnansweredOnly(e.target.checked)}
                className="rounded"
              />
              🔥 未対応のみ
            </label>
          </div>

          {/* Chat List */}
          <div
            ref={listScrollRef}
            className="flex-1 overflow-y-auto overscroll-contain"
            onTouchStart={handleListTouchStart}
            onTouchMove={handleListTouchMove}
            onTouchEnd={handleListTouchEnd}
          >
            {isSearching ? (
              searchLoading && searchResults.length === 0 ? (
                <div className="text-center py-8"><p className="text-gray-400 text-sm">検索中...</p></div>
              ) : searchResults.length === 0 ? (
                <div className="text-center py-8"><p className="text-gray-400 text-sm">見つかりませんでした</p></div>
              ) : (
                <>
                  <h6 className="px-4 pt-3 pb-1 text-xs text-gray-400">
                    {searchType === 'message' ? 'メッセージ' : 'ユーザー'} ({searchResults.length})
                  </h6>
                  {searchResults.map((r) => (
                    <button
                      key={r.friendId}
                      onClick={() => { setSearchQuery(''); setSelectedFriendId(null); handleSelectChat(r.friendId) }}
                      className="w-full text-left px-4 py-3 border-b border-gray-100 hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-start gap-3">
                        {r.friendPictureUrl ? (
                          <img src={r.friendPictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                            <span className="text-gray-500 text-sm">{(r.friendName ?? '?').charAt(0)}</span>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-gray-900 truncate min-w-0 flex-1">{r.friendName ?? '(表示名なし)'}</p>
                            <span className="text-[10px] text-gray-400 flex-shrink-0">{formatDatetime(r.lastMatchAt)}</span>
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5">{r.matchCount}件のメッセージ</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </>
              )
            ) : (
            <>
            {(pullY > 0 || pullRefreshing) && (
              <div
                style={{ height: pullRefreshing ? 48 : pullY }}
                className="flex items-center justify-center text-xs text-gray-400 overflow-hidden"
              >
                {pullRefreshing ? '更新中...' : pullY >= 60 ? '離して更新' : '↓ 引っ張って更新'}
              </div>
            )}
            {loading ? (
              <div>
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="px-4 py-3 border-b border-gray-100 animate-pulse">
                    <div className="flex items-center gap-3">
                      <div className="flex-1 space-y-2">
                        <div className="h-3 bg-gray-200 rounded w-32" />
                        <div className="h-2 bg-gray-100 rounded w-20" />
                      </div>
                      <div className="h-5 bg-gray-100 rounded-full w-12" />
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <>
                {chats.map((chat) => {
                  const isSelected = selectedChatId === chat.id
                  // 「真の自発（要対応）」= chat.status='unread'。webhook 側で auto_reply に
                  // マッチしなかった incoming のみ unread に設定される。auto_reply trigger
                  // (キーワード "コスト比較" 等) は matched 扱いで unread 化しない。
                  // bold / 🟥 の表示はこの status を使う。direction だけだと button 押下も
                  // 強調してしまって S/N 比が悪化する。
                  const needsAttention = chat.status === 'unread'
                  // 最新メッセージの本文 preview。flex/image は文字列で見せても意味が薄いので type 表記に置換。
                  const previewRaw = chat.lastMessageContent ?? ''
                  const preview = (() => {
                    if (chat.lastMessageType === 'image') return '📷 画像'
                    if (chat.lastMessageType === 'flex') return '📋 Flexメッセージ'
                    if (chat.lastMessageType === 'sticker') return '🎨 スタンプ'
                    if (chat.lastMessageType === 'video') return '🎥 動画'
                    if (chat.lastMessageType === 'audio') return '🎤 音声'
                    if (chat.lastMessageType === 'file') return '📎 ファイル'
                    if (chat.lastMessageType === 'location') return '📍 位置情報'
                    return previewRaw.replace(/\n+/g, ' ').slice(0, 60)
                  })()
                  return (
                    <button
                      key={chat.id}
                      onClick={() => { setSelectedFriendId(null); handleSelectChat(chat.id); }}
                      className={`w-full text-left px-4 py-3 border-b border-gray-100 transition-colors ${
                        isSelected && !selectedFriendId ? 'bg-green-50' : 'hover:bg-gray-50'
                      }`}
                    >
                      <div className="flex items-start gap-3">
                        {chat.friendPictureUrl ? (
                          <img src={chat.friendPictureUrl} alt="" className="w-10 h-10 rounded-full flex-shrink-0" />
                        ) : (
                          <div className="w-10 h-10 rounded-full bg-gray-200 flex items-center justify-center flex-shrink-0">
                            <span className="text-gray-500 text-sm">{chat.friendName.charAt(0)}</span>
                          </div>
                        )}
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm font-medium text-gray-900 truncate min-w-0 flex-1">{chat.friendName}</p>
                            <span className="text-[10px] text-gray-400 flex-shrink-0">{formatDatetime(chat.lastMessageAt)}</span>
                          </div>
                          <div className="flex items-center justify-between gap-2 mt-0.5">
                            <p
                              className={`text-xs truncate min-w-0 flex-1 ${
                                needsAttention
                                  ? 'text-gray-900 font-medium'
                                  : 'text-gray-400'
                              }`}
                              title={preview}
                            >
                              {chat.lastMessageDirection === 'outgoing' && (
                                <span className="text-gray-400 mr-1">↪</span>
                              )}
                              {preview || <span className="italic text-gray-300">(まだメッセージなし)</span>}
                            </p>
                            {/* 未読は右側の緑ドットで示す（LINE公式アプリ準拠） */}
                            {chat.status === 'unread' && (
                              <span className="w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0" aria-label="未読" />
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
                {hasMoreChats && !unansweredOnly && (
                  <button
                    onClick={() => { void loadMoreChats() }}
                    disabled={loadingMore}
                    className="w-full px-4 py-3 text-sm text-green-700 hover:bg-green-50 disabled:opacity-50 border-b border-gray-100"
                  >
                    {loadingMore ? '読み込み中...' : 'さらに読み込む'}
                  </button>
                )}
              </>
            )}
            </>
            )}
          </div>
        </div>

        {/* Right Panel: Chat Detail */}
        <div className={`flex-1 bg-white rounded-none lg:rounded-lg shadow-sm border-0 lg:border border-gray-200 flex-col overflow-hidden ${selectedChatId || selectedFriendId ? 'flex' : 'hidden lg:flex'}`}>
          {selectedFriendId && !selectedChatId ? (
            /* Direct message to friend without existing chat */
            <DirectMessagePanel
              friendId={selectedFriendId}
              friend={allFriends.find((f) => f.id === selectedFriendId) || null}
              onBack={() => setSelectedFriendId(null)}
              onSent={() => { setSelectedFriendId(null); loadChats(); }}
            />
          ) : !selectedChatId ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">チャットを選択してください</p>
            </div>
          ) : detailLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-gray-400 text-sm">読み込み中...</p>
            </div>
          ) : chatDetail ? (
            <>
              {/* Chat Header */}
              <div className="px-4 py-2 border-b border-gray-200 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <button
                    onClick={() => setSelectedChatId(null)}
                    className="lg:hidden flex-shrink-0 p-1 -ml-1 text-gray-500 hover:text-gray-700"
                    aria-label="戻る"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                  {chatDetail.friendPictureUrl && (
                    <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0" />
                  )}
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium text-gray-900 truncate">
                        {chatDetail.friendName}
                      </p>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium flex-shrink-0 ${statusConfig[chatDetail.status].className}`}
                      >
                        {statusConfig[chatDetail.status].label}
                      </span>
                    </div>
                    {/* タグを一目で確認できるようヘッダーに表示（サイドバーと同じ配色） */}
                    {headerTags.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        {headerTags.map((tag) => (
                          <span
                            key={tag.id}
                            className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium"
                            style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                          >
                            {tag.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {unansweredOnly && chats.length > 1 && (
                    <button
                      type="button"
                      onClick={() => {
                        const idx = chats.findIndex((c) => c.id === selectedChatId)
                        // idx < 0 = current chat is no longer in the list (e.g. just sent a reply)
                        // → fall back to the head of the list so the queue keeps moving
                        const nextIdx = idx < 0 ? 0 : (idx + 1) % chats.length
                        const next = chats[nextIdx]
                        if (next && next.id !== selectedChatId) {
                          setSelectedChatId(next.id)
                        }
                      }}
                      className="rounded-md bg-emerald-600 px-3 py-1.5 min-h-[44px] lg:min-h-0 text-sm font-medium text-white hover:bg-emerald-700"
                      title="次の未対応 friend に進む"
                    >
                      次の未対応 →
                    </button>
                  )}
                  {chatDetail.status !== 'unread' && (
                    <button
                      onClick={() => handleStatusUpdate('unread')}
                      className="px-1.5 py-0.5 text-[11px] font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded transition-colors"
                    >
                      未読
                    </button>
                  )}
                  {chatDetail.status !== 'in_progress' && (
                    <button
                      onClick={() => handleStatusUpdate('in_progress')}
                      className="px-1.5 py-0.5 text-[11px] font-medium text-yellow-700 bg-yellow-50 hover:bg-yellow-100 rounded transition-colors"
                    >
                      対応中
                    </button>
                  )}
                  {chatDetail.status !== 'resolved' && (
                    <button
                      onClick={() => handleStatusUpdate('resolved')}
                      className="px-1.5 py-0.5 text-[11px] font-medium text-green-700 bg-green-50 hover:bg-green-100 rounded transition-colors"
                    >
                      解決済
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setMsgSearchOpen((v) => !v)}
                    className={`p-1 rounded transition-colors ${msgSearchOpen ? 'bg-green-100 text-green-700' : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
                    aria-label="メッセージ内を検索"
                    title="メッセージ内を検索"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
                    </svg>
                  </button>
                </div>
              </div>

              {/* メッセージ内検索バー — ブラウザの Cmd+F と同じ感覚で、開いているチャット内のみ検索する */}
              {msgSearchOpen && (
                <div className="px-4 py-1.5 border-b border-gray-200 bg-gray-50 flex items-center gap-2">
                  <input
                    autoFocus
                    type="text"
                    value={msgSearchQuery}
                    onChange={(e) => setMsgSearchQuery(e.target.value)}
                    placeholder="メッセージ内を検索"
                    className="flex-1 min-w-0 px-3 py-1 text-sm border border-gray-200 rounded-full focus:outline-none focus:ring-1 focus:ring-green-500"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        if (e.shiftKey) gotoPrevMatch(); else gotoNextMatch()
                      } else if (e.key === 'Escape') {
                        closeMsgSearch()
                      }
                    }}
                  />
                  <span className="text-xs text-gray-400 flex-shrink-0 tabular-nums w-10 text-right">
                    {msgSearchQuery.trim() === ''
                      ? ''
                      : msgSearchMatches.length === 0
                        ? '0件'
                        : `${msgSearchCurrentIndex + 1}/${msgSearchMatches.length}`}
                  </span>
                  <button
                    type="button"
                    onClick={gotoPrevMatch}
                    disabled={msgSearchMatches.length === 0}
                    className="p-1 text-gray-500 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="前のヒットへ"
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    onClick={gotoNextMatch}
                    disabled={msgSearchMatches.length === 0}
                    className="p-1 text-gray-500 hover:text-gray-700 disabled:opacity-30 disabled:cursor-not-allowed"
                    aria-label="次のヒットへ"
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    onClick={closeMsgSearch}
                    className="p-1 text-gray-400 hover:text-gray-600"
                    aria-label="検索を閉じる"
                  >
                    ×
                  </button>
                </div>
              )}

              {/* Messages — LINE-style chat bubbles */}
              <div ref={messagesScrollRef} className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-2" style={{ backgroundColor: '#7494C0' }}>
                {(!chatDetail.messages || chatDetail.messages.length === 0) ? (
                  <div className="text-center py-8">
                    <p className="text-white/60 text-sm">メッセージはまだありません。</p>
                  </div>
                ) : (
                  (chatDetail.messages ?? []).map((msg, idx) => {
                    const prevMsg = idx > 0 ? (chatDetail.messages ?? [])[idx - 1] : null
                    const showDateSep = !prevMsg || !sameYmd(prevMsg.createdAt, msg.createdAt)
                    const isOutgoing = msg.direction === 'outgoing'

                    // メッセージ表示の分岐
                    let bubbleContent: React.ReactNode
                    if (msg.messageType === 'flex') {
                      bubbleContent = (
                        <div className="max-w-[300px]">
                          <FlexPreviewComponent content={msg.content} maxWidth={280} />
                        </div>
                      )
                    } else if (msg.messageType === 'image') {
                      try {
                        const parsed = JSON.parse(msg.content)
                        const fullUrl = parsed.originalContentUrl || parsed.previewImageUrl
                        bubbleContent = (
                          <img
                            src={fullUrl}
                            alt=""
                            className="max-w-[200px] rounded cursor-pointer"
                            onClick={() => setLightboxUrl(fullUrl)}
                          />
                        )
                      } catch {
                        bubbleContent = <span>🖼️ [画像]</span>
                      }
                    } else if (msg.messageType === 'sticker') {
                      bubbleContent = <StickerMessageImage content={msg.content} />
                    } else if (msg.messageType === 'video') {
                      try {
                        const parsed = JSON.parse(msg.content)
                        bubbleContent = (
                          <a href={parsed.originalContentUrl} target="_blank" rel="noreferrer" className="relative block">
                            <img src={parsed.previewImageUrl} alt="" className="max-w-[200px] rounded" />
                            <span className="absolute inset-0 flex items-center justify-center">
                              <span className="w-10 h-10 rounded-full bg-black/50 flex items-center justify-center text-white text-lg">▶</span>
                            </span>
                          </a>
                        )
                      } catch {
                        bubbleContent = <span>🎬 [動画]</span>
                      }
                    } else if (msg.messageType === 'imagemap') {
                      // imagemap は baseUrl/{width} で画像が取れる（LINE仕様）。uri アクションがあればリンクにする
                      try {
                        const parsed = JSON.parse(msg.content)
                        const linkUri = (parsed.actions as Array<{ type?: string; linkUri?: string }> | undefined)
                          ?.find((a) => a.type === 'uri')?.linkUri
                        const img = <img src={`${parsed.baseUrl}/1040`} alt={parsed.altText ?? ''} className="max-w-[240px] rounded-lg" />
                        bubbleContent = linkUri
                          ? <a href={linkUri} target="_blank" rel="noreferrer" className="block">{img}</a>
                          : img
                      } catch {
                        bubbleContent = <span>🖼️ [imagemap]</span>
                      }
                    } else if (msg.messageType === 'template') {
                      // buttons / confirm テンプレートをLINE風カードで再現（uriアクションはリンク化）
                      try {
                        const parsed = JSON.parse(msg.content)
                        const tpl = parsed.template ?? {}
                        const actions: Array<{ type?: string; label?: string; uri?: string }> =
                          tpl.actions ?? tpl.columns?.[0]?.actions ?? []
                        bubbleContent = (
                          <div className="w-[240px] bg-white rounded-xl overflow-hidden border border-gray-200 text-gray-900">
                            {tpl.thumbnailImageUrl && (
                              <img src={tpl.thumbnailImageUrl} alt="" className="w-full" />
                            )}
                            <div className="px-3 py-2">
                              {tpl.title && <p className="text-sm font-bold mb-1">{tpl.title}</p>}
                              <p className="text-sm whitespace-pre-wrap">{tpl.text ?? parsed.altText ?? ''}</p>
                            </div>
                            {actions.length > 0 && (
                              <div className="border-t border-gray-100">
                                {actions.map((a, i) => a.type === 'uri' && a.uri ? (
                                  <a key={i} href={a.uri} target="_blank" rel="noreferrer" className="block text-center text-sm text-emerald-600 font-medium py-2 border-b border-gray-100 last:border-b-0 hover:bg-gray-50">
                                    {a.label}
                                  </a>
                                ) : (
                                  <div key={i} className="text-center text-sm text-emerald-600 font-medium py-2 border-b border-gray-100 last:border-b-0">
                                    {a.label}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )
                      } catch {
                        bubbleContent = <span>📋 [テンプレート]</span>
                      }
                    } else {
                      // JSON形式の未対応メッセージは生JSONを出さずtype+altTextで要約表示
                      let fallback: React.ReactNode = (
                        <span>{highlightQuery(msg.content, msgSearchOpen ? msgSearchQuery.trim() : '')}</span>
                      )
                      if (msg.content.startsWith('{')) {
                        try {
                          const parsed = JSON.parse(msg.content)
                          if (parsed && typeof parsed === 'object' && parsed.type) {
                            fallback = <span>[{parsed.type}] {parsed.altText ?? ''}</span>
                          }
                        } catch { /* 生テキストのまま表示 */ }
                      }
                      bubbleContent = fallback
                    }

                    // 吹き出し（緑/白の背景）はテキスト系のみ。画像・スタンプ・Flex・
                    // imagemap・テンプレート等のリッチコンテンツは LINE と同じく背景なしで表示する
                    const isPlainBubble = !['flex', 'image', 'sticker', 'video', 'imagemap', 'template'].includes(msg.messageType)

                    const isCurrentSearchMatch =
                      msgSearchOpen &&
                      msgSearchMatches.length > 0 &&
                      msgSearchMatches[msgSearchCurrentIndex % msgSearchMatches.length] === msg.id

                    return (
                      <div
                        key={msg.id}
                        ref={(el) => { messageRefs.current[msg.id] = el }}
                        className={isCurrentSearchMatch ? 'ring-2 ring-yellow-400 rounded-2xl -m-1 p-1' : undefined}
                      >
                        {showDateSep && (
                          <div className="flex justify-center my-3">
                            <span className="text-[11px] text-white/85 bg-black/20 px-2.5 py-0.5 rounded-full">
                              {formatYmdSlash(msg.createdAt)}
                            </span>
                          </div>
                        )}
                        <div
                          className={`flex items-end gap-2 ${isOutgoing ? 'justify-end' : 'justify-start'}`}
                        >
                          {/* 相手のアイコン（incoming のみ） */}
                          {!isOutgoing && (
                            chatDetail.friendPictureUrl ? (
                              <img src={chatDetail.friendPictureUrl} alt="" className="w-8 h-8 rounded-full flex-shrink-0 mb-1" />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-gray-300 flex-shrink-0 mb-1" />
                            )
                          )}

                          <div className={`flex flex-col ${isOutgoing ? 'items-end' : 'items-start'}`}>
                            {/* テキストのみ吹き出し背景を付ける。リッチコンテンツは背景なし（LINE準拠） */}
                            {isPlainBubble ? (
                              <div
                                className={`max-w-[320px] px-3 py-2 text-sm break-words whitespace-pre-wrap ${
                                  isOutgoing
                                    ? 'rounded-tl-2xl rounded-tr-md rounded-bl-2xl rounded-br-2xl text-white'
                                    : 'rounded-tl-md rounded-tr-2xl rounded-bl-2xl rounded-br-2xl bg-white text-gray-900'
                                }`}
                                style={isOutgoing ? { backgroundColor: '#06C755' } : undefined}
                              >
                                {bubbleContent}
                              </div>
                            ) : (
                              <div className="max-w-[320px]">
                                {bubbleContent}
                              </div>
                            )}
                            {/* 時刻 */}
                            <span className="text-xs text-white/50 mt-0.5 px-1">
                              {new Date(msg.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>

              {/* Notes */}
              <div className="px-4 py-2 border-t border-gray-200 bg-gray-50">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="メモを入力..."
                    className="flex-1 text-xs border border-gray-300 rounded-md px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-green-500"
                  />
                  <button
                    onClick={handleSaveNotes}
                    disabled={savingNotes}
                    className="px-2 py-1 text-xs font-medium text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-md transition-colors disabled:opacity-50"
                  >
                    {savingNotes ? '保存中...' : 'メモ保存'}
                  </button>
                </div>
              </div>

              {/* Send Message Form — LINE風: 画像アイコン + 入力欄 + 送信。送信キーはShift+Enter固定 */}
              <div className="px-4 py-3 border-t border-gray-200">
                {pendingImage && pendingImage.mode === 'line-image' && (
                  <div className="mb-2 flex items-center gap-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={pendingImage.previewImageUrl} alt="" className="h-16 w-16 rounded-lg object-cover ring-1 ring-gray-200" />
                    <button
                      type="button"
                      onClick={() => setPendingImage(null)}
                      className="text-xs font-medium text-rose-600 underline"
                    >
                      取り消し
                    </button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <input
                    ref={imageInputRef}
                    type="file"
                    accept="image/jpeg,image/png"
                    className="hidden"
                    onChange={(e) => {
                      void handleImageFile(e.target.files?.[0])
                      e.target.value = ''
                    }}
                  />
                  <textarea
                    ref={textareaRef}
                    rows={5}
                    value={messageContent}
                    style={{ minHeight: '120px', maxHeight: '200px', overflowY: 'auto' }}
                    onChange={(e) => setMessageContent(e.target.value)}
                    onCompositionStart={() => { isComposingRef.current = true }}
                    onCompositionEnd={() => { isComposingRef.current = false }}
                    onKeyDown={handleKeyDown}
                    placeholder="メッセージを入力... (Shift+Enterで送信)"
                    className="flex-1 text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-green-500 resize-none overflow-y-auto"
                  />
                  {/* 右カラム: 上にツールアイコン（今後増える想定）、下に送信ボタン */}
                  <div className="flex-shrink-0 flex flex-col items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => imageInputRef.current?.click()}
                      disabled={uploadingImage}
                      aria-label="画像を選択"
                      title="画像を送る"
                      className="p-2 rounded-full text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-50"
                    >
                      {uploadingImage ? (
                        <span className="block h-6 w-6 animate-spin rounded-full border-2 border-gray-300 border-t-green-500" />
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-6 w-6">
                          <rect x="3" y="5" width="18" height="14" rx="2" />
                          <circle cx="8.5" cy="10" r="1.5" fill="currentColor" stroke="none" />
                          <path d="m5 17 4.5-4.5 3 3L16 12l3 3" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </button>
                    <button
                      onClick={handleSendMessage}
                      disabled={sending || uploadingImage || (!messageContent.trim() && !pendingImage)}
                      className="px-4 py-2 text-sm font-medium text-white rounded-lg transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
                      style={{ backgroundColor: '#06C755' }}
                    >
                      {sending ? '送信中...' : '送信'}
                    </button>
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </div>

        {/* Right-most Panel: 友だち詳細サイドバー — chat detail を開いている時のみ表示 */}
        {/*
          friendId は **現在の selection** を優先する。chatDetail の load 中は前の chat
          のデータが残ったままなので、それを参照するとサイドバーだけ前の友だちを
          表示し続けて pane 間の不整合になる。selection ID 自体が friend_id なので
          直接渡せる (chat list SQL が `id: f.id` で friend_id を返す)。
        */}
        {(selectedChatId || selectedFriendId) && (
          <div className="hidden xl:flex">
            <FriendInfoSidebar
              friendId={selectedFriendId || selectedChatId}
              chatStatus={
                chatDetail && chatDetail.id === (selectedFriendId || selectedChatId)
                  ? { status: chatDetail.status, notes: chatDetail.notes }
                  : undefined
              }
            />
          </div>
        )}
      </div>
      <CcPromptButton prompts={ccPrompts} />

      {/* 画像タップ拡大表示（ライトボックス）。背景クリックで閉じる */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 flex items-center justify-center p-4"
          onClick={() => setLightboxUrl(null)}
        >
          <img
            src={lightboxUrl}
            alt=""
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            onClick={() => setLightboxUrl(null)}
            className="absolute top-4 right-4 w-10 h-10 rounded-full bg-black/50 text-white text-2xl flex items-center justify-center"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      )}
    </div>
  )
}
