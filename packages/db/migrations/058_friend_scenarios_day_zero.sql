-- Day0起点の柔軟化: シナリオのDay計算の基準日を登録時刻(started_at)から切り離す。
-- NULLの場合は従来どおりstarted_at基準。過去顧客の掘り起こし配信で「意図した日をDay0」にするために使う。
ALTER TABLE friend_scenarios ADD COLUMN day_zero_at TEXT;
