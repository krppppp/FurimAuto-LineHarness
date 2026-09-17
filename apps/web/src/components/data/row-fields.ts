import { toDisplayDateTime, toStorageDateTime } from '../../app/data/datetime'
import type { AdminColumn, AdminTableMeta } from '../../app/data/types'

/**
 * 1 行の列を「どこまで編集できるか・何を送るか・保存前に確認するか」の決まり（Capsec #308）。
 * 顧客DB の行ドロワー（まとめて保存）と、個別チャットの顧客パネル（項目ごとに保存）の両方がこれを使う。
 * 片方だけ直す事故を防ぐため、判定をここ以外に書かない。
 */

type Row = Record<string, unknown>

function text(v: unknown): string {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : String(v)
}

/** 表示用の値（日時列は表示形式） */
export function fieldText(column: Pick<AdminColumn, 'datetime'>, value: unknown): string {
  return column.datetime ? toDisplayDateTime(value) : text(value)
}

/** 追加モードで主キーが自動採番（'id' 1 列）か */
export function isAutoId(table: AdminTableMeta, insert: boolean): boolean {
  return insert && table.pkColumns.length === 1 && table.pkColumns[0] === 'id'
}

/** 編集できる列か。追加モードは主キー（自動採番を除く）と全列、編集は API の editable どおり */
export function canEditColumn(table: AdminTableMeta, column: Pick<AdminColumn, 'name' | 'editable'>, insert = false): boolean {
  return insert ? !(isAutoId(table, insert) && column.name === 'id') : column.editable
}

/** 入力値 → 送る値（日時列は、その列の現在の保存形式に戻す） */
export function valueToSend(column: AdminColumn, input: string, original: unknown, insert = false): string {
  return column.datetime ? toStorageDateTime(input, insert ? '' : original, column.datetime) : input
}

/** 入力が元の値から変わっているか（編集できない列は常に false） */
export function isFieldChanged(table: AdminTableMeta, column: AdminColumn, input: string, row: Row, insert = false): boolean {
  if (!canEditColumn(table, column, insert)) return false
  return insert ? input !== '' : valueToSend(column, input, row[column.name]) !== text(row[column.name])
}

/** 下書き（列 → 入力値）から、送る変更だけを集める */
export function collectChanges(table: AdminTableMeta, row: Row, draft: Record<string, string>, insert = false): Record<string, string> {
  const changes: Record<string, string> = {}
  for (const c of table.columns) {
    const input = draft[c.name] ?? ''
    if (isFieldChanged(table, c, input, row, insert)) changes[c.name] = valueToSend(c, input, row[c.name], insert)
  }
  return changes
}

/** 保存前に確認を出す列（書き換えると事故になる列）か */
export function needsConfirm(table: AdminTableMeta, columnName: string): boolean {
  return (table.confirmColumns ?? []).includes(columnName)
}

/** 変更に確認が要る列が含まれていれば確認文、無ければ null */
export function confirmMessage(table: AdminTableMeta, row: Row, changes: Record<string, string>): string | null {
  const risky = Object.keys(changes).filter((name) => needsConfirm(table, name))
  if (risky.length === 0) return null
  const lines = risky.map((name) => {
    const label = table.columns.find((c) => c.name === name)?.label ?? name
    const before = text(row[name]) || '(空)'
    const after = changes[name] || '(空)'
    return `・${label}: ${before} → ${after}`
  })
  return `次の項目を書き換えます。拡張の認証や Stripe の請求との紐づけが変わります。\n\n${lines.join('\n')}\n\nよろしいですか？`
}
