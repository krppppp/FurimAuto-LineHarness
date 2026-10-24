-- 新 LINE の D1 line-crm-fmb の表の作り（TB-2209）
-- FurimAuto 本番 D1 line-crm-prod の sqlite_master を 2026-10-24 に読み取り（SELECT のみ）で写したもの。データは入っていない。
-- schema.sql ＋ migrations を番号順に流す手順（prod-build-runbook STEP 3）は、027 が schema.sql で先取りした friend_scenarios を
-- 作り直すため、1 文ずつ流すと day_zero_at が消える。新しい D1 はこのファイル 1 本で line-crm-prod と同じ作りにする。
-- この写しに入っている migration: 001〜091（ref_tracking.yclid まで）。092 以降を足したら、このファイルにも同じ文を足す
--   npx wrangler d1 execute line-crm-fmb --remote --file=../../scripts/data/fmb-000-schema.sql

CREATE TABLE friends (
  id               TEXT PRIMARY KEY,
  line_user_id     TEXT UNIQUE NOT NULL,
  display_name     TEXT,
  picture_url      TEXT,
  status_message   TEXT,
  is_following     INTEGER NOT NULL DEFAULT 1,
  user_id          TEXT,
  score            INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, ref_code TEXT, metadata TEXT NOT NULL DEFAULT '{}', line_account_id TEXT REFERENCES line_accounts(id), first_tracked_link_id TEXT REFERENCES tracked_links (id) ON DELETE SET NULL, ig_igsid TEXT, last_ref_code TEXT, last_ref_at TEXT, plan_name TEXT, picture_checked_at TEXT, last_message_at TEXT);
CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT UNIQUE NOT NULL,
  color      TEXT NOT NULL DEFAULT '#3B82F6',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE friend_tags (
  friend_id   TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  PRIMARY KEY (friend_id, tag_id)
);
CREATE TABLE scenarios (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('friend_add', 'tag_added', 'manual')),
  trigger_tag_id  TEXT REFERENCES tags (id) ON DELETE SET NULL,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT, delivery_mode TEXT NOT NULL DEFAULT 'relative' CHECK (delivery_mode IN ('relative', 'elapsed', 'absolute_time')));
CREATE TABLE messages_log (
  id               TEXT PRIMARY KEY,
  friend_id        TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  direction        TEXT NOT NULL CHECK (direction IN ('incoming', 'outgoing')),
  message_type     TEXT NOT NULL,
  content          TEXT NOT NULL,
  broadcast_id     TEXT REFERENCES broadcasts (id) ON DELETE SET NULL,
  scenario_step_id TEXT REFERENCES scenario_steps (id) ON DELETE SET NULL,
  delivery_type    TEXT CHECK (delivery_type IN ('push', 'reply')),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, template_id_at_send TEXT, source TEXT, line_account_id TEXT, quote_token TEXT, reply_to_message_id TEXT REFERENCES messages_log(id) ON DELETE SET NULL);
CREATE TABLE auto_replies (
  id               TEXT PRIMARY KEY,
  keyword          TEXT NOT NULL,
  match_type       TEXT NOT NULL CHECK (match_type IN ('exact', 'contains')) DEFAULT 'exact',
  response_type    TEXT NOT NULL DEFAULT 'text',
  response_content TEXT NOT NULL,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, template_id TEXT REFERENCES templates(id) ON DELETE SET NULL, line_account_id TEXT DEFAULT NULL);
CREATE TABLE admin_users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  email        TEXT,
  phone        TEXT,
  external_id  TEXT,
  display_name TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE line_accounts (
  id                   TEXT PRIMARY KEY,
  channel_id           TEXT NOT NULL UNIQUE,
  name                 TEXT NOT NULL,
  channel_access_token TEXT NOT NULL,
  channel_secret       TEXT NOT NULL,
  is_active            INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, login_channel_id TEXT, login_channel_secret TEXT, liff_id TEXT, token_expires_at TEXT, country TEXT, role TEXT, display_order INTEGER NOT NULL DEFAULT 0, og_site_name TEXT, og_default_image_url TEXT, og_default_description TEXT);
CREATE TABLE conversion_points (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  event_type TEXT NOT NULL,
  value      REAL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE conversion_events (
  id                  TEXT PRIMARY KEY,
  conversion_point_id TEXT NOT NULL REFERENCES conversion_points (id) ON DELETE CASCADE,
  friend_id           TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  user_id             TEXT,
  affiliate_code      TEXT,
  metadata            TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, affiliate_id TEXT REFERENCES affiliates(id), attributed_ref_code TEXT, approval_status TEXT
  CHECK (approval_status IN ('pending','approved','rejected')), approved_at TEXT);
CREATE TABLE affiliates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL UNIQUE,
  commission_rate REAL NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, friend_id TEXT REFERENCES friends(id));
