// キーコードの発行履歴（migration 090・TB-1246）。書き込みは furim_customers のトリガーが行うので、ここは読むだけ。

/**
 * 置き換えられた古いキーコードの持ち主。持ち主がいま別のキーコードを持っているときだけ返す
 * （解約でキーコードが消えた人に「キーコードが更新されました」とは言わない）
 */
export async function findOwnerOfReplacedKeyCode(db: D1Database, keyCode: string): Promise<string | null> {
  try {
    const row = await db
      .prepare(
        `SELECT h.line_user_id FROM furim_key_code_history h
         JOIN furim_customers c ON c.line_user_id = h.line_user_id
         WHERE h.key_code = ? AND h.replaced_at IS NOT NULL AND COALESCE(c.key_code, '') <> '' AND c.key_code <> h.key_code
         ORDER BY h.id DESC LIMIT 1`,
      )
      .bind(keyCode)
      .first<{ line_user_id: string }>();
    return row?.line_user_id ?? null;
  } catch (err) {
    console.warn('[key-code-history] 履歴の参照に失敗（migration 090 未適用？）:', String(err));
    return null;
  }
}
