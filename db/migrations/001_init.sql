-- OptiStore MVP schema (V1). PostgreSQL 15+ (uses UNIQUE NULLS NOT DISTINCT).
-- Multi-tenancy: every private row carries a company id; RLS enforces isolation.
-- The API sets, per transaction: app.company_id, app.user_id and (auth/system flows only) app.system.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------- helpers ----------
CREATE OR REPLACE FUNCTION app_company() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('app.company_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_is_system() RETURNS boolean LANGUAGE sql STABLE AS
$$ SELECT COALESCE(current_setting('app.system', true), '') = 'on' $$;
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
CREATE OR REPLACE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS
$$ BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;

-- ---------- enums ----------
CREATE TYPE company_type    AS ENUM ('supplier','reseller','consumer');
CREATE TYPE company_status  AS ENUM ('pending_kyc','active','suspended');
CREATE TYPE member_role     AS ENUM ('owner','admin','buyer','seller','finance','viewer');
CREATE TYPE product_status  AS ENUM ('draft','published','archived');
CREATE TYPE rfq_status      AS ENUM ('open','closed','awarded','cancelled');
CREATE TYPE quote_status    AS ENUM ('submitted','accepted','rejected','withdrawn');
CREATE TYPE order_status    AS ENUM ('pending_payment','paid','shipped','delivered','cancelled');
CREATE TYPE stock_move_type AS ENUM ('in','out','adjust');

-- ---------- identity ----------
CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type        company_type NOT NULL,
  legal_name  text NOT NULL,
  trade_name  text,
  cnpj        text UNIQUE CHECK (cnpj ~ '^[0-9]{14}$'),
  status      company_status NOT NULL DEFAULT 'pending_kyc',
  plan        text NOT NULL DEFAULT 'free',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_companies_upd BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          citext NOT NULL UNIQUE,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  mfa_enabled    boolean NOT NULL DEFAULT false,
  mfa_secret_enc text,                          -- AES-256-GCM, app-level (iv.tag.ciphertext, base64)
  failed_logins  int NOT NULL DEFAULT 0,
  locked_until   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role        member_role NOT NULL,
  PRIMARY KEY (user_id, company_id)
);

-- ---------- audit (append-only, hash-chained) ----------
CREATE TABLE audit_log (
  seq         bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  company_id  uuid,
  user_id     uuid,
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  payload     jsonb NOT NULL DEFAULT '{}',
  prev_hash   text NOT NULL,
  hash        text NOT NULL
);
CREATE TRIGGER trg_audit_no_mod BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION append_only();
CREATE TRIGGER trg_audit_no_trunc BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION append_only();

-- ---------- catalog ----------
CREATE TABLE products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id  uuid NOT NULL REFERENCES companies(id),
  name         text NOT NULL,
  brand        text,
  category     text NOT NULL,                 -- armacao, lente, solar, acessorio...
  description  text,
  attributes   jsonb NOT NULL DEFAULT '{}',
  status       product_status NOT NULL DEFAULT 'draft',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
-- Full-text search (Portuguese). Expression index avoids generated-column immutability pitfalls.
CREATE INDEX idx_products_fts ON products USING gin (
  to_tsvector('portuguese', coalesce(name,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(description,''))
);
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);
CREATE INDEX idx_products_supplier  ON products (supplier_id, status);
CREATE TRIGGER trg_products_upd BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_variants (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id             uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  supplier_id            uuid NOT NULL REFERENCES companies(id),
  sku                    text NOT NULL,
  attributes             jsonb NOT NULL DEFAULT '{}',   -- cor, tamanho, grau
  wholesale_price_cents  bigint NOT NULL CHECK (wholesale_price_cents >= 0),
  retail_price_cents     bigint CHECK (retail_price_cents >= 0),
  moq                    int NOT NULL DEFAULT 1 CHECK (moq >= 1),
  UNIQUE (supplier_id, sku)
);

-- Wholesale tiers: unit price from min_qty upward
CREATE TABLE price_tiers (
  variant_id   uuid NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  min_qty      int NOT NULL CHECK (min_qty >= 1),
  price_cents  bigint NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (variant_id, min_qty)
);

