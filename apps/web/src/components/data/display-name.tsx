import { DISPLAY_NAME_COLUMN } from '@/app/data/types'
import { cell, type Row } from './admin-client'

export default function DisplayName({ row }: { row: Row }) {
  const v = cell(row[DISPLAY_NAME_COLUMN])
  return v ? <span className="font-medium text-gray-900">{v}</span> : <span className="text-gray-300">—</span>
}
