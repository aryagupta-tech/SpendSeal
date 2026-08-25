CREATE TABLE merchant_invitations (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  invited_username text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin','catalog_manager','auditor')),
  token_hash text NOT NULL UNIQUE,
  created_by uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX merchant_invitations_merchant_idx ON merchant_invitations(merchant_id,created_at DESC);
CREATE UNIQUE INDEX merchant_invitations_active_unique ON merchant_invitations(merchant_id,lower(invited_username)) WHERE accepted_at IS NULL AND revoked_at IS NULL;
