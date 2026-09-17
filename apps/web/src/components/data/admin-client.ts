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
export async function mutate(method: 'PATCH' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<RowResponse> {
  const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL}${path}`, {
    method,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res.json() as Promise<RowResponse>
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
  return mutate('PATCH', `/api/furim/admin/${table.name}/${encodeURIComponent(id)}`, { changes })
}
