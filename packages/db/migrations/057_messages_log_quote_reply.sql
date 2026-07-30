-- LINE「引用返信」対応。
-- quote_token: 受信テキストメッセージが持つ LINE の quoteToken（将来この受信メッセージに
--   引用返信する際に LINE Messaging API へ渡す）。
-- reply_to_message_id: 送信メッセージが引用返信の場合、引用元 messages_log.id への自己参照。
--   broadcast_id/scenario_step_id と同じ ON DELETE SET NULL パターン。
ALTER TABLE messages_log ADD COLUMN quote_token TEXT;
ALTER TABLE messages_log ADD COLUMN reply_to_message_id TEXT REFERENCES messages_log(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_log_reply_to_message_id ON messages_log (reply_to_message_id);