CREATE TABLE affiliate_clicks (
  id           TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES affiliates (id) ON DELETE CASCADE,
  url          TEXT,
  ip_address   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE incoming_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'custom',
  secret      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE outgoing_webhooks (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  event_types TEXT NOT NULL DEFAULT '[]',
  secret      TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE google_calendar_connections (
  id            TEXT PRIMARY KEY,
  calendar_id   TEXT NOT NULL,
  access_token  TEXT,
  refresh_token TEXT,
  api_key       TEXT,
  auth_type     TEXT NOT NULL DEFAULT 'api_key',
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE calendar_bookings (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL REFERENCES google_calendar_connections (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_id       TEXT,
  title          TEXT NOT NULL,
  start_at       TEXT NOT NULL,
  end_at         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'completed')),
  metadata       TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE reminders (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);
CREATE TABLE reminder_steps (
  id              TEXT PRIMARY KEY,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  offset_minutes  INTEGER NOT NULL,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE friend_reminders (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  reminder_id     TEXT NOT NULL REFERENCES reminders (id) ON DELETE CASCADE,
  target_date     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE friend_reminder_deliveries (
  id                TEXT PRIMARY KEY,
  friend_reminder_id TEXT NOT NULL REFERENCES friend_reminders (id) ON DELETE CASCADE,
  reminder_step_id  TEXT NOT NULL REFERENCES reminder_steps (id) ON DELETE CASCADE,
  delivered_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (friend_reminder_id, reminder_step_id)
);
CREATE TABLE scoring_rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  score_value INTEGER NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE friend_scores (
  id              TEXT PRIMARY KEY,
  friend_id       TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scoring_rule_id TEXT REFERENCES scoring_rules (id) ON DELETE SET NULL,
  score_change    INTEGER NOT NULL,
  reason          TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE operators (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  role       TEXT NOT NULL DEFAULT 'operator' CHECK (role IN ('admin', 'operator')),
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE chats (
  id            TEXT PRIMARY KEY,
  friend_id     TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  operator_id   TEXT REFERENCES operators (id) ON DELETE SET NULL,
  status        TEXT NOT NULL DEFAULT 'unread' CHECK (status IN ('unread', 'in_progress', 'resolved')),
  notes         TEXT,
  last_message_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);
CREATE TABLE notification_rules (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  event_type   TEXT NOT NULL,
  conditions   TEXT NOT NULL DEFAULT '{}',
  channels     TEXT NOT NULL DEFAULT '["webhook"]',
  is_active    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE notifications (
  id              TEXT PRIMARY KEY,
  rule_id         TEXT REFERENCES notification_rules (id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL,
  channel         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  metadata        TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE stripe_events (
  id               TEXT PRIMARY KEY,
  stripe_event_id  TEXT NOT NULL UNIQUE,
  event_type       TEXT NOT NULL,
  friend_id        TEXT REFERENCES friends (id) ON DELETE SET NULL,
  amount           REAL,
  currency         TEXT,
  metadata         TEXT,
  processed_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, payload TEXT, status TEXT NOT NULL DEFAULT 'completed', attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, last_attempt_at TEXT, completed_at TEXT);
CREATE TABLE account_health_logs (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  error_code      INTEGER,
  error_count     INTEGER NOT NULL DEFAULT 0,
  check_period    TEXT NOT NULL,
  risk_level      TEXT NOT NULL DEFAULT 'normal' CHECK (risk_level IN ('normal', 'warning', 'danger')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE account_migrations (
  id               TEXT PRIMARY KEY,
  from_account_id  TEXT NOT NULL,
  to_account_id    TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'failed')),
  migrated_count   INTEGER NOT NULL DEFAULT 0,
  total_count      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  completed_at     TEXT
);
CREATE TABLE automations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  event_type  TEXT NOT NULL,
  conditions  TEXT NOT NULL DEFAULT '{}',
  actions     TEXT NOT NULL DEFAULT '[]',
  is_active   INTEGER NOT NULL DEFAULT 1,
  priority    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, line_account_id TEXT);
CREATE TABLE automation_logs (
  id             TEXT PRIMARY KEY,
  automation_id  TEXT NOT NULL REFERENCES automations (id) ON DELETE CASCADE,
  friend_id      TEXT REFERENCES friends (id) ON DELETE SET NULL,
  event_data     TEXT,
  actions_result TEXT,
  status         TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'partial', 'failed')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE ad_platforms (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  display_name TEXT,
  config       TEXT NOT NULL DEFAULT '{}',
  is_active    INTEGER DEFAULT 1,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE ad_conversion_logs (
  id                  TEXT PRIMARY KEY,
  ad_platform_id      TEXT NOT NULL,
  friend_id           TEXT NOT NULL,
  conversion_point_id TEXT,
  event_name          TEXT NOT NULL,
  click_id            TEXT,
  click_id_type       TEXT,
  status              TEXT DEFAULT 'pending',
  request_body        TEXT,
  response_body       TEXT,
  error_message       TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE staff_members (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'staff')),
  api_key    TEXT UNIQUE NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE entry_routes (
  id          TEXT PRIMARY KEY,
  ref_code    TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  tag_id      TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  redirect_url TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
, pool_id TEXT REFERENCES traffic_pools (id) ON DELETE SET NULL, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, run_account_friend_add_scenarios INTEGER NOT NULL DEFAULT 1);
CREATE TABLE ref_tracking (
  id              TEXT PRIMARY KEY,
  ref_code        TEXT NOT NULL,
  friend_id       TEXT REFERENCES friends (id) ON DELETE CASCADE,
  entry_route_id  TEXT REFERENCES entry_routes (id) ON DELETE SET NULL,
  source_url      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
, fbclid TEXT, gclid TEXT, twclid TEXT, ttclid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, user_agent TEXT, ip_address TEXT, lp_session_id TEXT, utm_content TEXT, utm_term TEXT, gbraid TEXT, wbraid TEXT, yclid TEXT);
CREATE TABLE tracked_links (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  original_url TEXT NOT NULL,
  tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, intro_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, reward_template_id TEXT REFERENCES message_templates (id) ON DELETE SET NULL, og_title TEXT, og_description TEXT, og_image_url TEXT, line_account_id TEXT REFERENCES line_accounts(id) ON DELETE SET NULL, short_code TEXT);
CREATE TABLE link_clicks (
  id TEXT PRIMARY KEY,
  tracked_link_id TEXT NOT NULL REFERENCES tracked_links (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  clicked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE forms (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  fields TEXT NOT NULL DEFAULT '[]',
  on_submit_tag_id TEXT REFERENCES tags (id) ON DELETE SET NULL,
  on_submit_scenario_id TEXT REFERENCES scenarios (id) ON DELETE SET NULL,
  save_to_metadata INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  submit_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
, on_submit_message_type TEXT CHECK (on_submit_message_type IN ('text', 'flex')) DEFAULT NULL, on_submit_message_content TEXT DEFAULT NULL, on_submit_webhook_url TEXT, on_submit_webhook_headers TEXT, on_submit_webhook_fail_message TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT);
CREATE TABLE form_submissions (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  friend_id TEXT REFERENCES friends (id) ON DELETE SET NULL,
  data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE "scenario_steps" (
  id              TEXT PRIMARY KEY,
  scenario_id     TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  step_order      INTEGER NOT NULL,
  delay_minutes   INTEGER NOT NULL DEFAULT 0,
  condition_type  TEXT,
  condition_value TEXT,
  next_step_on_false INTEGER,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video')),
  message_content TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), template_id TEXT REFERENCES templates (id) ON DELETE SET NULL, trigger_condition TEXT, offset_days INTEGER, offset_minutes INTEGER, delivery_time TEXT, on_reach_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  UNIQUE (scenario_id, step_order)
);
CREATE TABLE automation_actions (
  id          TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  step_order  INTEGER NOT NULL DEFAULT 0,
  action_type TEXT NOT NULL,
  params      TEXT NOT NULL DEFAULT '{}',  -- JSON
  condition_json TEXT,                     -- JSON or NULL: このアクションを実行する条件
  on_error    TEXT NOT NULL DEFAULT 'continue' CHECK (on_error IN ('continue', 'abort')),
  is_active   INTEGER NOT NULL DEFAULT 1,
  label       TEXT,                        -- UIに表示する任意ラベル
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
, template_id TEXT REFERENCES templates (id) ON DELETE SET NULL);
CREATE TABLE messages (
  id           TEXT PRIMARY KEY,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video')),
  content      TEXT NOT NULL,
  alt_text     TEXT,
  tags         TEXT NOT NULL DEFAULT '[]',
  label        TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE template_messages (
  id          TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL REFERENCES messages (id) ON DELETE RESTRICT,
  step_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (template_id, step_order)
);
CREATE TABLE "templates" (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  category        TEXT NOT NULL DEFAULT 'general',
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'carousel', 'video')),
  message_content TEXT NOT NULL,
  categories      TEXT NOT NULL DEFAULT '[]',
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE account_settings (
  id              TEXT PRIMARY KEY,
  line_account_id TEXT NOT NULL,
  key             TEXT NOT NULL,
  value           TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE(line_account_id, key)
);
CREATE TABLE broadcast_insights (
  id                  TEXT PRIMARY KEY,
  broadcast_id        TEXT NOT NULL REFERENCES broadcasts(id) ON DELETE CASCADE,
  delivered           INTEGER,
  unique_impression   INTEGER,
  unique_click        INTEGER,
  unique_media_played INTEGER,
  open_rate           REAL,
  click_rate          REAL,
  raw_response        TEXT,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  retry_count         INTEGER NOT NULL DEFAULT 0,
  fetched_at          TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE message_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'flex')),
  message_content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE pool_accounts (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES traffic_pools(id) ON DELETE CASCADE,
  line_account_id TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(pool_id, line_account_id)
);
CREATE TABLE menus (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  name                  TEXT NOT NULL,
  category_label        TEXT,
  description           TEXT,
  duration_minutes      INTEGER NOT NULL,
  buffer_after_minutes  INTEGER NOT NULL DEFAULT 0,
  base_price            INTEGER NOT NULL,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  is_active             INTEGER NOT NULL DEFAULT 1,
  deleted_at            TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), auto_tag_id TEXT REFERENCES tags(id) ON DELETE SET NULL,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);
CREATE TABLE staff (
  id                       TEXT PRIMARY KEY,
  line_account_id          TEXT NOT NULL,
  name                     TEXT NOT NULL,
  display_name             TEXT NOT NULL,
  role                     TEXT,
  profile_image_url        TEXT,
  bio                      TEXT,
  sort_order               INTEGER NOT NULL DEFAULT 0,
  is_designation_optional  INTEGER NOT NULL DEFAULT 0,
  is_active                INTEGER NOT NULL DEFAULT 1,
  deleted_at               TEXT,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);
CREATE TABLE staff_menus (
  staff_id                  TEXT NOT NULL,
  menu_id                   TEXT NOT NULL,
  is_offered                INTEGER NOT NULL DEFAULT 1,
  override_duration_minutes INTEGER,
  override_price            INTEGER,
  PRIMARY KEY (staff_id, menu_id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id)
);
CREATE TABLE staff_shifts (
  id          TEXT PRIMARY KEY,
  staff_id    TEXT NOT NULL,
  work_date   TEXT NOT NULL,    -- YYYY-MM-DD (JST)
  start_time  TEXT NOT NULL,    -- HH:MM (JST)
  end_time    TEXT NOT NULL,    -- HH:MM (JST)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (staff_id, work_date),
  FOREIGN KEY (staff_id) REFERENCES staff(id)
);
CREATE TABLE bookings (
  id                      TEXT PRIMARY KEY,
  line_account_id         TEXT NOT NULL,
  friend_id               TEXT NOT NULL,        -- friends.id
  staff_id                TEXT NOT NULL,
  menu_id                 TEXT NOT NULL,
  starts_at               TEXT NOT NULL,        -- UTC ISO8601 (Z)
  ends_at                 TEXT NOT NULL,        -- UTC ISO8601 (Z)
  block_ends_at           TEXT NOT NULL,        -- ends_at + buffer_after。衝突判定
  status                  TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','expired','cancelled','completed','no_show')),
  customer_note           TEXT,
  internal_note           TEXT,
  price_at_booking        INTEGER NOT NULL,
  requested_at            TEXT NOT NULL,        -- UTC ISO8601
  decided_at              TEXT,                 -- UTC ISO8601
  decided_by_staff_id     TEXT,
  external_event_id       TEXT,                 -- Phase 3 余地 (Google Calendar)
  external_calendar_id    TEXT,                 -- Phase 3 余地
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id),
  FOREIGN KEY (staff_id) REFERENCES staff(id),
  FOREIGN KEY (menu_id) REFERENCES menus(id)
);
CREATE TABLE booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL                  -- UTC ISO8601
);
CREATE TABLE booking_reminders (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,                                -- UTC ISO8601
  sent_at       TEXT,                                         -- UTC ISO8601
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  FOREIGN KEY (booking_id) REFERENCES bookings(id)
);
CREATE TABLE rich_menu_groups (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES line_accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  chat_bar_text      TEXT NOT NULL,
  size               TEXT NOT NULL CHECK (size IN ('large','compact')),
  default_page_id    TEXT,
  is_default_for_all INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  publishing_at      TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE rich_menu_pages (
  id                 TEXT PRIMARY KEY,
  group_id           TEXT NOT NULL REFERENCES rich_menu_groups(id) ON DELETE CASCADE,
  order_index        INTEGER NOT NULL,
  name               TEXT NOT NULL,
  alias_id           TEXT NOT NULL,
  line_richmenu_id   TEXT,
  image_r2_key       TEXT,
  image_content_type TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  UNIQUE (group_id, order_index)
);
CREATE TABLE rich_menu_areas (
  id              TEXT PRIMARY KEY,
  page_id         TEXT NOT NULL REFERENCES rich_menu_pages(id) ON DELETE CASCADE,
  bounds_x        INTEGER NOT NULL,
  bounds_y        INTEGER NOT NULL,
  bounds_width    INTEGER NOT NULL,
  bounds_height   INTEGER NOT NULL,
  action_type     TEXT NOT NULL CHECK (action_type IN ('uri','message','postback','richmenuswitch')),
  action_data     TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
);
CREATE TABLE traffic_pools (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  active_account_id TEXT NOT NULL REFERENCES line_accounts(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE form_opens (
  id TEXT PRIMARY KEY,
  form_id TEXT NOT NULL,
  friend_id TEXT,
  friend_name TEXT,
  opened_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE events (
  id                            TEXT PRIMARY KEY,
  line_account_id               TEXT NOT NULL,
  name                          TEXT NOT NULL,
  venue_name                    TEXT,
  venue_url                     TEXT,
  image_url                     TEXT,
  description                   TEXT,
  description_centered          INTEGER NOT NULL DEFAULT 0,
  max_bookings_per_friend       INTEGER,
  requires_approval             INTEGER NOT NULL DEFAULT 0,
  cancel_deadline_hours_before  INTEGER,
  reminder_day_before_enabled   INTEGER NOT NULL DEFAULT 1,
  reminder_hours_before         INTEGER,
  is_published                  INTEGER NOT NULL DEFAULT 0,
  folder_id                     TEXT,
  sort_order                    INTEGER NOT NULL DEFAULT 0,
  deleted_at                    TEXT,
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), target_type TEXT NOT NULL DEFAULT 'single'
  CHECK (target_type IN ('single', 'multi-account-dedup')), account_ids TEXT
  CHECK (account_ids IS NULL OR json_valid(account_ids)), dedup_priority TEXT
  CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)), failed_account_ids TEXT
  CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)), confirmation_message_extra TEXT, reminder_message_extra TEXT, og_title TEXT, og_description TEXT, og_image_url TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id)
);
CREATE TABLE event_slots (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  capacity    INTEGER,
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  deleted_at  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  FOREIGN KEY (event_id) REFERENCES events(id)
);
CREATE TABLE event_bookings (
  id                    TEXT PRIMARY KEY,
  line_account_id       TEXT NOT NULL,
  event_id              TEXT NOT NULL,
  slot_id               TEXT NOT NULL,
  friend_id             TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN ('requested','confirmed','rejected','cancelled','expired','no_show','attended')),
  customer_note         TEXT,
  internal_note         TEXT,
  requested_at          TEXT NOT NULL,
  decided_at            TEXT,
  decided_by_staff_id   TEXT,
  cancelled_at          TEXT,
  cancelled_by          TEXT CHECK (cancelled_by IN ('friend','admin','system')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), identity_key TEXT,
  FOREIGN KEY (line_account_id) REFERENCES line_accounts(id),
  FOREIGN KEY (event_id) REFERENCES events(id),
  FOREIGN KEY (slot_id) REFERENCES event_slots(id),
  FOREIGN KEY (friend_id) REFERENCES friends(id)
);
CREATE TABLE event_booking_reminders (
  id            TEXT PRIMARY KEY,
  booking_id    TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('day_before','hours_before')),
  scheduled_at  TEXT NOT NULL,
  sent_at       TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','failed_permanent','cancelled')),
  retry_count   INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  FOREIGN KEY (booking_id) REFERENCES event_bookings(id)
);
CREATE TABLE event_booking_idempotency_keys (
  key              TEXT PRIMARY KEY,
  line_account_id  TEXT NOT NULL,
  friend_id        TEXT NOT NULL,
  response_status  INTEGER NOT NULL,
  response_body    TEXT NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  expires_at       TEXT NOT NULL
);
CREATE TABLE update_history (
  id                          TEXT PRIMARY KEY,
  started_at                  INTEGER NOT NULL,
  completed_at                INTEGER,
  from_version                TEXT NOT NULL,
  to_version                  TEXT NOT NULL,
  status                      TEXT NOT NULL CHECK (status IN ('running','success','failed','rolled_back')),
  snapshot_worker_url         TEXT,
  snapshot_admin_deployment   TEXT,
  snapshot_liff_deployment    TEXT,
  events_jsonl                TEXT NOT NULL DEFAULT '',
  error                       TEXT,
  rollback_of                 TEXT REFERENCES update_history(id),
  rollback_expires_at         INTEGER
);
CREATE TABLE plan_builder_intents (
  id           TEXT PRIMARY KEY,            -- 申込コード（PB-XXXXXX）
  line_user_id TEXT NOT NULL,
  payload      TEXT NOT NULL,               -- JSON: { packages, features, multiChannelSites, total }
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  used_at      TEXT                         -- Checkout発行済みなら日時
, stage TEXT, error TEXT, updated_at TEXT, notified_at TEXT);
CREATE TABLE push_subscriptions (
  id               TEXT PRIMARY KEY,
  staff_member_id  TEXT NOT NULL,
  endpoint         TEXT NOT NULL UNIQUE,
  p256dh           TEXT NOT NULL,
  auth             TEXT NOT NULL,
  user_agent       TEXT,
  created_at       TEXT NOT NULL,
  last_used_at     TEXT
);
CREATE TABLE affiliate_links (
  id              TEXT PRIMARY KEY,
  affiliate_id    TEXT NOT NULL REFERENCES affiliates(id),
  ref_code        TEXT NOT NULL UNIQUE,
  label           TEXT,
  line_account_id TEXT REFERENCES line_accounts(id),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  click_count     INTEGER NOT NULL DEFAULT 0
, offer_id TEXT REFERENCES affiliate_offers(id));
CREATE TABLE affiliate_offers (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  description     TEXT,
  reward_amount   INTEGER NOT NULL DEFAULT 0,   -- 円/成約（固定額）
  line_account_id TEXT REFERENCES line_accounts(id),
  tag_id          TEXT REFERENCES tags(id),
  scenario_id     TEXT REFERENCES scenarios(id),
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL
);
CREATE TABLE coupon_notifications (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  subscription_id    TEXT NOT NULL,
  coupon_id          TEXT NOT NULL,
  coupon_name        TEXT,
  message            TEXT NOT NULL,
  send_after         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled', 'skipped')),
  created_at         TEXT NOT NULL,
  sent_at            TEXT
);
CREATE TABLE stripe_processed_actions (
  stripe_event_id TEXT NOT NULL,
  action_key      TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')), status TEXT NOT NULL DEFAULT 'done', retry_key TEXT,
  PRIMARY KEY (stripe_event_id, action_key)
);
CREATE TABLE "friend_scenarios" (
  id                 TEXT PRIMARY KEY,
  friend_id          TEXT NOT NULL REFERENCES friends (id) ON DELETE CASCADE,
  scenario_id        TEXT NOT NULL REFERENCES scenarios (id) ON DELETE CASCADE,
  current_step_order INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed', 'delivering')) DEFAULT 'active',
  started_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  next_delivery_at   TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours'))
, day_zero_at TEXT);
CREATE TABLE gas_retry_jobs (
  id TEXT PRIMARY KEY,
  line_user_id TEXT NOT NULL,
  method TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  notify_message TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
, call_type TEXT NOT NULL DEFAULT 'get', reply_token TEXT, done_check TEXT, dedupe_key TEXT, max_attempts INTEGER NOT NULL DEFAULT 5);
CREATE TABLE lp_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  page TEXT NOT NULL,
  event_type TEXT NOT NULL,
  max_scroll_pct INTEGER,
  ms_on_page INTEGER,
  ref TEXT,
  has_click_id INTEGER DEFAULT 0,
  utm_campaign TEXT,
  utm_content TEXT,
  is_mobile INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
, referrer TEXT, utm_term TEXT, detail TEXT);
CREATE TABLE "broadcasts" (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  message_type    TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'flex', 'video')),
  message_content TEXT NOT NULL,
  target_type     TEXT NOT NULL CHECK (target_type IN ('all', 'tag')) DEFAULT 'all',
  target_tag_id   TEXT REFERENCES tags (id) ON DELETE SET NULL,
  status          TEXT NOT NULL CHECK (status IN ('draft', 'scheduled', 'sending', 'sent')) DEFAULT 'draft',
  scheduled_at    TEXT,
  sent_at         TEXT,
  total_count     INTEGER NOT NULL DEFAULT 0,
  success_count   INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now', '+9 hours')),
  line_account_id TEXT,
  alt_text        TEXT,
  line_request_id TEXT,
  aggregation_unit TEXT,
  batch_offset    INTEGER NOT NULL DEFAULT 0,
  segment_conditions TEXT,
  account_ids     TEXT CHECK (account_ids IS NULL OR json_valid(account_ids)),
  dedup_priority  TEXT CHECK (dedup_priority IS NULL OR json_valid(dedup_priority)),
  failed_account_ids TEXT CHECK (failed_account_ids IS NULL OR json_valid(failed_account_ids)),
  dedup_progress  TEXT CHECK (dedup_progress IS NULL OR json_valid(dedup_progress)),
  batch_lock_at   TEXT,
  track_links     INTEGER NOT NULL DEFAULT 1,
  messages        TEXT CHECK (messages IS NULL OR json_valid(messages))
);
CREATE TABLE furim_customers (
  line_user_id       TEXT PRIMARY KEY,
  stripe_customer_id TEXT,
  key_code           TEXT,
  key_code_issued    INTEGER NOT NULL DEFAULT 0,  -- シート「初回発行」
  device_activated   INTEGER NOT NULL DEFAULT 0,  -- シート「端末判定文字列」が非空
  survey_answer      TEXT,                        -- シート「アンケート回答」
  free30_ticket      INTEGER NOT NULL DEFAULT 0,  -- シート「Free30チケット」
  youtube_coupon     TEXT,                        -- シート「Youtubeクーポン」
  extend_keyword     TEXT,                        -- シート「延長キーワード」 '1w' | '3d' | '対象外'
  sheet_synced_at    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
, subscription_id TEXT, subscription_start_at TEXT, subscription_end_at TEXT, subscription_price INTEGER, plan_label TEXT, packages TEXT, features TEXT, multi_channel_sites TEXT, subscription_source TEXT, copy_tickets INTEGER, mercari_url TEXT, device_code TEXT, shops_url TEXT, rakuma_url TEXT, yahoo_flea_url TEXT, inventory_sheet_url TEXT, inventory_sheet_created_at TEXT, ext_last_seen_at TEXT, gas_last_seen_at TEXT);
CREATE TABLE furim_sync_diffs (
  id            TEXT PRIMARY KEY,
  line_user_id  TEXT NOT NULL,
  field         TEXT NOT NULL,    -- 列名 or 'row_missing_in_d1' / 'row_missing_in_sheet'
  d1_value      TEXT,
  sheet_value   TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  notified_at   TEXT,
  resolved_at   TEXT
);
CREATE TABLE furim_feature_flags (
  line_user_id TEXT NOT NULL,
  feature_key  TEXT NOT NULL,
  value        TEXT NOT NULL,      -- '1' / '0' / 'メルカリ/ラクマ'
  source       TEXT,               -- 'plan' | 'promo' | 'always_enabled' | 'manual' | 'sheet'
  updated_at   TEXT NOT NULL, locked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (line_user_id, feature_key)
);
CREATE TABLE furim_payments (
  invoice_id          TEXT PRIMARY KEY,
  stripe_event_id     TEXT,
  line_user_id        TEXT,
  stripe_customer_id  TEXT,
  subscription_id     TEXT,
  plan_name           TEXT,
  billing_reason      TEXT,
  subscription_price  INTEGER,
  discount_amount     INTEGER,
  price_excl_tax      INTEGER,
  tax_amount          INTEGER,
  actual_paid_amount  INTEGER,
  customer_email      TEXT,
  paid_at             TEXT,
  created_at          TEXT NOT NULL
);
CREATE TABLE furim_ticket_ledger (
  id                 TEXT PRIMARY KEY,
  line_user_id       TEXT NOT NULL,
  delta              INTEGER NOT NULL,
  reason             TEXT NOT NULL,        -- 'purchase' | 'premium_monthly' | 'free30' | 'consume' | 'manual' | 'sheet_backfill'
  idempotency_key    TEXT NOT NULL UNIQUE,
  payment_intent_id  TEXT,
  amount             INTEGER,
  currency           TEXT,
  created_at         TEXT NOT NULL
);
CREATE TABLE furim_cancellations (
  id               TEXT PRIMARY KEY,
  line_user_id     TEXT,
  stripe_event_id  TEXT UNIQUE,
  subscription_id  TEXT,
  plan_name        TEXT,
  mercari_url      TEXT,
  canceled_at      TEXT NOT NULL
, display_name TEXT, side_job_judgment TEXT, reason_code TEXT, reason_text TEXT, reason_answered_at TEXT);
CREATE TABLE furim_referrals (
  id                    TEXT PRIMARY KEY,
  affiliate_id          TEXT NOT NULL,
  ambassador_friend_id  TEXT,
  introduced_friend_id  TEXT NOT NULL,
  ref_code              TEXT,             -- URL 経由なら affiliate_links.ref_code
  source                TEXT NOT NULL,    -- 'url' | 'keyword' | 'retry' | 'sheet_backfill'
  ambassador_plan_name  TEXT,
  reward_coupon_name    TEXT,             -- NULL = 10 枚上限 or 解決不能
  reward_coupon_id      TEXT,
  reward_applied_at     TEXT,
  introduced_coupon_id  TEXT,
  trial_extended_days   INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL
);
CREATE TABLE furim_coupons (
  name       TEXT PRIMARY KEY,
  coupon_id  TEXT NOT NULL,
  is_active  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE furim_master (
  kind            TEXT NOT NULL,   -- 'feature' | 'package' | 'plan' | 'ticket_price'
  key             TEXT NOT NULL,
  display_name    TEXT,
  stripe_price_id TEXT,
  monthly_price   INTEGER,
  active          INTEGER NOT NULL DEFAULT 1,
  payload         TEXT NOT NULL,   -- 行全体の JSON
  fetched_at      TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE TABLE furim_admin_audit (
  id           TEXT PRIMARY KEY,
  staff_id     TEXT NOT NULL,
  staff_name   TEXT NOT NULL,
  table_name   TEXT NOT NULL,
  row_id       TEXT NOT NULL,
  column_name  TEXT NOT NULL,
  old_value    TEXT,
  new_value    TEXT,
  created_at   TEXT NOT NULL
);
CREATE TABLE furim_execution_logs (
  id                        TEXT PRIMARY KEY,
  line_user_id              TEXT,
  key_code                  TEXT,
  service                   TEXT,
  account_url               TEXT,
  mypage_info_updated_date  TEXT,
  count_rating              TEXT,
  sales_amount              TEXT,
  total_target_count        TEXT,
  options                   TEXT,
  dedupe_key                TEXT NOT NULL UNIQUE,
  client                    TEXT,
  payload                   TEXT NOT NULL,
  created_at                TEXT NOT NULL
);
CREATE TABLE furim_ext_errors (
  id                   TEXT PRIMARY KEY,
  line_user_id         TEXT,
  key_code             TEXT,
  method               TEXT NOT NULL,
  error                TEXT NOT NULL,
  mercari_url          TEXT,
  discrimination_code  TEXT,
  client               TEXT,
  created_at           TEXT NOT NULL
);
CREATE TABLE furim_free_accounts (
  install_id          TEXT PRIMARY KEY,
  mercari_url         TEXT,
  rakuma_url          TEXT,
  yahoo_flea_url      TEXT,
  yahoo_auction_url   TEXT,
  shops_url           TEXT,
  key_code            TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE TABLE furim_manual_copy_logs (
  id             TEXT PRIMARY KEY,
  dedupe_key     TEXT NOT NULL UNIQUE,
  install_id     TEXT,
  key_code       TEXT,
  line_user_id   TEXT,
  item_id        TEXT,
  item_name      TEXT,
  target         TEXT,
  status         TEXT NOT NULL,   -- '開始' | '出品完了' | '未完了(期限切れ)'
  target_url     TEXT,
  source_url     TEXT,
  started_at     TEXT NOT NULL,
  completed_at   TEXT,
  created_at     TEXT NOT NULL
);
CREATE TABLE furim_shop_research_logs (
  id              TEXT PRIMARY KEY,
  dedupe_key      TEXT NOT NULL UNIQUE,
  install_id      TEXT,
  key_code        TEXT,
  line_user_id    TEXT,
  my_mercari_url  TEXT,
  target_url      TEXT NOT NULL,
  is_free         INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL
);
CREATE TABLE furim_survey_answers (
  id            TEXT PRIMARY KEY,
  line_user_id  TEXT NOT NULL,
  display_name  TEXT,
  answer        TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
CREATE TABLE furim_coupon_applications (
  id                  TEXT PRIMARY KEY,
  line_user_id        TEXT NOT NULL,
  stripe_customer_id  TEXT,
  coupon_name         TEXT NOT NULL,
  coupon_id           TEXT,
  route               TEXT NOT NULL,   -- 'Furiman経由' 等
  created_at          TEXT NOT NULL
);
CREATE TABLE furim_auto_copy_logs (
  id                 TEXT PRIMARY KEY,     -- 行ハッシュ
  line_user_id       TEXT,                 -- LINE表示名が顧客 1 人に一意に当たる時だけ解決
  display_name       TEXT,                 -- LINE表示名
  source_url         TEXT,                 -- コピー元URL
  target_url         TEXT,                 -- コピー出品先URL
  remaining_tickets  INTEGER,              -- 残チケット数
  processed_at       TEXT NOT NULL,        -- 処理日時
  imported_at        TEXT NOT NULL
, delta INTEGER, idempotency_key TEXT);
CREATE TABLE furim_referral_cashbacks (
  id                        TEXT PRIMARY KEY,   -- 行ハッシュ
  occurred_at               TEXT NOT NULL,      -- 日時
  introduced_display_name   TEXT,               -- LINE表示名(友)
  introduced_line_user_id   TEXT,               -- Stripe顧客ID → furim_customers で解決
  stripe_customer_id        TEXT,               -- Stripe顧客ID（友）
  price                     INTEGER,            -- 価格
  ambassador_display_name   TEXT,               -- LINE表示名(ア)
  ambassador_line_user_id   TEXT,               -- LINE_ID（ア）
  cashback_amount           INTEGER,            -- キャッシュバック金額
  imported_at               TEXT NOT NULL
);
CREATE TABLE furim_customers_dropped_cols_20260914(
  line_user_id TEXT,
  plan_label_legacy TEXT,
  last_invoice_id TEXT,
  subscription_status TEXT,
  customer_email TEXT,
  backed_up_at
);
CREATE TABLE furim_ticket_ledger_dropped_cols_20260914(
  idempotency_key TEXT,
  source_url TEXT,
  target_url TEXT,
  invoice_id TEXT,
  backed_up_at
);
CREATE TABLE furim_customers_dropped_cols2_20260914(
  line_user_id TEXT,
  canceled_at TEXT,
  backed_up_at
);
CREATE TABLE furim_master_deleted_plans_20260914(
  kind TEXT,
  "key" TEXT,
  display_name TEXT,
  stripe_price_id TEXT,
  monthly_price INT,
  active INT,
  payload TEXT,
  fetched_at TEXT
);
CREATE TABLE furim_ad_spend (
  date TEXT NOT NULL,            -- JST の YYYY-MM-DD
  source TEXT NOT NULL,          -- 'google'（将来 'meta' など）
  campaign_id TEXT NOT NULL,
  campaign_name TEXT,
  cost_yen INTEGER NOT NULL,     -- 円（cost_micros / 1000000 を四捨五入）
  clicks INTEGER,
  impressions INTEGER,
  imported_at TEXT NOT NULL,     -- 取り込み時刻（JST の ISO+09:00）
  PRIMARY KEY (date, source, campaign_id)
);
CREATE TABLE furim_anomaly_acks (
  kind TEXT NOT NULL,              -- 異常の種類（gas_retry_pending など）
  ack_key TEXT NOT NULL DEFAULT '', -- 同じ種類で個別に確認したいときの識別子。既定は種類ごと 1 行
  acked_at TEXT NOT NULL,          -- 確認した日時（JST の ISO+09:00）
  acked_by TEXT NOT NULL,          -- 確認した人（スタッフ名）
  acked_by_id TEXT,                -- スタッフID
  count_at_ack INTEGER NOT NULL,   -- 確認したときの件数
  first_seen_at_ack TEXT,          -- 確認したときの初回検知
  note TEXT,
  PRIMARY KEY (kind, ack_key)
);
CREATE TABLE furim_ops_log (
  id TEXT PRIMARY KEY,
  acted_at TEXT NOT NULL,        -- 実行日時（JST の ISO+09:00）
  actor TEXT NOT NULL,           -- 実行した人（例: 権限管理課）
  action TEXT NOT NULL,          -- 何をしたか（例: mark_completed）
  target TEXT NOT NULL,          -- 対象（例: stripe_processed_actions）
  target_count INTEGER NOT NULL, -- 件数
  goal TEXT,                     -- 根拠のゴール（例: Capsec #287）
  note TEXT                      -- なぜそうしたか
);
CREATE TABLE furim_health_notices (
  line_user_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- 'loop_stuck' など案内の種類
  friend_id TEXT,
  display_name TEXT,
  last_notified_at TEXT NOT NULL,  -- JST の ISO+09:00
  detail TEXT,                     -- 送った時点の根拠（stuck 件数など）
  PRIMARY KEY (line_user_id, kind)
);
CREATE TABLE furim_health_acks (
  event_id TEXT PRIMARY KEY,       -- 事象ID（例 #0818-3）
  event_key TEXT,                  -- 事象キー（例 mochi me×STALL）
  state TEXT NOT NULL,             -- 'done' | 'in_progress' | 'ignore'
  acked_at TEXT NOT NULL,          -- 申告を拾った時刻（JST の ISO+09:00）
  silence_until TEXT,              -- サイレンスの終わり（JST の ISO+09:00）
  source TEXT,                     -- 'line' など、どこで拾ったか
  note TEXT
);
CREATE TABLE furim_health_heartbeat (
  id TEXT PRIMARY KEY,                     -- 'patrol' 固定（将来ほかの定期処理を足せる）
  last_run_at TEXT NOT NULL,               -- 最後に完走した時刻（JST の ISO+09:00）
  mode TEXT,                               -- 'full' | 'summary' | 'patrol'
  detections INTEGER,                      -- その回の検知件数
  note TEXT,
  alert_level INTEGER NOT NULL DEFAULT 0,  -- 0=正常 1=3時間 2=24時間 3=48時間
  alerted_at TEXT
);
CREATE TABLE furim_patrol_runs (
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
CREATE TABLE furim_ai_chat_logs (
  id TEXT PRIMARY KEY,
  line_user_id TEXT,
  question TEXT NOT NULL,        -- お客様のメッセージ
  answer TEXT,                   -- 送った回答の本文（札を除いたもの）
  howto_anchor TEXT,             -- URL を付けた説明書の章の id（付けなかったら NULL）
  anchor_rejected TEXT,          -- AI が出したが説明書の見出し id の一覧に無かった id（作り話の頻度を見る）
  fallback INTEGER NOT NULL DEFAULT 0,  -- 「AIでのご案内は難しい」の定型文を返した回は 1（説明書・faq に足すべき質問の材料）
  latency_ms INTEGER,            -- 受けてから送り終えるまで
  reply_status TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'replied' | 'pushed'（reply 失敗→push）| 'failed'
  error TEXT,                    -- Gemini の失敗や reply/push の失敗の内容
  howto_source TEXT,             -- 説明書の本文: 'cache' | 'fetched' | 'failed'
  prompt_tokens INTEGER,         -- Gemini の promptTokenCount
  cached_tokens INTEGER,         -- Gemini の cachedContentTokenCount（暗黙キャッシュが効いたとき）
  created_at TEXT NOT NULL       -- 受けた時刻（JST の ISO+09:00）
);
CREATE TABLE furim_seminar_weeks (
  week_id        TEXT PRIMARY KEY,          -- 開催週を表す日曜日の JST 日付 'YYYY-MM-DD'
  stream_url     TEXT,                      -- 配信の入口（YouTube チャンネルの /live URL。毎週使い回す）
  survey_sent_at TEXT,                      -- アンケートを送った時刻（JST ISO+09:00。NULL なら未送信＝送信の枠取りに使う）
  decided_at     TEXT,                      -- 集計して開催枠を決めた時刻（JST ISO+09:00）
  announced_at   TEXT,                      -- 告知を送った時刻（JST ISO+09:00）
  created_at     TEXT NOT NULL
);
CREATE TABLE furim_seminar_slots (
  id          TEXT PRIMARY KEY,             -- UUID
  week_id     TEXT NOT NULL,                -- furim_seminar_weeks.week_id
  slot_id     TEXT NOT NULL,                -- 週の中で枠を指す短い ID（'s1'〜's5'。postback の data に入る）
  starts_at   TEXT NOT NULL,                -- 開催開始日時（JST ISO+09:00）
  is_chosen   INTEGER NOT NULL DEFAULT 0,   -- 1 = 得票上位で開催が決まった枠
  reminded_at TEXT,                         -- 30 分前リマインドを送った時刻（JST ISO+09:00・二重送信の枠取りに使う）
  created_at  TEXT NOT NULL
, topic_reported_at TEXT);
CREATE TABLE furim_seminar_votes (
  id           TEXT PRIMARY KEY,            -- UUID
  week_id      TEXT NOT NULL,               -- furim_seminar_weeks.week_id
  slot_id      TEXT NOT NULL,               -- furim_seminar_slots.slot_id、または 'none'（どれも都合が合わない）
  friend_id    TEXT NOT NULL,               -- friends.id
  line_user_id TEXT,                        -- 記録時点の LINE ユーザー ID（後から友だちを引き直さずに済ませるため）
  voted_at     TEXT NOT NULL                -- 押した時刻（JST ISO+09:00）
);
CREATE TABLE furim_seminar_topic_votes (
  id           TEXT PRIMARY KEY,            -- UUID
  week_id      TEXT NOT NULL,               -- furim_seminar_weeks.week_id
  topic_id     TEXT NOT NULL,               -- 't1'〜't6'（t6 = その他）
  friend_id    TEXT NOT NULL,               -- friends.id
  line_user_id TEXT,                        -- 記録時点の LINE ユーザー ID
  note         TEXT,                        -- t6 のときに受け取った自由記入（未記入は NULL）
  voted_at     TEXT NOT NULL                -- 押した時刻（JST ISO+09:00）
);
CREATE TABLE furim_renewal_unlocks (
  id            TEXT PRIMARY KEY,
  line_user_id  TEXT NOT NULL,
  cycle         TEXT NOT NULL,
  until_ms      INTEGER NOT NULL,   -- 開放の終わり（epoch ms）＝更新日時
  until_at      TEXT NOT NULL,      -- 同じ値の JST 表記（読む人のため）
  flags         TEXT NOT NULL,      -- 上乗せする機能フラグ（JSON。trial パッケージ相当を開放時点で固定）
  packages      TEXT,               -- 開放時点の契約パッケージ
  granted_at    TEXT NOT NULL,
  msg1_sent_at  TEXT,               -- 開放の案内（更新 7 日前）
  msg2_sent_at  TEXT,               -- 多販路・在庫管理（更新 4 日前）
  msg3_sent_at  TEXT,               -- 続けるなら（更新前日）
  UNIQUE (line_user_id, cycle)
);
CREATE TABLE furim_key_code_history (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  key_code     TEXT NOT NULL,
  reason       TEXT NOT NULL,
  issued_at    TEXT,
  replaced_at  TEXT
);
CREATE INDEX idx_friends_line_user_id ON friends (line_user_id);
CREATE INDEX idx_friends_user_id ON friends (user_id);
CREATE INDEX idx_friend_tags_tag_id ON friend_tags (tag_id);
CREATE INDEX idx_messages_log_friend_id ON messages_log (friend_id);
CREATE INDEX idx_messages_log_created_at ON messages_log (created_at);
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_phone ON users (phone);
CREATE INDEX idx_users_external_id ON users (external_id);
CREATE INDEX idx_conversion_events_point ON conversion_events (conversion_point_id);
CREATE INDEX idx_conversion_events_friend ON conversion_events (friend_id);
CREATE INDEX idx_conversion_events_affiliate ON conversion_events (affiliate_code);
CREATE INDEX idx_affiliate_clicks_affiliate ON affiliate_clicks (affiliate_id);
CREATE INDEX idx_calendar_bookings_friend ON calendar_bookings (friend_id);
CREATE INDEX idx_calendar_bookings_start ON calendar_bookings (start_at);
CREATE INDEX idx_reminder_steps_reminder ON reminder_steps (reminder_id);
CREATE INDEX idx_friend_reminders_status ON friend_reminders (status);
CREATE INDEX idx_friend_reminders_friend ON friend_reminders (friend_id);
CREATE INDEX idx_friend_scores_friend ON friend_scores (friend_id);
CREATE INDEX idx_friend_scores_created ON friend_scores (created_at);
CREATE INDEX idx_chats_operator ON chats (operator_id);
CREATE INDEX idx_chats_status ON chats (status);
CREATE INDEX idx_notifications_status ON notifications (status);
CREATE INDEX idx_notifications_created ON notifications (created_at);
CREATE INDEX idx_stripe_events_friend ON stripe_events (friend_id);
CREATE INDEX idx_stripe_events_type ON stripe_events (event_type);
CREATE INDEX idx_health_logs_account ON account_health_logs (line_account_id);
CREATE INDEX idx_automations_event ON automations (event_type);
CREATE INDEX idx_automations_active ON automations (is_active);
CREATE INDEX idx_automation_logs_automation ON automation_logs (automation_id);
CREATE INDEX idx_ad_conversion_logs_platform ON ad_conversion_logs (ad_platform_id);
CREATE INDEX idx_ad_conversion_logs_friend ON ad_conversion_logs (friend_id);
CREATE INDEX idx_ad_conversion_logs_status ON ad_conversion_logs (status);
CREATE UNIQUE INDEX idx_staff_members_api_key ON staff_members(api_key);
CREATE INDEX idx_staff_members_role ON staff_members(role);
CREATE INDEX idx_entry_routes_ref ON entry_routes (ref_code);
CREATE INDEX idx_ref_tracking_ref    ON ref_tracking (ref_code);
CREATE INDEX idx_ref_tracking_friend ON ref_tracking (friend_id);
CREATE INDEX idx_link_clicks_link ON link_clicks (tracked_link_id);
CREATE INDEX idx_link_clicks_friend ON link_clicks (friend_id);
CREATE INDEX idx_form_submissions_form ON form_submissions (form_id);
CREATE INDEX idx_form_submissions_friend ON form_submissions (friend_id);
CREATE INDEX idx_scenario_steps_scenario_id ON scenario_steps (scenario_id);
CREATE INDEX idx_automation_actions_automation ON automation_actions(automation_id);
CREATE INDEX idx_automation_actions_order ON automation_actions(automation_id, step_order);
CREATE INDEX idx_messages_type ON messages (message_type);
CREATE INDEX idx_template_messages_template ON template_messages (template_id);
CREATE INDEX idx_template_messages_message  ON template_messages (message_id);
CREATE INDEX idx_templates_category ON templates (category);
CREATE INDEX idx_friends_ig_igsid ON friends (ig_igsid);
CREATE INDEX idx_broadcast_insights_broadcast_id ON broadcast_insights(broadcast_id);
CREATE INDEX idx_broadcast_insights_status ON broadcast_insights(status);
CREATE INDEX idx_menus_account_sort ON menus (line_account_id, sort_order);
CREATE INDEX idx_staff_account_sort ON staff (line_account_id, sort_order);
CREATE INDEX idx_shifts_staff_date ON staff_shifts (staff_id, work_date);
CREATE INDEX idx_bookings_account_status_starts ON bookings (line_account_id, status, starts_at);
CREATE INDEX idx_bookings_staff_overlap ON bookings (staff_id, status, starts_at, block_ends_at);
CREATE INDEX idx_bookings_friend_starts ON bookings (friend_id, starts_at DESC);
CREATE INDEX idx_idempotency_expires ON booking_idempotency_keys (expires_at);
CREATE INDEX idx_reminders_status_scheduled ON booking_reminders (status, scheduled_at);
CREATE INDEX idx_rich_menu_pages_group    ON rich_menu_pages(group_id, order_index);
CREATE INDEX idx_rich_menu_areas_page     ON rich_menu_areas(page_id);
CREATE INDEX idx_rich_menu_groups_account ON rich_menu_groups(account_id, status);
CREATE INDEX idx_form_opens_form ON form_opens (form_id, opened_at);
CREATE INDEX idx_events_account_published_sort ON events (line_account_id, is_published, sort_order);
CREATE INDEX idx_event_slots_event_starts ON event_slots (event_id, starts_at);
CREATE INDEX idx_event_bookings_account_status_event ON event_bookings (line_account_id, status, event_id);
CREATE INDEX idx_event_bookings_slot_status ON event_bookings (slot_id, status);
CREATE INDEX idx_event_bookings_friend_requested ON event_bookings (friend_id, requested_at DESC);
CREATE INDEX idx_event_booking_reminders_status_scheduled ON event_booking_reminders (status, scheduled_at);
CREATE INDEX idx_event_booking_idempotency_expires ON event_booking_idempotency_keys (expires_at);
CREATE INDEX idx_event_bookings_identity_status
  ON event_bookings (event_id, identity_key, status);
CREATE INDEX idx_update_history_started ON update_history(started_at DESC);
CREATE INDEX idx_pb_intents_user ON plan_builder_intents(line_user_id, created_at);
CREATE INDEX idx_push_subscriptions_staff ON push_subscriptions(staff_member_id);
CREATE UNIQUE INDEX idx_affiliates_friend ON affiliates(friend_id) WHERE friend_id IS NOT NULL;
CREATE INDEX idx_affiliate_links_affiliate ON affiliate_links(affiliate_id);
CREATE INDEX idx_ref_tracking_friend_created ON ref_tracking(friend_id, created_at);
CREATE INDEX idx_ref_tracking_ref_created ON ref_tracking(ref_code, created_at);
CREATE INDEX idx_affiliate_links_offer ON affiliate_links(offer_id);
CREATE UNIQUE INDEX idx_chats_friend_unique ON chats (friend_id);
CREATE UNIQUE INDEX idx_tracked_links_short_code
  ON tracked_links (short_code) WHERE short_code IS NOT NULL;
CREATE INDEX idx_coupon_notifications_due ON coupon_notifications(status, send_after);
CREATE INDEX idx_coupon_notifications_friend ON coupon_notifications(friend_id);
CREATE INDEX idx_stripe_events_status ON stripe_events (status);
CREATE INDEX idx_messages_log_reply_to_message_id ON messages_log (reply_to_message_id);
CREATE INDEX idx_friend_scenarios_next_delivery_at ON friend_scenarios (next_delivery_at);
CREATE INDEX idx_friend_scenarios_status ON friend_scenarios (status);
CREATE INDEX idx_friend_scenarios_friend_id ON friend_scenarios (friend_id);
CREATE UNIQUE INDEX idx_friend_scenarios_unique ON friend_scenarios (friend_id, scenario_id) WHERE status != 'completed';
CREATE INDEX idx_gas_retry_jobs_status ON gas_retry_jobs(status, created_at);
CREATE INDEX idx_lp_events_page_created ON lp_events(page, created_at);
CREATE INDEX idx_lp_events_session ON lp_events(session_id);
CREATE INDEX idx_broadcasts_status ON broadcasts (status);
CREATE INDEX idx_messages_log_friend_created ON messages_log (friend_id, created_at);
CREATE INDEX idx_friends_last_message_at ON friends (last_message_at DESC);
CREATE INDEX idx_friends_refcode_created ON friends (created_at) WHERE ref_code IS NOT NULL;
CREATE INDEX idx_messages_log_incoming ON messages_log (friend_id, created_at) WHERE direction='incoming';
CREATE INDEX idx_messages_log_manual_out ON messages_log (friend_id, created_at) WHERE direction='outgoing' AND source='manual';
CREATE INDEX idx_lp_events_type_created ON lp_events(event_type, created_at);
CREATE INDEX idx_furim_customers_stripe ON furim_customers(stripe_customer_id);
CREATE INDEX idx_furim_sync_diffs_open ON furim_sync_diffs(resolved_at, notified_at, first_seen_at);
CREATE INDEX idx_furim_payments_user ON furim_payments(line_user_id, paid_at);
CREATE INDEX idx_furim_ticket_ledger_user ON furim_ticket_ledger(line_user_id, created_at);
CREATE UNIQUE INDEX idx_furim_referrals_introduced ON furim_referrals(introduced_friend_id);
CREATE INDEX idx_furim_referrals_affiliate ON furim_referrals(affiliate_id, created_at);
CREATE INDEX idx_furim_referrals_ambassador ON furim_referrals(ambassador_friend_id, reward_applied_at);
CREATE INDEX idx_furim_admin_audit_row ON furim_admin_audit(table_name, row_id, created_at);
CREATE INDEX idx_furim_customers_key_code ON furim_customers(key_code);
CREATE INDEX idx_furim_customers_mercari_url ON furim_customers(mercari_url);
CREATE INDEX idx_furim_execution_logs_user ON furim_execution_logs(line_user_id, created_at);
CREATE INDEX idx_furim_execution_logs_created ON furim_execution_logs(created_at);
CREATE INDEX idx_furim_ext_errors_created ON furim_ext_errors(created_at);
CREATE INDEX idx_furim_ext_errors_user ON furim_ext_errors(line_user_id, created_at);
CREATE INDEX idx_furim_manual_copy_logs_install ON furim_manual_copy_logs(install_id, target);
CREATE INDEX idx_furim_manual_copy_logs_created ON furim_manual_copy_logs(created_at);
CREATE INDEX idx_furim_shop_research_logs_install ON furim_shop_research_logs(install_id, is_free);
CREATE INDEX idx_furim_shop_research_logs_created ON furim_shop_research_logs(created_at);
CREATE INDEX idx_furim_survey_answers_user ON furim_survey_answers(line_user_id, created_at);
CREATE INDEX idx_furim_coupon_applications_user ON furim_coupon_applications(line_user_id, created_at);
CREATE INDEX idx_furim_auto_copy_logs_user ON furim_auto_copy_logs(line_user_id, processed_at);
CREATE INDEX idx_furim_auto_copy_logs_processed ON furim_auto_copy_logs(processed_at);
CREATE INDEX idx_furim_referral_cashbacks_ambassador ON furim_referral_cashbacks(ambassador_line_user_id, occurred_at);
CREATE INDEX idx_furim_referral_cashbacks_introduced ON furim_referral_cashbacks(introduced_line_user_id, occurred_at);
CREATE UNIQUE INDEX idx_furim_auto_copy_logs_idempotency ON furim_auto_copy_logs(idempotency_key);
CREATE INDEX idx_furim_ad_spend_date ON furim_ad_spend(date);
CREATE INDEX idx_furim_ops_log_acted_at ON furim_ops_log(acted_at);
CREATE INDEX idx_furim_health_acks_silence ON furim_health_acks(silence_until);
CREATE INDEX idx_furim_patrol_runs_created ON furim_patrol_runs(created_at);
CREATE INDEX idx_furim_patrol_runs_user ON furim_patrol_runs(line_user_id, created_at);
CREATE INDEX idx_furim_ai_chat_logs_created ON furim_ai_chat_logs(created_at);
CREATE INDEX idx_furim_ai_chat_logs_user ON furim_ai_chat_logs(line_user_id, created_at);
CREATE UNIQUE INDEX idx_furim_seminar_slots_week_slot ON furim_seminar_slots(week_id, slot_id);
CREATE INDEX idx_furim_seminar_slots_starts ON furim_seminar_slots(starts_at);
CREATE UNIQUE INDEX idx_furim_seminar_votes_unique ON furim_seminar_votes(week_id, slot_id, friend_id);
CREATE INDEX idx_furim_seminar_votes_week ON furim_seminar_votes(week_id, slot_id);
CREATE UNIQUE INDEX idx_furim_seminar_topic_votes_unique ON furim_seminar_topic_votes(week_id, topic_id, friend_id);
CREATE INDEX idx_furim_seminar_topic_votes_friend ON furim_seminar_topic_votes(friend_id, topic_id, voted_at);
CREATE INDEX idx_furim_renewal_unlocks_user ON furim_renewal_unlocks(line_user_id, until_ms);
CREATE INDEX idx_furim_renewal_unlocks_until ON furim_renewal_unlocks(until_ms);
CREATE INDEX idx_furim_key_code_history_key ON furim_key_code_history(key_code);
CREATE INDEX idx_furim_key_code_history_user ON furim_key_code_history(line_user_id, replaced_at);
CREATE TRIGGER trg_messages_log_touch_friend AFTER INSERT ON messages_log WHEN (NEW.delivery_type IS NULL OR NEW.delivery_type != 'test') BEGIN UPDATE friends SET last_message_at = NEW.created_at WHERE id = NEW.friend_id AND (last_message_at IS NULL OR last_message_at < NEW.created_at); END;
CREATE TRIGGER trg_furim_key_code_history_insert
AFTER INSERT ON furim_customers
WHEN COALESCE(NEW.key_code, '') <> ''
BEGIN
  INSERT INTO furim_key_code_history (line_user_id, key_code, reason, issued_at, replaced_at)
  VALUES (NEW.line_user_id, NEW.key_code, 'issued', NEW.updated_at, NULL);
END;
CREATE TRIGGER trg_furim_key_code_history_update
AFTER UPDATE OF key_code ON furim_customers
WHEN COALESCE(OLD.key_code, '') <> COALESCE(NEW.key_code, '')
BEGIN
  UPDATE furim_key_code_history SET replaced_at = NEW.updated_at
  WHERE line_user_id = NEW.line_user_id AND replaced_at IS NULL;
  INSERT INTO furim_key_code_history (line_user_id, key_code, reason, issued_at, replaced_at)
  SELECT NEW.line_user_id, NEW.key_code, CASE WHEN COALESCE(OLD.key_code, '') = '' THEN 'issued' ELSE 'replaced' END, NEW.updated_at, NULL
  WHERE COALESCE(NEW.key_code, '') <> '';
END;
