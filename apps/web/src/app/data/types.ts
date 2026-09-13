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
}

export const DISPLAY_NAME_COLUMN = '_display_name'
