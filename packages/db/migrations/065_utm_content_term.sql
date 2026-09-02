-- 広告の切り分け配信（キャンペーン/広告グループ/クリエイティブの3階層）を計測できるようにする。
-- 従来は utm_campaign までしか保存しておらず、「どの広告グループの、どのクリエイティブ経由で
-- 友だち追加されたか」が追えなかった。
-- Google広告は final URL に utm_term={adgroupid}&utm_content={creative}、
-- Meta広告は utm_term={{adset.id}}&utm_content={{ad.id}} を設定して使う。
ALTER TABLE ref_tracking ADD COLUMN utm_content TEXT;
ALTER TABLE ref_tracking ADD COLUMN utm_term TEXT;

-- LP行動計測側は utm_content のみ既存。広告グループ別の深度分析用に utm_term を揃える。
ALTER TABLE lp_events ADD COLUMN utm_term TEXT;
