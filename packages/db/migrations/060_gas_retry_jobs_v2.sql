-- GAS再実行キューの汎用化（2026-08-14）。
-- インラインのGASリトライ廃止（非冪等メソッドの重複書き込み対策・よっしーさん3重行）に伴い、
-- 失敗した呼び出しをすべてこのキューで完遂させる。
-- call_type: 'get'（doGet）| 'post'（doPost）。POST系（setCustomerData等）も積めるようにする
-- reply_token: 完遂通知はreplyTokenを優先し、失効時のみpush（push月間上限の節約）
-- done_check: 実行前の「実行済みチェック」キー。GAS側はWorkerが見切っても完走することが
--             あるため、書き込み系は実行前に効果の有無を確認し、あればスキップする
ALTER TABLE gas_retry_jobs ADD COLUMN call_type TEXT NOT NULL DEFAULT 'get';
ALTER TABLE gas_retry_jobs ADD COLUMN reply_token TEXT;
ALTER TABLE gas_retry_jobs ADD COLUMN done_check TEXT;
