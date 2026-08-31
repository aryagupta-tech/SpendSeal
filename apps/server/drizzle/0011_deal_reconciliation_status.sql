ALTER TABLE deal_sessions DROP CONSTRAINT IF EXISTS deal_sessions_status_check;
ALTER TABLE deal_sessions ADD CONSTRAINT deal_sessions_status_check CHECK (status IN (
  'negotiating','accepted','rejected','expired','invalidated','permit_created','reconciliation_required','paid'
));

DROP INDEX IF EXISTS deal_sessions_one_active_idx;
CREATE UNIQUE INDEX deal_sessions_one_active_idx ON deal_sessions(buyer_id,product_id)
  WHERE status IN ('negotiating','accepted','permit_created');
