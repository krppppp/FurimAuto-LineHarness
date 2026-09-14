export type AdminColumn = {
  name: string
  type: 'text' | 'integer' | 'real'
  editable: boolean
  searchable: boolean
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
}

export const DISPLAY_NAME_COLUMN = '_display_name'
export const FRIEND_CREATED_AT_COLUMN = '_friend_created_at'
/** API が全行に付ける行 id（単一主キーはその値、複合主キーは値を | で連結） */
export const ROW_ID_COLUMN = '_id'

export function rowId(row: Record<string, unknown>, table: { pk: string }): string {
  const v = row[ROW_ID_COLUMN] ?? row[table.pk]
  return v === null || v === undefined ? '' : typeof v === 'string' ? v : String(v)
}
