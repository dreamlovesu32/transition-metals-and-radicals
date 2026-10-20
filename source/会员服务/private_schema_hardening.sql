-- Apply only inside explicit PostgresStore.initialize(), never automatically at import.
-- All tables reside in a non-public schema absent from CloudBase public PostgREST.
REVOKE ALL ON SCHEMA read_member_private FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA read_member_private FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA read_member_private FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA read_member_private REVOKE ALL ON TABLES FROM PUBLIC;
DO $$
DECLARE role_name TEXT; table_name TEXT;
BEGIN
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','anonymous','authenticated') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA read_member_private FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA read_member_private FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA read_member_private FROM %I',role_name);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA read_member_private REVOKE ALL ON TABLES FROM %I',role_name);
  END LOOP;
  FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname='read_member_private' LOOP
    EXECUTE format('ALTER TABLE read_member_private.%I ENABLE ROW LEVEL SECURITY',table_name);
  END LOOP;
END $$;
-- No client RLS policy is created: non-owner clients have no rows and no schema usage.
-- Execute using a dedicated BFF schema owner; do not grant that role to anon/authenticated.
