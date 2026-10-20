-- Private editorial metadata is independent of scientific content and approval hashes.
CREATE TABLE IF NOT EXISTS read_member_private.export_plans (
 draft_id text NOT NULL, source text NOT NULL CHECK(source IN ('draft','published','static')),
 version_hash text NOT NULL, plan jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(draft_id,source)
);
REVOKE ALL ON read_member_private.export_plans FROM PUBLIC,anon,authenticated;
ALTER TABLE read_member_private.export_plans ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT,UPDATE ON read_member_private.export_plans TO service_role;
CREATE OR REPLACE FUNCTION read_member_private.export_plan(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE current_hash text; result jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM read_member_private.admins WHERE uid=p->>'uid') THEN
  RETURN jsonb_build_object('error','admin_required'); END IF;
 IF p->>'source'='history' THEN
  IF p ? 'plan' THEN RETURN jsonb_build_object('error','historical_version_read_only'); END IF;
  IF NOT EXISTS(SELECT 1 FROM read_member_private.draft_versions WHERE draft_id=p->>'draft_id' AND version_hash=p->>'version_hash') AND NOT EXISTS(SELECT 1 FROM read_member_private.drafts WHERE id=p->>'draft_id' AND version_hash=p->>'version_hash') THEN RETURN jsonb_build_object('error','draft_not_found'); END IF;
  RETURN jsonb_build_object('plan',null);
 END IF;
 IF p->>'source'='draft' THEN
  SELECT version_hash INTO current_hash FROM read_member_private.drafts WHERE id=p->>'draft_id' FOR SHARE;
 ELSIF p->>'source'='published' THEN
  SELECT review_version_hash INTO current_hash FROM read_member_private.publication_heads WHERE id=p->>'draft_id' FOR SHARE;
 ELSIF p->>'source'='static' THEN
  SELECT version_hash INTO current_hash FROM read_member_private.articles WHERE id=p->>'draft_id' AND published=1 FOR SHARE;
 END IF;
 IF current_hash IS NULL THEN RETURN jsonb_build_object('error','article_not_found'); END IF;
 IF current_hash IS DISTINCT FROM p->>'version_hash' THEN RETURN jsonb_build_object('error','version_mismatch'); END IF;
 IF p ? 'plan' THEN
  INSERT INTO read_member_private.export_plans(draft_id,source,version_hash,plan)
  VALUES(p->>'draft_id',p->>'source',current_hash,p->'plan')
  ON CONFLICT(draft_id,source) DO UPDATE SET version_hash=excluded.version_hash,plan=excluded.plan,updated_at=now();
 END IF;
 SELECT plan INTO result FROM read_member_private.export_plans WHERE draft_id=p->>'draft_id'
  AND source=p->>'source' AND version_hash=current_hash;
 RETURN jsonb_build_object('plan',result);
END $fn$;
REVOKE ALL ON FUNCTION read_member_private.export_plan(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION read_member_private.export_plan(jsonb) TO service_role;
