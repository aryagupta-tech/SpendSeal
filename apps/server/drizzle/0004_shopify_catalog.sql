ALTER TABLE products ADD COLUMN catalog_source text NOT NULL DEFAULT 'agentrail_server'
  CHECK (catalog_source IN ('agentrail_server','shopify_admin_graphql'));
ALTER TABLE products ADD COLUMN external_id text;
ALTER TABLE products ADD COLUMN external_updated_at timestamptz;
CREATE UNIQUE INDEX products_merchant_external_unique ON products(merchant_id,external_id) WHERE external_id IS NOT NULL;

CREATE TABLE merchant_catalog_connections (
  merchant_id uuid PRIMARY KEY REFERENCES merchants(id),
  provider text NOT NULL CHECK (provider = 'shopify'),
  shop_domain text NOT NULL UNIQUE,
  access_token_ciphertext text NOT NULL,
  encryption_key_version integer NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','revoked')),
  shop_name text NOT NULL,
  currency text NOT NULL,
  default_refundable boolean NOT NULL DEFAULT false,
  default_refund_window_days integer NOT NULL DEFAULT 0 CHECK (default_refund_window_days >= 0),
  last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE payment_orders ADD COLUMN observed_catalog_source text NOT NULL DEFAULT 'agentrail_server'
  CHECK (observed_catalog_source IN ('agentrail_server','shopify_admin_graphql'));
ALTER TABLE payment_orders ADD COLUMN observed_shop_domain text;
