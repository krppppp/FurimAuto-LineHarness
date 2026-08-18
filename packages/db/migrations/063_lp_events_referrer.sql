-- LP行動計測に流入元(referrer)を追加。オーガニック急増の経路特定(SNS/検索/直接)用
ALTER TABLE lp_events ADD COLUMN referrer TEXT;
