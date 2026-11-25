import { describe, expect, it } from 'vitest';
import { AI_CHAT_GUIDE_IMAGE_URLS, AI_CHAT_NOTICE_IMAGE_URL, aiChatGuideCarousel } from './rich-menu.js';

describe('AI チャットボットの使い方の横スライド（TB-4107）', () => {
  it('使い方 4 枚のあとに注意点 1 枚を並べる。動画は入れない', () => {
    const msg = aiChatGuideCarousel() as { type: string; altText: string; contents: { type: string; contents: Array<{ size: string; body: { contents: Array<{ type: string; url: string; aspectRatio: string }> } }> } };
    expect(msg.type).toBe('flex');
    expect(msg.contents.type).toBe('carousel');
    const images = msg.contents.contents.map((b) => b.body.contents[0]);
    expect(images.map((i) => i.url)).toEqual([...AI_CHAT_GUIDE_IMAGE_URLS, AI_CHAT_NOTICE_IMAGE_URL]);
    expect(images.map((i) => i.aspectRatio)).toEqual(['1:1', '1:1', '1:1', '1:1', '16:9']);
    expect(images.every((i) => i.type === 'image')).toBe(true);
    expect(JSON.stringify(msg)).not.toContain('.mp4');
  });
});
