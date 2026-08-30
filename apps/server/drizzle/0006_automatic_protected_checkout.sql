ALTER TABLE shopping_tasks
  ADD COLUMN payment_preference text
  CHECK (payment_preference IS NULL OR payment_preference IN ('cash_on_delivery','online'));

CREATE TABLE browser_approval_continuations (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES shopping_tasks(id),
  installation_id uuid NOT NULL REFERENCES browser_installations(id),
  redirect_uri text NOT NULL,
  state text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX browser_approval_continuations_task_idx
  ON browser_approval_continuations(task_id,expires_at);
