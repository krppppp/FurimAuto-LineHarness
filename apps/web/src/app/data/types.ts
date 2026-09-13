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
  pk: string
  columns: AdminColumn[]
  keys: AdminKey[]
  joinFriends: boolean
  allRows: boolean
}

export const DISPLAY_NAME_COLUMN = '_display_name'
export const FRIEND_CREATED_AT_COLUMN = '_friend_created_at'
