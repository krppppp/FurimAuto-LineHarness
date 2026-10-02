import { getCsrfToken } from '@/lib/api'
import { toDisplayDateTime } from '@/app/data/datetime'
import type { AdminTableMeta, DateTimeStorage } from '@/app/data/types'
import { confirmMessage } from './row-fields'

// データ区画（顧客DB の行ドロワー）と個別チャットの顧客パネル（Capsec #308）で共用する、管理 API の読み書き

export type Row = Record<string, unknown>

export type RowResponse = { success: boolean; error?: string; data: Row; meta?: { changed?: string[] } }

export type AuditRow = {
  id: string
  staff_name: string
  column_name: string
  old_value: string | null
  new_value: string | null
  created_at: string
}

export const DATETIME_PLACEHOLDER = '2026/09/13 23:45:43'

// fetchApi は 4xx を例外にして本文を捨てるので、PATCH/POST/DELETE のエラー文（列の型違い・UNIQUE 制約など）を出すために本文を読む
// 本文が JSON でない（Cloudflare のエラーページ等）・ログイン切れ・CSRF 不一致は、何をすればよいかが分かる文に置き換える（TB-927）
export async function mutate<T extends { success: boolean; error?: string } = RowResponse>(
  method: 'PATCH' | 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let parsed: T
  try {
    parsed = JSON.parse(text) as T
  } catch {
    return { success: false, error: `サーバーの応答を読めませんでした（HTTP ${res.status}）。時間をおいてもう一度お試しください` } as T
  }
  if (!parsed.success && res.status === 401) parsed.error = 'ログインが切れています。ページを再読み込みしてログインし直してください'
  if (!parsed.success && parsed.error === 'CSRF token mismatch') parsed.error = '画面の認証情報が古くなっています。ページを再読み込みしてからもう一度押してください'
  return parsed
}

export type BulkDeleteResponse = { success: boolean; error?: string; meta?: { deleted: string[]; missing: string[] } }

export const BULK_DELETE_CHUNK = 100

/** チェックした行をまとめて削除する（Worker の上限に合わせて 100 件ずつ送る）。途中で失敗したらそこで止め、消せた分と失敗理由を返す */
export async function bulkDeleteRows(tableName: string, ids: string[]): Promise<{ deleted: string[]; missing: string[]; error?: string }> {
  const deleted: string[] = []
  const missing: string[] = []
  for (let i = 0; i < ids.length; i += BULK_DELETE_CHUNK) {
    const part = ids.slice(i, i + BULK_DELETE_CHUNK)
    const res = await mutate<BulkDeleteResponse>('POST', `/api/furim/admin/${tableName}/bulk-delete`, { ids: part })
    if (res.meta) {
      deleted.push(...res.meta.deleted)
      missing.push(...res.meta.missing)
    }
    if (!res.success) {
      if (res.meta && res.meta.deleted.length === 0 && res.meta.missing.length === part.length) continue
      return { deleted, missing, error: res.error ?? '削除に失敗しました' }
    }
  }
  return { deleted, missing }
}


export function cell(v: unknown): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : String(v)
}

export function shown(v: unknown, datetime: DateTimeStorage | null): string {
  return datetime ? toDisplayDateTime(v) : cell(v)
}

export function tableHref(name: string, params: Record<string, string>): string {
  const sp = new URLSearchParams({ name, ...params })
  return `/data/table?${sp.toString()}`
}

/** 1 行を読む。行が無い（404）ときも本文の success=false で返す（fetchApi は 4xx を例外にするため直接 fetch） */
export async function readRow(tableName: string, id: string): Promise<RowResponse & { status: number; meta?: { table?: AdminTableMeta } }> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/api/furim/admin/${encodeURIComponent(tableName)}/${encodeURIComponent(id)}`, {
    credentials: 'include',
  })
  const body = (await res.json()) as RowResponse & { meta?: { table?: AdminTableMeta } }
  return { ...body, status: res.status }
}

/**
 * 1 行の既存の列を PATCH で保存する（監査ログは API 側で残る）。
 * 書き換えると事故になる列（table.confirmColumns）が変わるときは、保存の前に確認を出す。キャンセルなら null
 */
export async function saveRowChanges(
  table: AdminTableMeta,
  id: string,
  row: Row,
  changes: Record<string, string>,
  ask: (message: string) => boolean = (m) => window.confirm(m),
): Promise<RowResponse | null> {
  const message = confirmMessage(table, row, changes)
  if (message && !ask(message)) return null
  return mutate<RowResponse>('PATCH', `/api/furim/admin/${table.name}/${encodeURIComponent(id)}`, { changes })
}
