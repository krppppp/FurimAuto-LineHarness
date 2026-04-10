ALTER TABLE templates ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;
UPDATE templates SET sort_order = rowid;
