-- 複数メッセージ配信: 1配信で最大5メッセージオブジェクトを1発火送信できるようにする。
-- messages が NULL の行は従来どおり message_type / message_content の単一メッセージ経路を通り、
-- 挙動は一切変わらない (後方互換)。値は [{type,content,altText?}] の JSON 配列。
ALTER TABLE broadcasts ADD COLUMN messages TEXT CHECK (messages IS NULL OR json_valid(messages));
