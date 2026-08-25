ALTER TABLE product_revisions ADD CONSTRAINT product_revisions_merchant_id_unique UNIQUE (merchant_id,id);
ALTER TABLE intent_locks ADD CONSTRAINT intent_revision_tenant_fk FOREIGN KEY (merchant_id,product_revision_id) REFERENCES product_revisions(merchant_id,id);
ALTER TABLE payment_orders ADD CONSTRAINT order_revision_tenant_fk FOREIGN KEY (merchant_id,observed_product_revision_id) REFERENCES product_revisions(merchant_id,id);
