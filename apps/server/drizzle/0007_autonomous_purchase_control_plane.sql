ALTER TABLE shopping_tasks DROP CONSTRAINT IF EXISTS shopping_tasks_site_check;
ALTER TABLE shopping_tasks ADD CONSTRAINT shopping_tasks_site_check CHECK (site IN ('amazon_in','flipkart_in','openai_api','generic_web'));
ALTER TABLE shopping_tasks DROP CONSTRAINT IF EXISTS shopping_tasks_check;
ALTER TABLE shopping_tasks
  ADD COLUMN allowed_origin text,
  ADD COLUMN purchase_kind text NOT NULL DEFAULT 'physical_good' CHECK (purchase_kind IN ('physical_good','api_credits','generic_one_time')),
  ADD COLUMN proposed_candidate_id uuid,
  ADD COLUMN selection_confirmed_at timestamptz;

ALTER TABLE shopping_candidates DROP CONSTRAINT IF EXISTS shopping_candidates_adapter_id_check;
ALTER TABLE shopping_candidates
  ADD COLUMN image_url text,
  ADD COLUMN rating numeric(3,2),
  ADD COLUMN review_count integer,
  ADD COLUMN delivery_estimate text,
  ADD COLUMN ranking_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN proposal_source text NOT NULL DEFAULT 'recommended' CHECK (proposal_source IN ('recommended','manual','agent')),
  ADD COLUMN query_mismatch boolean NOT NULL DEFAULT false;
ALTER TABLE shopping_tasks ADD CONSTRAINT shopping_task_proposed_candidate_fk FOREIGN KEY (proposed_candidate_id) REFERENCES shopping_candidates(id);

ALTER TABLE browser_observations DROP CONSTRAINT IF EXISTS browser_observations_kind_check;
ALTER TABLE browser_observations ADD CONSTRAINT browser_observations_kind_check CHECK (kind IN ('candidates','product_proposal','checkout','revalidation','redacted_page','operator_result'));

CREATE TABLE shopping_selection_proposals (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES shopping_tasks(id),
  candidate_id uuid NOT NULL REFERENCES shopping_candidates(id),
  installation_id uuid NOT NULL REFERENCES browser_installations(id),
  source text NOT NULL CHECK (source IN ('recommended','manual','agent')),
  status text NOT NULL CHECK (status IN ('pending','confirmed','replaced','dismissed','expired')),
  query_mismatch boolean NOT NULL DEFAULT false,
  warning text,
  expires_at timestamptz NOT NULL,
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shopping_selection_proposals_task_idx ON shopping_selection_proposals(task_id,created_at DESC);
CREATE UNIQUE INDEX shopping_selection_proposals_one_pending_idx ON shopping_selection_proposals(task_id) WHERE status='pending';

CREATE TABLE browser_site_grants (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES shopping_tasks(id),
  installation_id uuid NOT NULL REFERENCES browser_installations(id),
  origin text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  UNIQUE(task_id,installation_id,origin)
);

CREATE TABLE browser_operator_commands (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES shopping_tasks(id),
  installation_id uuid REFERENCES browser_installations(id),
  sequence integer NOT NULL,
  action_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','claimed','completed','blocked','failed')),
  result_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  UNIQUE(task_id,sequence)
);
CREATE INDEX browser_operator_commands_pending_idx ON browser_operator_commands(task_id,status,sequence);

CREATE TABLE browser_fx_quotes (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES shopping_tasks(id),
  base_currency text NOT NULL CHECK (base_currency='USD'),
  quote_currency text NOT NULL CHECK (quote_currency='INR'),
  rate numeric(18,8) NOT NULL,
  buffer_percent integer NOT NULL CHECK (buffer_percent=10),
  source text NOT NULL,
  quoted_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX browser_fx_quotes_task_idx ON browser_fx_quotes(task_id,quoted_at DESC);
