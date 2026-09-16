'use client'

interface SegmentedProps<T extends string> {
  options: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel: string
}

/**
 * 粒度・期間の切替（Capsec #285）。lp-analytics の期間ボタンと同じ見た目にそろえ、
 * 選択状態は aria-pressed で出す（friend-add-trend.html の作りを踏襲）。
 */
export default function Segmented<T extends string>({ options, value, onChange, ariaLabel }: SegmentedProps<T>) {
  return (
    <div className="flex rounded-lg border border-gray-300 overflow-hidden" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={`px-3 py-1.5 text-xs font-medium transition-colors ${
            o.value === value ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
