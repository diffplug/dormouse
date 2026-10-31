-- The relay and voice Workers' Postgres roles (docs/specs/hosted.md ->
-- "Application boundary"): each reaches only the rows its Worker's queries
-- name. The account Worker keeps its own runtime role; the one grant made to
-- it here is at the end.
--
-- The rule: every privilege either role holds on this database's schemas,
-- tables, sequences and functions is granted below, by name, and nothing
-- else. No default privileges, so a table a later migration creates is
-- unreachable until a GRANT here names it; a query that needs one gets SQLSTATE
-- 42501 under hosted/server/tests. Column lists narrow a grant to the columns
-- the code reads or writes. A grant some other role made is beyond a REVOKE
-- here; hosted/server/tests/runtime-roles.test.ts pins the result.
--
-- Applied as the migration role by `db:migrate`, after every migration, and
-- alone by `db:roles`: one transaction, idempotent. It creates a missing role
-- NOLOGIN, refuses one holding a role attribute or membership, and never
-- alters an existing one, so LOGIN and a password set out of band survive; it
-- then revokes everything either role holds and grants exactly the list.
-- Never put a password here.

BEGIN;

DO $$
DECLARE
  role_name text;
  schema_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['dormouse_relay', 'dormouse_voice'] LOOP
    -- Checked first: CREATE ROLE needs CREATEROLE even when the role exists.
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = role_name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      EXCEPTION
        -- A concurrent creator won.
        WHEN duplicate_object OR unique_violation THEN NULL;
      END;
    END IF;
    -- A role made elsewhere (Neon's Console grants neon_superuser) must carry
    -- no power of its own and inherit none.
    IF EXISTS (
      SELECT FROM pg_roles r
      WHERE r.rolname = role_name
        AND (r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls
          OR EXISTS (SELECT FROM pg_auth_members m WHERE m.member = r.oid))
    ) THEN
      RAISE EXCEPTION 'Role % has privileges beyond hosted/server/runtime-roles.sql; recreate it with SQL', role_name;
    END IF;
  END LOOP;
  EXECUTE format('REVOKE ALL ON DATABASE %I FROM dormouse_relay, dormouse_voice', current_database());
  FOR schema_name IN
    SELECT nspname FROM pg_namespace
    WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM dormouse_relay, dormouse_voice', schema_name);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM dormouse_relay, dormouse_voice', schema_name);
    EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA %I FROM dormouse_relay, dormouse_voice', schema_name);
    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM dormouse_relay, dormouse_voice', schema_name);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO dormouse_relay, dormouse_voice;

-- Both: the entitlement (hosted/server/entitlement.ts) reads the owner's
-- address and its verification, until when @pgstencil/stripe's owner_access
-- view grants the owner access, and whether a payment dispute suspends them.
-- The view runs with its owner's privileges, so neither role reads the
-- subscriptions table beneath it.
GRANT SELECT (id, email, "emailVerified") ON "user" TO dormouse_relay, dormouse_voice;
GRANT USAGE ON SCHEMA pgstencil_billing TO dormouse_relay, dormouse_voice;
GRANT SELECT (owner_id, access_until)
  ON pgstencil_billing.owner_access TO dormouse_relay, dormouse_voice;
GRANT SELECT ("userId") ON dormouse_billing_disputes TO dormouse_relay, dormouse_voice;

-- Both: their metrics' upsert-increment (hosted/server/metrics.ts), whose
-- conflict needs the read. A row is an aggregate count.
GRANT SELECT, INSERT ON dormouse_metrics_daily TO dormouse_relay, dormouse_voice;
GRANT UPDATE (count) ON dormouse_metrics_daily TO dormouse_relay, dormouse_voice;

-- The relay Worker, its Cron sweep, and its RelayRoom's RelayRows.
GRANT SELECT, INSERT ON dormouse_relay_burrows TO dormouse_relay;
-- Only for the push subscribe's FOR KEY SHARE, which needs UPDATE on some
-- column; "enrolledAt" orders the Burrow list and nothing else.
GRANT UPDATE ("enrolledAt") ON dormouse_relay_burrows TO dormouse_relay;
GRANT SELECT, INSERT ON dormouse_relay_passkeys TO dormouse_relay;
GRANT SELECT, INSERT, DELETE ON
  dormouse_relay_sessions,
  dormouse_relay_challenges,
  dormouse_relay_presence_nonces,
  dormouse_relay_setup_tokens
  TO dormouse_relay;
-- A finish claims its setup token in place, so a retire can still reach it.
GRANT UPDATE (claimed) ON dormouse_relay_setup_tokens TO dormouse_relay;
-- The account Worker inserts approvals; the poll redeems one or marks its
-- digits mismatched, the sweep deletes.
GRANT SELECT, DELETE ON dormouse_relay_enrollment_approvals TO dormouse_relay;
GRANT UPDATE ("redeemedBurrowId", "redeemedAt", "mismatchedAt") ON dormouse_relay_enrollment_approvals TO dormouse_relay;
GRANT SELECT, INSERT, DELETE ON dormouse_relay_push_subscriptions TO dormouse_relay;
GRANT UPDATE (endpoint, p256dh, auth, "vapidPublicKey", "subscribedAt")
  ON dormouse_relay_push_subscriptions TO dormouse_relay;
-- A voice approval mints only a token: no read, revocation, or count.
GRANT INSERT ("userId", hash) ON dormouse_voice_tokens TO dormouse_relay;

-- The voice Worker: speak's token lookup and idle expiry, a disconnecting
-- computer's own delete, the daily count, and the daily sweep.
GRANT SELECT (id, "userId", hash, "createdAt", "lastUsedAt") ON dormouse_voice_tokens TO dormouse_voice;
GRANT UPDATE ("lastUsedAt") ON dormouse_voice_tokens TO dormouse_voice;
GRANT DELETE ON dormouse_voice_tokens TO dormouse_voice;
GRANT SELECT, INSERT, DELETE ON dormouse_voice_usage TO dormouse_voice;
GRANT UPDATE (count) ON dormouse_voice_usage TO dormouse_voice;

-- The account Worker's role, made by hand (hosted/README.md), owns billing:
-- @pgstencil/stripe reads and writes every pgstencil_billing table, and the
-- entitlement reads its owner_access view, which ALL TABLES covers. Granted here, after every migration,
-- because its schema is the package's and no hand grant can precede it.
-- Additive only: nothing here revokes from it, and a database without the
-- role (tests, previews) skips it.
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dormouse_app') THEN
    GRANT USAGE ON SCHEMA pgstencil_billing TO dormouse_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA pgstencil_billing TO dormouse_app;
  END IF;
END
$$;

COMMIT;
