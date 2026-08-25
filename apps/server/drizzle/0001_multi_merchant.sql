CREATE TABLE IF NOT EXISTS agentrail_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchants (
  id uuid PRIMARY KEY,
  slug text NOT NULL UNIQUE,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_memberships (
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  user_id uuid NOT NULL REFERENCES users(id),
  role text NOT NULL CHECK (role IN ('owner','admin','catalog_manager','auditor')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id,user_id)
);
CREATE INDEX memberships_user_idx ON merchant_memberships(user_id);

CREATE TABLE browser_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  csrf_hash text NOT NULL,
  idle_expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE passkey_credentials (
  credential_id text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  rp_id text NOT NULL,
  public_key_b64 text NOT NULL,
  counter integer NOT NULL,
  device_type text NOT NULL,
  backed_up boolean NOT NULL,
  transports_json jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passkeys_user_rp_idx ON passkey_credentials(user_id,rp_id);

CREATE TABLE webauthn_challenges (
  id uuid PRIMARY KEY,
  user_id uuid REFERENCES users(id),
  intent_lock_id uuid,
  purpose text NOT NULL CHECK (purpose IN ('registration','login','approval')),
  challenge text NOT NULL,
  context_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE merchant_api_keys (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  name text NOT NULL,
  prefix text NOT NULL,
  secret_hash text NOT NULL UNIQUE,
  scopes_json jsonb NOT NULL,
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  sku text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_paise integer NOT NULL CHECK (price_paise > 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  refundable boolean NOT NULL,
  refund_window_days integer NOT NULL CHECK (refund_window_days >= 0),
  active boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  current_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id,sku),
  UNIQUE (merchant_id,id)
);

CREATE TABLE product_revisions (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  version integer NOT NULL,
  snapshot_json jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id,version),
  FOREIGN KEY (merchant_id,product_id) REFERENCES products(merchant_id,id)
);
ALTER TABLE products ADD CONSTRAINT products_current_revision_fk FOREIGN KEY (current_revision_id) REFERENCES product_revisions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE merchant_payment_configurations (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  adapter text NOT NULL CHECK (adapter IN ('mock','razorpay')),
  key_id text,
  key_secret_ciphertext text,
  webhook_secret_ciphertext text,
  encryption_key_version integer NOT NULL,
  version integer NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id,version)
);

CREATE TABLE intent_locks (
  id uuid PRIMARY KEY,
  buyer_id uuid NOT NULL REFERENCES users(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  product_id uuid NOT NULL REFERENCES products(id),
  product_revision_id uuid NOT NULL REFERENCES product_revisions(id),
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity = 1),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  product_snapshot_hash text NOT NULL,
  locked_unit_price_paise integer NOT NULL CHECK (locked_unit_price_paise > 0),
  max_total_paise integer NOT NULL CHECK (max_total_paise > 0),
  price_change_policy text NOT NULL CHECK (price_change_policy IN ('none','decrease_only','within_cap')),
  require_refundable boolean NOT NULL,
  minimum_refund_window_days integer,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  idempotency_key text NOT NULL UNIQUE,
  approval_token_hash text NOT NULL,
  approval_token_exchanged_at timestamptz,
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (merchant_id,product_id) REFERENCES products(merchant_id,id)
);
ALTER TABLE webauthn_challenges ADD CONSTRAINT challenge_intent_fk FOREIGN KEY (intent_lock_id) REFERENCES intent_locks(id);

CREATE TABLE approval_sessions (
  token_hash text PRIMARY KEY,
  intent_lock_id uuid NOT NULL REFERENCES intent_locks(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payment_orders (
  id uuid PRIMARY KEY,
  intent_lock_id uuid NOT NULL UNIQUE REFERENCES intent_locks(id),
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  provider_order_id text UNIQUE,
  amount_paise integer NOT NULL CHECK (amount_paise > 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  checkout_token_hash text NOT NULL UNIQUE,
  checkout_token text NOT NULL,
  status text NOT NULL CHECK (status IN ('creating','ready','paid','reconciliation_required')),
  payment_id text UNIQUE,
  observed_product_version integer NOT NULL,
  observed_product_revision_id uuid NOT NULL REFERENCES product_revisions(id),
  observed_snapshot_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  payment_config_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE webhook_events (
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  event_id text NOT NULL,
  event_type text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (merchant_id,event_id)
);

CREATE TABLE audit_chain_heads (
  scope_type text NOT NULL CHECK (scope_type IN ('intent','merchant')),
  scope_id uuid NOT NULL,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  sequence integer NOT NULL DEFAULT 0,
  hash text NOT NULL DEFAULT 'GENESIS',
  PRIMARY KEY (scope_type,scope_id)
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  sequence integer NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('intent','merchant')),
  scope_id uuid NOT NULL,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  intent_lock_id uuid REFERENCES intent_locks(id),
  event_type text NOT NULL,
  actor text NOT NULL,
  reason_code text,
  payload_json jsonb NOT NULL,
  previous_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type,scope_id,sequence),
  UNIQUE (scope_type,scope_id,hash)
);

CREATE FUNCTION reject_audit_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit_events are append-only'; END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

CREATE TABLE oauth_authorization_codes (
  code_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  resource text NOT NULL,
  scopes_json jsonb NOT NULL,
  code_challenge text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oauth_tokens (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  token_type text NOT NULL CHECK (token_type IN ('access','refresh')),
  family_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id),
  client_id text NOT NULL,
  resource text NOT NULL,
  scopes_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  replaced_by_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  window_ends_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
