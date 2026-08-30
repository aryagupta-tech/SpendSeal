CREATE TABLE shopping_tasks (
  id uuid PRIMARY KEY,
  buyer_id uuid NOT NULL REFERENCES users(id),
  site text NOT NULL CHECK (site IN ('amazon_in','flipkart_in')),
  query text,
  product_url text,
  max_total_paise integer NOT NULL CHECK (max_total_paise > 0),
  require_refundable boolean NOT NULL DEFAULT false,
  minimum_return_window_days integer,
  latest_delivery_date date,
  quantity integer NOT NULL DEFAULT 1 CHECK (quantity = 1),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status text NOT NULL,
  selected_candidate_id uuid,
  purchase_permit_id uuid,
  checkout_snapshot_hash text,
  confirmed_at timestamptz,
  denial_reason text,
  mode text NOT NULL DEFAULT 'prepare_only' CHECK (mode IN ('prepare_only','live')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((query IS NOT NULL)::integer + (product_url IS NOT NULL)::integer = 1)
);
CREATE INDEX shopping_tasks_buyer_status_idx ON shopping_tasks(buyer_id,status,created_at DESC);

CREATE TABLE shopping_candidates (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES shopping_tasks(id),
  canonical_product_id text NOT NULL,
  listing_id text,
  title text NOT NULL,
  seller text,
  variant text,
  condition text NOT NULL DEFAULT 'new',
  availability text NOT NULL,
  price_paise integer NOT NULL CHECK (price_paise > 0),
  currency text NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  product_url text NOT NULL,
  snapshot_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  adapter_id text NOT NULL CHECK (adapter_id IN ('amazon_in','flipkart_in')),
  adapter_version text NOT NULL,
  selected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shopping_candidates_task_product_idx ON shopping_candidates(task_id,canonical_product_id,product_url);

CREATE TABLE browser_purchase_permits (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES shopping_tasks(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  checkout_snapshot_json jsonb NOT NULL,
  checkout_snapshot_hash text NOT NULL,
  max_total_paise integer NOT NULL CHECK (max_total_paise > 0),
  status text NOT NULL,
  confirmed_at timestamptz,
  expires_at timestamptz NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE shopping_tasks ADD CONSTRAINT shopping_task_candidate_fk FOREIGN KEY (selected_candidate_id) REFERENCES shopping_candidates(id);
ALTER TABLE shopping_tasks ADD CONSTRAINT shopping_task_permit_fk FOREIGN KEY (purchase_permit_id) REFERENCES browser_purchase_permits(id);

CREATE TABLE browser_installations (
  id uuid PRIMARY KEY,
  buyer_id uuid NOT NULL REFERENCES users(id),
  oauth_client_id text NOT NULL,
  name text NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX browser_installations_buyer_idx ON browser_installations(buyer_id,revoked_at);

CREATE TABLE browser_observations (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES shopping_tasks(id),
  installation_id uuid NOT NULL REFERENCES browser_installations(id),
  kind text NOT NULL CHECK (kind IN ('candidates','checkout','revalidation')),
  adapter_id text NOT NULL,
  adapter_version text NOT NULL,
  source_url text NOT NULL,
  snapshot_json jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX browser_observations_task_idx ON browser_observations(task_id,created_at);

CREATE TABLE browser_execution_attempts (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL UNIQUE REFERENCES shopping_tasks(id),
  installation_id uuid NOT NULL REFERENCES browser_installations(id),
  grant_token_hash text UNIQUE,
  grant_expires_at timestamptz,
  status text NOT NULL,
  outcome_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE shopping_audit_chain_heads (
  task_id uuid PRIMARY KEY REFERENCES shopping_tasks(id),
  sequence integer NOT NULL DEFAULT 0,
  hash text NOT NULL DEFAULT 'GENESIS'
);
CREATE TABLE shopping_audit_events (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES shopping_tasks(id),
  buyer_id uuid NOT NULL REFERENCES users(id),
  sequence integer NOT NULL,
  event_type text NOT NULL,
  actor text NOT NULL,
  reason_code text,
  adapter_id text,
  adapter_version text,
  evidence_assurance text NOT NULL DEFAULT 'browser_observed',
  payload_json jsonb NOT NULL,
  previous_hash text NOT NULL,
  hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(task_id,sequence),
  UNIQUE(task_id,hash)
);
CREATE TRIGGER shopping_audit_events_no_update BEFORE UPDATE ON shopping_audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
CREATE TRIGGER shopping_audit_events_no_delete BEFORE DELETE ON shopping_audit_events FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

ALTER TABLE webauthn_challenges DROP CONSTRAINT webauthn_challenges_purpose_check;
ALTER TABLE webauthn_challenges ADD COLUMN shopping_task_id uuid REFERENCES shopping_tasks(id);
ALTER TABLE webauthn_challenges ADD CONSTRAINT webauthn_challenges_purpose_check CHECK (purpose IN ('registration','login','approval','shopping_approval'));
