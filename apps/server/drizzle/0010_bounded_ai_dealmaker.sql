CREATE TABLE merchant_deal_policies (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  version integer NOT NULL CHECK (version > 0),
  floor_price_ciphertext text NOT NULL,
  encryption_key_version integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id,product_id,version),
  FOREIGN KEY (merchant_id,product_id) REFERENCES products(merchant_id,id)
);
CREATE INDEX merchant_deal_policies_latest_idx ON merchant_deal_policies(merchant_id,product_id,version DESC);

CREATE FUNCTION reject_deal_policy_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'merchant_deal_policies are immutable'; END $$;
CREATE TRIGGER merchant_deal_policies_no_update BEFORE UPDATE ON merchant_deal_policies FOR EACH ROW EXECUTE FUNCTION reject_deal_policy_mutation();
CREATE TRIGGER merchant_deal_policies_no_delete BEFORE DELETE ON merchant_deal_policies FOR EACH ROW EXECUTE FUNCTION reject_deal_policy_mutation();

CREATE TABLE deal_sessions (
  id uuid PRIMARY KEY,
  buyer_id uuid NOT NULL REFERENCES users(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  product_revision_id uuid NOT NULL REFERENCES product_revisions(id),
  product_snapshot_hash text NOT NULL,
  product_name text NOT NULL,
  public_price_paise integer NOT NULL CHECK (public_price_paise > 0),
  buyer_max_total_paise integer NOT NULL CHECK (buyer_max_total_paise > 0),
  policy_id uuid NOT NULL REFERENCES merchant_deal_policies(id),
  policy_version integer NOT NULL CHECK (policy_version > 0),
  status text NOT NULL CHECK (status IN ('negotiating','accepted','rejected','expired','invalidated','permit_created','paid')),
  round_count integer NOT NULL DEFAULT 0 CHECK (round_count BETWEEN 0 AND 3),
  merchant_last_counter_paise integer,
  accepted_price_paise integer,
  accepted_offer_snapshot_hash text,
  purchase_permit_id uuid,
  idempotency_key text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (buyer_id,idempotency_key),
  FOREIGN KEY (merchant_id,product_id) REFERENCES products(merchant_id,id)
);
CREATE UNIQUE INDEX deal_sessions_one_active_idx ON deal_sessions(buyer_id,product_id) WHERE status IN ('negotiating','accepted');
CREATE INDEX deal_sessions_rate_limit_idx ON deal_sessions(buyer_id,product_id,created_at DESC);
CREATE INDEX deal_sessions_merchant_idx ON deal_sessions(merchant_id,created_at DESC);

CREATE TABLE deal_rounds (
  id uuid PRIMARY KEY,
  deal_session_id uuid NOT NULL REFERENCES deal_sessions(id),
  sequence integer NOT NULL CHECK (sequence BETWEEN 1 AND 3),
  buyer_offer_paise integer NOT NULL CHECK (buyer_offer_paise > 0),
  response text NOT NULL CHECK (response IN ('counter','accepted','rejected')),
  merchant_counter_paise integer,
  reason_code text,
  offer_snapshot_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (deal_session_id,sequence),
  UNIQUE (deal_session_id,buyer_offer_paise)
);
CREATE FUNCTION reject_deal_round_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'deal_rounds are append-only'; END $$;
CREATE TRIGGER deal_rounds_no_update BEFORE UPDATE ON deal_rounds FOR EACH ROW EXECUTE FUNCTION reject_deal_round_mutation();
CREATE TRIGGER deal_rounds_no_delete BEFORE DELETE ON deal_rounds FOR EACH ROW EXECUTE FUNCTION reject_deal_round_mutation();

ALTER TABLE intent_locks
  ADD COLUMN deal_session_id uuid,
  ADD COLUMN deal_policy_id uuid,
  ADD COLUMN deal_policy_version integer,
  ADD COLUMN public_unit_price_paise integer,
  ADD COLUMN negotiated_unit_price_paise integer,
  ADD COLUMN accepted_offer_snapshot_hash text,
  ADD COLUMN deal_expires_at timestamptz,
  ADD CONSTRAINT intent_deal_session_fk FOREIGN KEY (deal_session_id) REFERENCES deal_sessions(id),
  ADD CONSTRAINT intent_deal_policy_fk FOREIGN KEY (deal_policy_id) REFERENCES merchant_deal_policies(id),
  ADD CONSTRAINT intent_negotiated_price_check CHECK (negotiated_unit_price_paise IS NULL OR negotiated_unit_price_paise > 0),
  ADD CONSTRAINT intent_public_price_check CHECK (public_unit_price_paise IS NULL OR public_unit_price_paise > 0);
ALTER TABLE deal_sessions ADD CONSTRAINT deal_session_permit_fk FOREIGN KEY (purchase_permit_id) REFERENCES intent_locks(id);

ALTER TABLE audit_chain_heads DROP CONSTRAINT IF EXISTS audit_chain_heads_scope_type_check;
ALTER TABLE audit_chain_heads ADD CONSTRAINT audit_chain_heads_scope_type_check CHECK (scope_type IN ('intent','merchant','deal'));
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_scope_type_check;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_scope_type_check CHECK (scope_type IN ('intent','merchant','deal'));

ALTER TABLE merchant_ai_commerce_events DROP CONSTRAINT IF EXISTS merchant_ai_commerce_events_event_type_check;
ALTER TABLE merchant_ai_commerce_events ADD CONSTRAINT merchant_ai_commerce_events_event_type_check CHECK (event_type IN (
  'CATALOG_DISCOVERED','PRODUCTS_PRESENTED','PURCHASE_PERMIT_CREATED','PASSKEY_APPROVED','POLICY_ALLOWED','POLICY_DENIED',
  'PAYMENT_ORDER_CREATED','PAYMENT_VERIFIED','REPLAY_BLOCKED','NEGOTIATION_STARTED','DEAL_ACCEPTED','DEAL_REJECTED'
));
ALTER TABLE merchant_ai_commerce_events DROP CONSTRAINT IF EXISTS merchant_ai_commerce_events_source_check;
ALTER TABLE merchant_ai_commerce_events ADD CONSTRAINT merchant_ai_commerce_events_source_check CHECK (source IN ('chatgpt_mcp','buyer_web','merchant_agent','policy_engine','razorpay','mock_adapter','system'));
