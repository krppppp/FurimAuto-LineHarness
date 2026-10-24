// FURIM_MODE=off の Worker（TB-2209・新 LINE「フリマ物販トレンド情報局」の line-harness-fmb）では、
// FurimAuto 専用の処理（友だち追加時の試用の書き込み・会員向けの cron・キーコード等のキーワード）を止める。
// 付けなければ今までどおり動く（FurimAuto 本番 line-harness-prod は付けない）
export function isFurimOff(env: { FURIM_MODE?: string } | undefined): boolean {
  return env?.FURIM_MODE === 'off';
}
