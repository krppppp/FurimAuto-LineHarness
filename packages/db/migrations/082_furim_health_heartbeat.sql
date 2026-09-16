-- 巡回そのものが止まったら気づける仕組み（Capsec #292・2026-09-17）。
--
-- 日次ヘルス巡回は 9/9 を最後に 1 週間止まり、誰も気づかなかった。気づくのが遅れると
-- 証拠も消える（Firebase Storage のセッションログは 3 日で削除。9/10〜9/13 は永久に追えない）。
--
-- 巡回は完走のたびにこの表へ心拍を 1 行 upsert し、Worker の 5 分 cron が古さを見て
-- 3 / 24 / 48 時間でスタッフの LINE に 1 通ずつ出す。見張りを Worker 側に置くのは、
-- 巡回が動く Mac が落ちていても鳴るようにするため。
CREATE TABLE IF NOT EXISTS furim_health_heartbeat (
  id TEXT PRIMARY KEY,                     -- 'patrol' 固定（将来ほかの定期処理を足せる）
  last_run_at TEXT NOT NULL,               -- 最後に完走した時刻（JST の ISO+09:00）
  mode TEXT,                               -- 'full' | 'summary' | 'patrol'
  detections INTEGER,                      -- その回の検知件数
  note TEXT,
  alert_level INTEGER NOT NULL DEFAULT 0,  -- 0=正常 1=3時間 2=24時間 3=48時間
  alerted_at TEXT
);
