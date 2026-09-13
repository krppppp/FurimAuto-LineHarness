export type AdminColumn = {
  name: string
  type: 'text' | 'integer' | 'real'
  editable: boolean
  searchable: boolean
}

export type AdminTableMeta = {
  name: string
  label: string
  pk: string
  columns: AdminColumn[]
}
