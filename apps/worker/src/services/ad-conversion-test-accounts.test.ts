import { describe, expect, it, vi } from 'vitest';

const getRefTrackingWithClickIds = vi.fn();
const getActiveAdPlatforms = vi.fn();
vi.mock('@line-crm/db', async (orig) => ({
  ...(await orig<typeof import('@line-crm/db')>()),
  getRefTrackingWithClickIds,
  getActiveAdPlatforms,
}));

const { sendAdConversions } = await import('./ad-conversion.js');

function dbWithFriend(lineUserId: string) {
  return {
    prepare: () => ({ bind: () => ({ first: async () => ({ line_user_id: lineUserId }) }) }),
  } as unknown as D1Database;
}

describe('広告のオフライン CV 送信から検証用アカウントを除く（Capsec #301）', () => {
  it('あじゃぱー（TEST_LINE_IDS）は、gclid があっても媒体の一覧を読まずに終える', async () => {
    getRefTrackingWithClickIds.mockResolvedValueOnce({ gclid: 'CjwKCA_test' });
    await sendAdConversions(dbWithFriend('Ue4941a030cb2ec8758095fb0fffff344'), 'f1', 'line_friend_add');
    expect(getActiveAdPlatforms).not.toHaveBeenCalled();
  });

  it('通常の友だちは今までどおり媒体の一覧を読んで送信に進む', async () => {
    getRefTrackingWithClickIds.mockResolvedValueOnce({ gclid: 'CjwKCA_real' });
    getActiveAdPlatforms.mockResolvedValueOnce([]);
    await sendAdConversions(dbWithFriend('U0000000000000000000000000000abcd'), 'f2', 'line_friend_add');
    expect(getActiveAdPlatforms).toHaveBeenCalledTimes(1);
  });
});
