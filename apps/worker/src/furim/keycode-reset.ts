import { getFurimCustomer } from './customer-store.js';

// ===== キーコードリセットの返信文 =====
// 「紐づいた設定のリセットが完了しました。」だけでは何が起きて次に何をすべきか
// 伝わらない（2026-08-13 くろさん指摘）。何がリセットされ・何を入力し直すかを明示し、
// キーコードはコピーしやすいよう単体メッセージで続けて送る。
// リセットの実体は端末判定文字列（キーコードと端末の紐付け）のクリアのみで、
// キーコード自体・プラン・チケット残数は変わらない（GAS resetKeyCode.js）。

export function buildKeycodeResetMessages(keyCode: string | null): Array<{ type: 'text'; text: string }> {
  const explanation = [
    '✅ リセットが完了しました。',
    '',
    '■ リセットされたもの',
    'キーコードとお使いの端末（ブラウザ）の紐づけを解除しました。',
    'キーコード自体・ご契約プラン・チケット残数はそのまま残っています。',
    '',
    '■ お手数ですが次の対応をお願いいたします',
    keyCode
      ? '次のメッセージでお送りするキーコードをコピーして、拡張機能のキーコード欄にもう一度入力してください。'
      : 'リッチメニューの「キーコード発行」をタップしてキーコードを取得し、拡張機能のキーコード欄にもう一度入力してください。',
  ].join('\n');
  const messages: Array<{ type: 'text'; text: string }> = [{ type: 'text', text: explanation }];
  // キーコードはコピーしやすいよう単体メッセージで送る（LINEはメッセージ単位でしかコピーできない）
  if (keyCode) messages.push({ type: 'text', text: keyCode });
  return messages;
}

// 現在のキーコードを D1 furim_customers から取得する（Capsec #243: GAS getKeyCode は呼ばない）。
// 取れなくても呼び出し元はリセット完了の案内自体は返せるように null で返す
export async function fetchCurrentKeyCode(db: D1Database | undefined, lineUserId: string): Promise<string | null> {
  if (!db) return null;
  try {
    const c = await getFurimCustomer(db, lineUserId);
    const kc = (c?.key_code ?? '').trim();
    return kc || null;
  } catch (err) {
    console.warn('[keycode-reset] キーコード取得に失敗（案内はメニュー誘導にフォールバック）:', String(err));
    return null;
  }
}
