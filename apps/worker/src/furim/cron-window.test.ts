import { describe, it, expect } from 'vitest';
import { isJstMinuteWindow } from './cron-window.js';

const at = (h: number, m: number, s = 0, ms = 0) => Date.UTC(2026, 8, 14, h - 9, m, s, ms);

describe('isJstMinuteWindow', () => {
  it(':30 の窓は :30:00〜:34:59.999', () => {
    expect(isJstMinuteWindow(at(13, 30), 30)).toBe(true);
    expect(isJstMinuteWindow(at(13, 31, 0, 300), 30)).toBe(true);
    expect(isJstMinuteWindow(at(13, 34, 59, 999), 30)).toBe(true);
    expect(isJstMinuteWindow(at(13, 29, 59, 999), 30)).toBe(false);
    expect(isJstMinuteWindow(at(13, 35), 30)).toBe(false);
  });

  it(':15 の窓は :15:00〜:19:59.999（:45 は通さない）', () => {
    expect(isJstMinuteWindow(at(13, 15, 48), 15)).toBe(true);
    expect(isJstMinuteWindow(at(13, 19, 59), 15)).toBe(true);
    expect(isJstMinuteWindow(at(13, 20), 15)).toBe(false);
    expect(isJstMinuteWindow(at(13, 45), 15)).toBe(false);
  });

  it('5 分 cron は発火の秒ずれがどこでも 1 時間に 1 回だけ通る', () => {
    for (const startMinute of [15, 30]) {
      for (let offset = 0; offset < 300_000; offset += 7_000) {
        let hits = 0;
        for (let i = 0; i < 12; i++) if (isJstMinuteWindow(at(13, 0) + offset + i * 300_000, startMinute)) hits++;
        expect(hits).toBe(1);
      }
    }
  });
});
