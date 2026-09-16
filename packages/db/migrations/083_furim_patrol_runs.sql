-- 巡回（収集・削除）の実行記録（Capsec #294・2026-09-17）。
--
-- 巡回は D1 に実行の記録が 1 つも無かった。そのため「キューが 2 件飛ぶ」事故が起きても、
-- こちらのデータからは何も読めない（拡張のコンソールに出て消える。Storage のセッションログは
-- 開いたタブの分しか無く 3 日で消える。症状が出るのは顧客の在庫管理シートだけで追えない）。
-- 直したあとに「効いているか」を確かめる手段が、記録を残すこと以外に無い。
--
-- 拡張が 1 回の巡回（販路ごとの収集／削除のひとまとまり）ごとに 1 行送る。
-- 取りこぼしそのものは furim_ext_errors の method='collectSkip' に残る（対になる記録）。
CREATE TABLE IF NOT EXISTS furim_patrol_runs (
  id TEXT PRIMARY KEY,
  dedupe_key TEXT UNIQUE,        -- 再送しても二重に入らないように
  line_user_id TEXT,
  key_code TEXT,
  queue TEXT NOT NULL,           -- 'collect'（売却の収集）| 'delete'（他販路の取り下げ）
  service TEXT,                  -- 販路（収集は販路ごと）
  planned INTEGER,               -- 予定していた件数
  processed INTEGER,             -- 実際に処理した件数
  skipped INTEGER,               -- 飛ばした件数
  found INTEGER,                 -- 収集: 見つけた売却済み件数 / 削除: 実際に取り下げた件数
  started_at TEXT,
  finished_at TEXT,
  client TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_furim_patrol_runs_created ON furim_patrol_runs(created_at);
CREATE INDEX IF NOT EXISTS idx_furim_patrol_runs_user ON furim_patrol_runs(line_user_id, created_at);
