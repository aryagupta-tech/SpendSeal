CREATE TABLE merchant_ai_commerce_events (
  id uuid PRIMARY KEY,
  merchant_id uuid NOT NULL REFERENCES merchants(id),
  product_id uuid REFERENCES products(id),
  purchase_permit_id uuid REFERENCES intent_locks(id),
  payment_order_id uuid REFERENCES payment_orders(id),
  event_type text NOT NULL CHECK (event_type IN (
    'CATALOG_DISCOVERED','PRODUCTS_PRESENTED','PURCHASE_PERMIT_CREATED','PASSKEY_APPROVED','POLICY_ALLOWED','POLICY_DENIED',
    'PAYMENT_ORDER_CREATED','PAYMENT_VERIFIED','REPLAY_BLOCKED'
  )),
  source text NOT NULL CHECK (source IN ('chatgpt_mcp','buyer_web','policy_engine','razorpay','mock_adapter','system')),
  metric_value integer NOT NULL DEFAULT 1 CHECK (metric_value >= 0),
  deduplication_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (merchant_id, deduplication_key)
);

CREATE INDEX merchant_ai_events_funnel_idx ON merchant_ai_commerce_events(merchant_id,event_type,created_at);
CREATE INDEX merchant_ai_events_product_idx ON merchant_ai_commerce_events(merchant_id,product_id);
