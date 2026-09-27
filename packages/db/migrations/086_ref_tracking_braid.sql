-- Google Ads privacy-preserving click identifiers (TB-363).
-- Apply before deploying the Worker. Existing rows remain NULL.
ALTER TABLE ref_tracking ADD COLUMN gbraid TEXT;
ALTER TABLE ref_tracking ADD COLUMN wbraid TEXT;