-- ---------- inventory (movement-based; never overwrite a counter) ----------
CREATE TABLE stock_movements (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id),
  variant_id  uuid NOT NULL REFERENCES product_variants(id),
  type        stock_move_type NOT NULL,
  quantity    int NOT NULL CHECK (quantity <> 0),    -- signed: + in, - out
  ref_type    text,
  ref_id      uuid,
  note        text,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_stock_mov ON stock_movements (company_id, variant_id);
CREATE TRIGGER trg_stock_no_mod BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION append_only();

CREATE TABLE stock_reservations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id),
  variant_id   uuid NOT NULL REFERENCES product_variants(id),
  quantity     int NOT NULL CHECK (quantity > 0),
  order_id     uuid,
  released_at  timestamptz
);

CREATE VIEW stock_levels WITH (security_invoker = true) AS
SELECT m.company_id, m.variant_id,
       SUM(m.quantity)::int AS on_hand,
       COALESCE((SELECT SUM(r.quantity) FROM stock_reservations r
                 WHERE r.company_id = m.company_id AND r.variant_id = m.variant_id
                   AND r.released_at IS NULL), 0)::int AS reserved
FROM stock_movements m
GROUP BY m.company_id, m.variant_id;

-- ---------- RFQ ----------
CREATE TABLE rfqs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id    uuid NOT NULL REFERENCES companies(id),
  title       text NOT NULL,
  notes       text,
  status      rfq_status NOT NULL DEFAULT 'open',
  is_open     boolean NOT NULL DEFAULT true,   -- true: any active supplier may quote; false: invited only
  deadline    timestamptz,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rfq_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id       uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  description  text NOT NULL,
  quantity     int NOT NULL CHECK (quantity > 0),
  variant_id   uuid REFERENCES product_variants(id)
);
-- Invited-only RFQs (rfqs.is_open = false). buyer_id is denormalized so this table's
-- policies never reference rfqs (which would create infinite policy recursion).
CREATE TABLE rfq_invitations (
  rfq_id       uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id  uuid NOT NULL REFERENCES companies(id),
  buyer_id     uuid NOT NULL REFERENCES companies(id),
  PRIMARY KEY (rfq_id, supplier_id)
);
CREATE TABLE quotes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rfq_id          uuid NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
  supplier_id     uuid NOT NULL REFERENCES companies(id),
  status          quote_status NOT NULL DEFAULT 'submitted',
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  lead_time_days  int,
  valid_until     timestamptz,
  message         text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rfq_id, supplier_id)
);
CREATE TABLE quote_items (
  quote_id          uuid NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  rfq_item_id       uuid NOT NULL REFERENCES rfq_items(id) ON DELETE CASCADE,
  unit_price_cents  bigint NOT NULL CHECK (unit_price_cents >= 0),
  PRIMARY KEY (quote_id, rfq_item_id)
);

-- ---------- orders ----------
CREATE TABLE orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_id          uuid NOT NULL REFERENCES companies(id),
  supplier_id       uuid NOT NULL REFERENCES companies(id),
  quote_id          uuid UNIQUE REFERENCES quotes(id),
  status            order_status NOT NULL DEFAULT 'pending_payment',
  total_cents       bigint NOT NULL CHECK (total_cents >= 0),
  commission_cents  bigint NOT NULL CHECK (commission_cents >= 0),
  take_rate_bps     int NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  paid_at           timestamptz
);
CREATE TABLE order_items (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  description       text NOT NULL,
  variant_id        uuid REFERENCES product_variants(id),
  quantity          int NOT NULL CHECK (quantity > 0),
  unit_price_cents  bigint NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE INDEX idx_orders_buyer    ON orders (buyer_id, created_at DESC);
CREATE INDEX idx_orders_supplier ON orders (supplier_id, created_at DESC);

-- ---------- double-entry ledger ----------
CREATE TABLE ledger_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL,                  -- e.g. platform:revenue, supplier:payable
  company_id  uuid REFERENCES companies(id),  -- NULL = platform account
  UNIQUE NULLS NOT DISTINCT (code, company_id)
);
CREATE TABLE ledger_transactions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_type    text NOT NULL,
  ref_id      uuid NOT NULL,
  memo        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ref_type, ref_id)                   -- idempotency: one posting per business event
);
CREATE TABLE ledger_entries (
  id            bigserial PRIMARY KEY,
  tx_id         uuid NOT NULL REFERENCES ledger_transactions(id),
  account_id    uuid NOT NULL REFERENCES ledger_accounts(id),
  amount_cents  bigint NOT NULL CHECK (amount_cents <> 0)   -- + debit, - credit
);
CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s bigint;
BEGIN
  SELECT COALESCE(SUM(amount_cents), 0) INTO s FROM ledger_entries WHERE tx_id = NEW.tx_id;
  IF s <> 0 THEN
    RAISE EXCEPTION 'ledger tx % not balanced (sum=%)', NEW.tx_id, s;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER trg_ledger_balanced AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
