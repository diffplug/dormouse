-- The relay and voice Workers' Postgres roles (docs/specs/hosted.md ->
-- "Application boundary"): each reaches only the rows its Worker's queries
-- name. The account Worker keeps its own runtime role.
--
-- The rule: every privilege either role holds is granted below, by name, and
-- nothing else. No default privileges, so a table a later migration creates is
-- unreachable until a GRANT here names it; a query that needs one gets SQLSTATE
-- 42501 under hosted/server/tests. Column lists narrow a grant to the columns
-- the code reads or writes.
--
-- Applied as the migration role by `db:migrate`, after every migration, and
-- alone by `db:roles`: one transaction, idempotent. It creates a missing role
-- NOLOGIN, refuses one holding a role attribute or membership, and never
-- alters an existing one, so LOGIN and a password set out of band survive; it
-- then revokes everything either role holds in the schema and grants exactly
-- the list. Never put a password here.

BEGIN;

DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['dormouse_relay', 'dormouse_voice'] LOOP
    BEGIN
      EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
    EXCEPTION
      -- Exists already; a concurrent creator surfaces as unique_violation.
      WHEN duplicate_object OR unique_violation THEN NULL;
    END;
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
END
$$;

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM dormouse_relay, dormouse_voice;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM dormouse_relay, dormouse_voice;
REVOKE ALL ON SCHEMA public FROM dormouse_relay, dormouse_voice;
GRANT USAGE ON SCHEMA public TO dormouse_relay, dormouse_voice;

-- Both: the entitlement check reads the owner's address and its verification.
GRANT SELECT (id, email, "emailVerified") ON "user" TO dormouse_relay, dormouse_voice;

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
-- The account Worker inserts approvals; the poll redeems one, the sweep deletes.
GRANT SELECT, DELETE ON dormouse_relay_enrollment_approvals TO dormouse_relay;
GRANT UPDATE ("redeemedBurrowId", "redeemedAt") ON dormouse_relay_enrollment_approvals TO dormouse_relay;
GRANT SELECT, INSERT, DELETE ON dormouse_relay_push_subscriptions TO dormouse_relay;
GRANT UPDATE (endpoint, p256dh, auth, "vapidPublicKey", "subscribedAt")
  ON dormouse_relay_push_subscriptions TO dormouse_relay;

-- The voice Worker: speak's token lookup and the daily count.
GRANT SELECT (id, "userId", hash, "revokedAt") ON dormouse_voice_tokens TO dormouse_voice;
GRANT UPDATE ("lastUsedAt") ON dormouse_voice_tokens TO dormouse_voice;
GRANT SELECT, INSERT ON dormouse_voice_usage TO dormouse_voice;
GRANT UPDATE (count) ON dormouse_voice_usage TO dormouse_voice;

COMMIT;
