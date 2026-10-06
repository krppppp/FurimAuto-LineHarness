import { afterEach, describe, expect, it, vi } from 'vitest'
import { bulkDeleteRows, mutate } from './admin-client'

vi.mock('@/lib/api', () => ({ getCsrfToken: () => 'csrf' }))
vi.mock('@/app/data/datetime', () => ({ toDisplayDateTime: (v: unknown) => String(v ?? '') }))

function stubFetch(responses: Array<{ status: number; body: string }>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift()!
    return new Response(r.body, { status: r.status })
  })
  return calls
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('TB-927 一括削除・削除のエラー文', () => {
  it('bulkDeleteRows は 100 件ずつ bulk-delete に送り、消せた件数と見つからなかった件数をまとめる', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `e${i}`)
    const calls = stubFetch([
      { status: 200, body: JSON.stringify({ success: true, meta: { deleted: ids.slice(0, 99), missing: ['e99'] } }) },
      { status: 200, body: JSON.stringify({ success: true, meta: { deleted: ids.slice(100), missing: [] } }) },
    ])
    const res = await bulkDeleteRows('furim_ext_errors', ids)
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toMatch(/\/api\/furim\/admin\/furim_ext_errors\/bulk-delete$/)
    expect(calls[0].init.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init.body)).ids).toHaveLength(100)
    expect(JSON.parse(String(calls[1].init.body)).ids).toEqual(ids.slice(100))
    expect(res).toEqual({ deleted: [...ids.slice(0, 99), ...ids.slice(100)], missing: ['e99'] })
  })

  it('bulkDeleteRows は途中で失敗したらそこで止め、消せた分と理由を返す', async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `e${i}`)
    stubFetch([
      { status: 200, body: JSON.stringify({ success: true, meta: { deleted: ids.slice(0, 100), missing: [] } }) },
      { status: 400, body: JSON.stringify({ success: false, error: '削除に失敗しました: x' }) },
    ])
    const res = await bulkDeleteRows('furim_ext_errors', ids)
    expect(res.deleted).toHaveLength(100)
    expect(res.error).toBe('削除に失敗しました: x')
  })

  it('mutate は JSON でない応答・ログイン切れ・CSRF 不一致を、次に何をすればよいかが分かる文にする', async () => {
    stubFetch([
      { status: 502, body: '<html>Bad gateway</html>' },
      { status: 401, body: JSON.stringify({ success: false, error: 'Unauthorized' }) },
      { status: 403, body: JSON.stringify({ success: false, error: 'CSRF token mismatch' }) },
    ])
    expect((await mutate('DELETE', '/x')).error).toContain('HTTP 502')
    expect((await mutate('DELETE', '/x')).error).toContain('ログインし直して')
    expect((await mutate('DELETE', '/x')).error).toContain('再読み込み')
  })
})