CREATE TRIGGER trg_ledger_no_mod BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION append_only();

-- =====================================================================
-- ROW LEVEL SECURITY
-- =====================================================================
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies FORCE  ROW LEVEL SECURITY;
CREATE POLICY companies_own ON companies
  USING (app_is_system() OR id = app_company())
  WITH CHECK (app_is_system() OR id = app_company());
CREATE POLICY companies_public_read ON companies FOR SELECT
  USING (status = 'active' AND app_company() IS NOT NULL);

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE  ROW LEVEL SECURITY;
CREATE POLICY users_sys ON users USING (app_is_system()) WITH CHECK (app_is_system());

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE  ROW LEVEL SECURITY;
CREATE POLICY memberships_rw ON memberships
  USING (app_is_system() OR company_id = app_company())
  WITH CHECK (app_is_system() OR company_id = app_company());

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE  ROW LEVEL SECURITY;
CREATE POLICY products_owner ON products
  USING (supplier_id = app_company()) WITH CHECK (supplier_id = app_company());
CREATE POLICY products_public ON products FOR SELECT
  USING (status = 'published' AND app_company() IS NOT NULL);

ALTER TABLE product_variants ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_variants FORCE  ROW LEVEL SECURITY;
CREATE POLICY variants_owner ON product_variants
  USING (supplier_id = app_company()) WITH CHECK (supplier_id = app_company());
CREATE POLICY variants_public ON product_variants FOR SELECT
  USING (app_company() IS NOT NULL AND EXISTS
         (SELECT 1 FROM products p WHERE p.id = product_id AND p.status = 'published'));

ALTER TABLE price_tiers ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_tiers FORCE  ROW LEVEL SECURITY;
CREATE POLICY tiers_owner ON price_tiers
  USING (EXISTS (SELECT 1 FROM product_variants v WHERE v.id = variant_id AND v.supplier_id = app_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM product_variants v WHERE v.id = variant_id AND v.supplier_id = app_company()));
CREATE POLICY tiers_public ON price_tiers FOR SELECT
  USING (app_company() IS NOT NULL AND EXISTS (SELECT 1 FROM product_variants v WHERE v.id = variant_id));

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE  ROW LEVEL SECURITY;
CREATE POLICY stock_mov_own ON stock_movements
  USING (company_id = app_company()) WITH CHECK (company_id = app_company());
ALTER TABLE stock_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_reservations FORCE  ROW LEVEL SECURITY;
CREATE POLICY stock_res_own ON stock_reservations
  USING (company_id = app_company()) WITH CHECK (company_id = app_company());

ALTER TABLE rfqs ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfqs FORCE  ROW LEVEL SECURITY;
CREATE POLICY rfqs_buyer ON rfqs
  USING (buyer_id = app_company()) WITH CHECK (buyer_id = app_company());
CREATE POLICY rfqs_supplier_read ON rfqs FOR SELECT
  USING (status = 'open' AND (
    (is_open AND EXISTS (SELECT 1 FROM companies c WHERE c.id = app_company() AND c.type = 'supplier'))
    OR EXISTS (SELECT 1 FROM rfq_invitations i WHERE i.rfq_id = rfqs.id AND i.supplier_id = app_company())));

