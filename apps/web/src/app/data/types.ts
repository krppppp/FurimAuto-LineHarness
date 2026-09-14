export type DateTimeStorage = 'jst' | 'jst_naive' | 'space' | 'utc' | 'slash'

export type AdminColumn = {
  name: string
  type: 'text' | 'integer' | 'real'
  editable: boolean
  searchable: boolean
  /** 日本語ラベル（未定義なら英名） */
  label: string
  /** D1 が付与した内部 ID（一覧では出さない） */
  internal: boolean
  /** 日時列なら、値が空のときの保存形式 */
  datetime: DateTimeStorage | null
}

export type AdminKey = {
  column: string
  kind: 'line_user_id' | 'friend_id' | 'stripe_customer_id' | 'key_code'
}

export type AdminTableMeta = {
  name: string
  label: string
  /** 表示用（複合主キーは "a,b"） */
  pk: string
  pkColumns: string[]
  insertable: boolean
  deletable: boolean
  columns: AdminColumn[]
  keys: AdminKey[]
  joinFriends: boolean
  allRows: boolean
  /** 基準日時の列（顧客は _friend_created_at） */
  timeColumn: string | null
  timeColumnLabel: string | null
  /** 一覧の列順（LINE 表示名の後ろ。基準日時 → 残り・内部 ID を除く） */
  listColumns: string[]
}

export const DISPLAY_NAME_COLUMN = '_display_name'
export const FRIEND_CREATED_AT_COLUMN = '_friend_created_at'
/** API が全行に付ける行 id（単一主キーはその値、複合主キーは値を | で連結） */
export const ROW_ID_COLUMN = '_id'

export function rowId(row: Record<string, unknown>, table: { pk: string }): string {
  const v = row[ROW_ID_COLUMN] ?? row[table.pk]
  return v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v)
}

export type ListColumn = { name: string; label: string; datetime: DateTimeStorage | null }

/** 一覧・関連データの列（listColumns の順。_friend_created_at のような付加列も含む） */
export function listColumnsOf(table: AdminTableMeta): ListColumn[] {
  return table.listColumns.map((name) => {
    const col = table.columns.find((c) => c.name === name)
    if (col) return { name, label: col.label, datetime: col.datetime }
    return { name, label: name === table.timeColumn ? (table.timeColumnLabel ?? name) : name, datetime: name.endsWith('_at') ? 'jst' : null }
  })
}
