-- LINEヤフー広告（Yahoo!広告）の自動タグのクリックID（TB-1727）。
-- Apply before deploying the Worker. Existing rows remain NULL.
ALTER TABLE ref_tracking ADD COLUMN yclid TEXT;
