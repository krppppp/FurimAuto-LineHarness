'use client'

import Link from 'next/link'

interface StatCardProps {
  label: string
  value: number | null
  unit?: string
  hint?: string
  href?: string
  /** 取得に失敗した区画は 0 ではなく — を出して理由を添える（Capsec #285） */
  failed?: boolean
}

export const formatNumber = (n: number): string => n.toLocaleString('ja-JP')
export const formatYen = (n: number): string => `¥${n.toLocaleString('ja-JP')}`

export default function StatCard({ label, value, unit, hint, href, failed }: StatCardProps) {
  const body = (
    <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 h-full">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold tabular-nums ${failed ? 'text-gray-300' : 'text-gray-900'}`}>
        {failed || value === null ? '—' : formatNumber(value)}
        {!failed && value !== null && unit && <span className="ml-1 text-sm font-normal text-gray-500">{unit}</span>}
      </p>
      {hint && <p className="mt-1 text-[11px] text-gray-400">{hint}</p>}
    </div>
  )
  return href ? (
    <Link href={href} className="block hover:opacity-80 transition-opacity">
      {body}
    </Link>
  ) : (
    body
  )
}