ALTER TABLE rfq_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY rfq_items_read ON rfq_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_id));
CREATE POLICY rfq_items_write ON rfq_items FOR ALL
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_id AND r.buyer_id = app_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_id AND r.buyer_id = app_company()));

ALTER TABLE rfq_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE rfq_invitations FORCE  ROW LEVEL SECURITY;
CREATE POLICY rfq_inv_read ON rfq_invitations FOR SELECT
  USING (supplier_id = app_company() OR buyer_id = app_company());
CREATE POLICY rfq_inv_write ON rfq_invitations FOR ALL
  USING (buyer_id = app_company()) WITH CHECK (buyer_id = app_company());

ALTER TABLE quotes ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes FORCE  ROW LEVEL SECURITY;
CREATE POLICY quotes_supplier ON quotes
  USING (supplier_id = app_company()) WITH CHECK (supplier_id = app_company());
CREATE POLICY quotes_buyer_read ON quotes FOR SELECT
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_id AND r.buyer_id = app_company()));
CREATE POLICY quotes_buyer_update ON quotes FOR UPDATE
  USING (EXISTS (SELECT 1 FROM rfqs r WHERE r.id = rfq_id AND r.buyer_id = app_company()));

ALTER TABLE quote_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY quote_items_read ON quote_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_id));
CREATE POLICY quote_items_write ON quote_items FOR ALL
  USING (EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_id AND q.supplier_id = app_company()))
  WITH CHECK (EXISTS (SELECT 1 FROM quotes q WHERE q.id = quote_id AND q.supplier_id = app_company()));

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders FORCE  ROW LEVEL SECURITY;
CREATE POLICY orders_select ON orders FOR SELECT
  USING (app_is_system() OR buyer_id = app_company() OR supplier_id = app_company());
CREATE POLICY orders_insert ON orders FOR INSERT
  WITH CHECK (buyer_id = app_company());
-- Either party (or system, e.g. payment webhook) may update; state transitions are enforced in the API.
CREATE POLICY orders_update ON orders FOR UPDATE
  USING (app_is_system() OR buyer_id = app_company() OR supplier_id = app_company())
  WITH CHECK (app_is_system() OR buyer_id = app_company() OR supplier_id = app_company());
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items FORCE  ROW LEVEL SECURITY;
CREATE POLICY order_items_read ON order_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id));
CREATE POLICY order_items_write ON order_items FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM orders o WHERE o.id = order_id AND o.buyer_id = app_company()));

-- Ledger: written only in system context; tenants read their own accounts' entries
ALTER TABLE ledger_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_accounts FORCE  ROW LEVEL SECURITY;
CREATE POLICY la_read  ON ledger_accounts FOR SELECT USING (app_is_system() OR company_id = app_company());
CREATE POLICY la_write ON ledger_accounts FOR INSERT WITH CHECK (app_is_system());
ALTER TABLE ledger_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_transactions FORCE  ROW LEVEL SECURITY;
CREATE POLICY lt_sys ON ledger_transactions USING (app_is_system()) WITH CHECK (app_is_system());
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE  ROW LEVEL SECURITY;
CREATE POLICY le_read ON ledger_entries FOR SELECT
  USING (app_is_system() OR EXISTS
         (SELECT 1 FROM ledger_accounts a WHERE a.id = account_id AND a.company_id = app_company()));
CREATE POLICY le_write ON ledger_entries FOR INSERT WITH CHECK (app_is_system());

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE  ROW LEVEL SECURITY;
CREATE POLICY audit_insert ON audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY audit_read   ON audit_log FOR SELECT
  USING (app_is_system() OR company_id = app_company());

-- ---------- runtime role (no BYPASSRLS, not owner) ----------
-- Password is a placeholder: set it via your secret manager after running the migration.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'optistore_app') THEN
    CREATE ROLE optistore_app LOGIN PASSWORD 'change-me' NOBYPASSRLS;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO optistore_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO optistore_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO optistore_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log, ledger_entries, stock_movements FROM optistore_app;
