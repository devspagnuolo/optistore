-- Smoke test for tenancy isolation, ledger balance and audit immutability.
-- Run as a superuser after 001_init.sql:  psql -v ON_ERROR_STOP=1 -f db/tests/rls_smoke.sql
-- Everything runs in one transaction and is rolled back.
BEGIN;

INSERT INTO companies (id, type, legal_name, trade_name, cnpj, status) VALUES
  ('00000000-0000-0000-0000-00000000000a','supplier','Sup A','Sup A','11111111000191','active'),
  ('00000000-0000-0000-0000-00000000000b','supplier','Sup B','Sup B','22222222000191','active'),
  ('00000000-0000-0000-0000-0000000000c1','reseller','Otica R','Otica R','33333333000191','active');

INSERT INTO rfqs (id, buyer_id, title, is_open) VALUES
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000c1','Private RFQ', false),
  ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000c1','Open RFQ', true);
INSERT INTO rfq_invitations (rfq_id, supplier_id, buyer_id) VALUES
  ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000c1');

-- ===== switch to the unprivileged runtime role =====
SET LOCAL ROLE optistore_app;

DO $$
DECLARE n int;
BEGIN
  -- Supplier A (invited): sees private + open
  PERFORM set_config('app.company_id','00000000-0000-0000-0000-00000000000a', true);
  SELECT count(*) INTO n FROM rfqs;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: invited supplier should see 2 RFQs, saw %', n; END IF;

  -- Supplier B (not invited): must see ONLY the open RFQ
  PERFORM set_config('app.company_id','00000000-0000-0000-0000-00000000000b', true);
  SELECT count(*) INTO n FROM rfqs WHERE title = 'Private RFQ';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: non-invited supplier can see private RFQ'; END IF;
  SELECT count(*) INTO n FROM rfqs;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: supplier B should see 1 RFQ, saw %', n; END IF;

  -- Buyer sees both of its RFQs
  PERFORM set_config('app.company_id','00000000-0000-0000-0000-0000000000c1', true);
  SELECT count(*) INTO n FROM rfqs;
  IF n <> 2 THEN RAISE EXCEPTION 'FAIL: buyer should see 2 RFQs, saw %', n; END IF;

  -- No tenant context => nothing visible
  PERFORM set_config('app.company_id','', true);
  SELECT count(*) INTO n FROM rfqs;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: no-context session saw % RFQs', n; END IF;
  SELECT count(*) INTO n FROM users;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: users must be system-only'; END IF;
  RAISE NOTICE 'PASS: RFQ visibility / tenant isolation';
END $$;

DO $$
DECLARE ok boolean := false;
BEGIN
  -- Tenant cannot write another tenant's rows
  PERFORM set_config('app.company_id','00000000-0000-0000-0000-00000000000b', true);
  BEGIN
    INSERT INTO products (supplier_id, name, category) VALUES ('00000000-0000-0000-0000-00000000000a','x','armacao');
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: cross-tenant insert was allowed'; END IF;
  RAISE NOTICE 'PASS: cross-tenant write blocked';
END $$;

DO $$
DECLARE ok boolean := false; aid uuid; bid uuid; tid uuid;
BEGIN
  -- Ledger: unbalanced transaction must be rejected; balanced one accepted
  PERFORM set_config('app.system','on', true);
  INSERT INTO ledger_accounts (code, company_id) VALUES ('t:a', NULL), ('t:b', NULL);
  SELECT id INTO aid FROM ledger_accounts WHERE code='t:a';
  SELECT id INTO bid FROM ledger_accounts WHERE code='t:b';
  INSERT INTO ledger_transactions (ref_type, ref_id) VALUES ('smoke', gen_random_uuid()) RETURNING id INTO tid;
  INSERT INTO ledger_entries (tx_id, account_id, amount_cents) VALUES (tid, aid, 100), (tid, bid, -100);
  SET CONSTRAINTS ALL IMMEDIATE;  -- balanced: OK
  SET CONSTRAINTS ALL DEFERRED;

  INSERT INTO ledger_transactions (ref_type, ref_id) VALUES ('smoke', gen_random_uuid()) RETURNING id INTO tid;
  BEGIN
    INSERT INTO ledger_entries (tx_id, account_id, amount_cents) VALUES (tid, aid, 100);
    SET CONSTRAINTS ALL IMMEDIATE;
  EXCEPTION WHEN raise_exception THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: unbalanced ledger tx accepted'; END IF;
  RAISE NOTICE 'PASS: ledger balance enforced';
END $$;

DO $$
DECLARE ok boolean := false;
BEGIN
  -- Audit log is append-only
  INSERT INTO audit_log (action, prev_hash, hash) VALUES ('smoke', repeat('0',64), repeat('1',64));
  BEGIN
    UPDATE audit_log SET action = 'tampered' WHERE action = 'smoke';
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN ok := true; END;
  IF NOT ok THEN RAISE EXCEPTION 'FAIL: audit_log update allowed'; END IF;
  RAISE NOTICE 'PASS: audit_log immutable';
END $$;

ROLLBACK;
