import { describe, expect, it } from 'vitest';
import { allowedPage } from './lp-beacon.js';

/**
 * 計測ビーコンを受け付けるページ（Capsec #316）。
 * 新メディアサイト（記事は /articles/<slug>/・#310 くろさん承認）を足したとき、
 * 前方一致でどんなパスでも通る形になっていないことをここで固定する。
 */

describe('lp-beacon の allowedPage', () => {
  it('今までの LP・サービス・中継・オンボーディング・WordPress 記事は受け付ける', () => {
    for (const page of [
      '/lp/diag/',
      '/service/',
      '/service/copy/',
      '/r/abc123',
      '/welcome/?src=install',
      '/2026/09/17/mercari-auto/',
      '/2026/09/17/%E3%83%A1%E3%83%AB%E3%82%AB%E3%83%AA/',
    ]) {
      expect(allowedPage(page), page).toBe(true);
    }
  });

  it('新メディアサイトのページを受け付ける', () => {
    for (const page of [
      '/articles/mercari-auto-start/',
      '/articles/%E3%83%A1%E3%83%AB%E3%82%AB%E3%83%AA%E8%87%AA%E5%8B%95%E5%8C%96/',
      '/category/start/',
      '/category/listing/',
      '/category/automation/',
      '/category/channels/',
      '/category/operation/',
      '/news/',
      '/author/kuro/',
      '/about/',
      '/contact/',
      '/search/',
      '/search/?q=%E5%86%8D%E5%87%BA%E5%93%81',
    ]) {
      expect(allowedPage(page), page).toBe(true);
    }
  });

  it('許可を広げすぎない（末尾のスラッシュ無し・深い階層・知らないカテゴリ・別のパスは受け付けない）', () => {
    for (const page of [
      '/articles/',
      '/articles/mercari-auto-start',
      '/articles/mercari-auto-start/extra/',
      '/articles/../admin/',
      '/category/',
      '/category/unknown/',
      '/category/start/page/2/',
      '/author/',
      '/news/2026/',
      '/about',
      '/contactus/',
      '/search',
      '/searching/',
      '/',
      '/wp-admin/',
      '/admin/data/',
      '/api/lp-beacon',
      '/2026/9/17/x/',
    ]) {
      expect(allowedPage(page), page).toBe(false);
    }
  });
});
