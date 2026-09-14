export const CRON_WINDOW_MINUTES = 5;

export function jstMinuteOf(now: number): number {
  return new Date(now + 9 * 60 * 60_000).getUTCMinutes();
}

export function isJstMinuteWindow(now: number, startMinute: number): boolean {
  const m = jstMinuteOf(now);
  return (m - startMinute + 60) % 60 < CRON_WINDOW_MINUTES;
}
