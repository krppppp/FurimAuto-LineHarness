import { describe, test, expect, vi, beforeEach } from 'vitest';

const getProfile = vi.fn();
vi.mock('@line-crm/line-sdk', () => ({
  LineClient: vi.fn().mockImplementation(() => ({ getProfile })),
}));

import { sweepStalePictureUrls } from './profile-refresh.js';

type Row = { id: string; line_user_id: string; picture_url: string; channel_access_token: string | null };

function makeDb(candidates: Row[]) {
  const stmt = {
    bind: vi.fn(),
    run: vi.fn().mockResolvedValue({ meta: { changes: 1 } }),
    all: vi.fn().mockResolvedValue({ results: candidates }),
  };
  stmt.bind.mockReturnValue(stmt);
  return { db: { prepare: vi.fn().mockReturnValue(stmt) } as unknown as D1Database, stmt };
}

const env = { LINE_CHANNEL_ACCESS_TOKEN: 'default-token' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('sweepStalePictureUrls', () => {
  test('全員のpicture_urlが200なら getProfile もUPDATEも一切呼ばれない', async () => {
    const candidates: Row[] = [
      { id: 'f1', line_user_id: 'U1', picture_url: 'https://sprofile.line-scdn.net/1', channel_access_token: null },
      { id: 'f2', line_user_id: 'U2', picture_url: 'https://sprofile.line-scdn.net/2', channel_access_token: null },
    ];
    const { db, stmt } = makeDb(candidates);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200 }));

    const result = await sweepStalePictureUrls(db, env);

    expect(result).toEqual({ checked: 2, stale: 0, updated: 0, notFound: 0, otherErrors: 0 });
    expect(getProfile).not.toHaveBeenCalled();
    expect(stmt.run).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test('404のfriendだけ getProfile で再取得しUPDATEする', async () => {
    const candidates: Row[] = [
      { id: 'f1', line_user_id: 'U1', picture_url: 'https://sprofile.line-scdn.net/dead', channel_access_token: null },
      { id: 'f2', line_user_id: 'U2', picture_url: 'https://sprofile.line-scdn.net/alive', channel_access_token: null },
    ];
    const { db, stmt } = makeDb(candidates);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve({ status: url.includes('dead') ? 404 : 200 }),
      ),
    );
    getProfile.mockResolvedValue({
      displayName: 'refreshed',
      pictureUrl: 'https://sprofile.line-scdn.net/new',
      statusMessage: null,
    });

    const result = await sweepStalePictureUrls(db, env);

    expect(result).toEqual({ checked: 2, stale: 1, updated: 1, notFound: 0, otherErrors: 0 });
    expect(getProfile).toHaveBeenCalledTimes(1);
    expect(getProfile).toHaveBeenCalledWith('U1');
    expect(stmt.bind).toHaveBeenCalledWith('refreshed', 'https://sprofile.line-scdn.net/new', null, 'f1');
    vi.unstubAllGlobals();
  });
});
