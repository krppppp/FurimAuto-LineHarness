'use client'

import { useEffect, useState } from 'react'
import { getManifest, compareSemver } from '@/lib/update-client'

// FurimAuto独自バナー。upstream(update-banner.tsx)の「改造を検知」表示は出さず、
// フォーク元(line-harness-oss)が現ベースより新しいリリースを公開した時だけ通知する。
// ベースライン = APP_VERSION（= ルート package.json の version = 現在乗っている upstream 版）。

type UpstreamInfo = {
  latest: string
  baseline: string
  changelogUrl: string | null
}

export function UpstreamUpdateBanner() {
  const [info, setInfo] = useState<UpstreamInfo | null>(null)

  useEffect(() => {
    const baseline = process.env.APP_VERSION
    if (!baseline) return

    let cancelled = false
    ;(async () => {
      try {
        const manifest = await getManifest()
        if (cancelled) return
        if (compareSemver(manifest.latest, baseline) > 0) {
          const rel = manifest.releases.find((r) => r.version === manifest.latest)
          setInfo({
            latest: manifest.latest,
            baseline,
            changelogUrl: rel?.changelog_url ?? null,
          })
        }
      } catch (e) {
        console.error('upstream update banner failed', e)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (!info) return null

  return (
    <div className="bg-blue-50 text-blue-900 px-4 py-2 border-b text-sm flex items-center gap-3">
      <div>
        フォーク元 (line-harness-oss){' '}
        <strong>v{info.latest}</strong>{' '}
        が公開されています（現ベース v{info.baseline}）
      </div>
      {info.changelogUrl ? (
        <a
          className="text-xs underline"
          href={info.changelogUrl}
          target="_blank"
          rel="noreferrer"
        >
          変更内容 →
        </a>
      ) : null}
    </div>
  )
}
