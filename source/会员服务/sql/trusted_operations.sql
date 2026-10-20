-- Operator-only entry points. Install as private-schema owner. No browser/BFF
-- member-operation whitelist includes these functions. One call = one transaction.
CREATE TABLE IF NOT EXISTS read_member_private.staged_assets (
  batch_id text NOT NULL, draft_id text NOT NULL, asset_id text NOT NULL,
  part integer NOT NULL, mime text NOT NULL, chunk text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(batch_id,asset_id,part)
);
REVOKE ALL ON read_member_private.staged_assets FROM PUBLIC, anon, authenticated;
GRANT SELECT,INSERT,DELETE ON read_member_private.staged_assets TO service_role;

CREATE OR REPLACE FUNCTION read_member_private.trusted_stage_asset(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE n integer; c text := p->>'chunk';
BEGIN
 IF p->>'batch_id' !~ '^[a-f0-9]{32}$' OR p->>'draft_id' !~ '^[A-Za-z0-9_-]{1,100}$'
    OR p->>'asset_id' !~ '^[A-Za-z0-9_-]{1,100}$' OR p->>'mime' NOT IN ('image/png','image/jpeg','image/webp')
    OR p->>'part' !~ '^(0|[1-9][0-9]{0,2})$' THEN
   RETURN jsonb_build_object('error','invalid_stage');
 END IF;
 n := (p->>'part')::integer;
 IF n>255 OR c IS NULL OR length(c)>196608 OR length(c)=0
    OR c !~ '^[A-Za-z0-9+/]*={0,2}$' OR length(c)%4<>0 THEN
   RETURN jsonb_build_object('error','invalid_chunk');
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(p->>'batch_id', 91848));
 -- Replays of a part must be byte-identical. No overwrite while a batch is in use.
 INSERT INTO read_member_private.staged_assets(batch_id,draft_id,asset_id,part,mime,chunk)
 VALUES(p->>'batch_id',p->>'draft_id',p->>'asset_id',n,p->>'mime',c)
 ON CONFLICT(batch_id,asset_id,part) DO NOTHING;
 IF NOT EXISTS (SELECT 1 FROM read_member_private.staged_assets s WHERE
   s.batch_id=p->>'batch_id' AND s.asset_id=p->>'asset_id' AND s.part=n
   AND s.draft_id=p->>'draft_id' AND s.mime=p->>'mime' AND s.chunk=c) THEN
   RETURN jsonb_build_object('error','stage_conflict');
 END IF;
 RETURN jsonb_build_object('ok',true,'part',n);
END $fn$;

CREATE OR REPLACE FUNCTION read_member_private.trusted_commit_draft(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE d record; a jsonb; encoded text; parts integer; bytes bytea; actual text;
        seen integer:=0; expected_parts integer:=0; aid text; batch text:=p->>'batch_id';
BEGIN
 IF p->>'draft_id' !~ '^[A-Za-z0-9_-]{1,100}$' OR p->>'version_hash' !~ '^[a-f0-9]{64}$'
   OR p->>'expected_version' !~ '^(absent|[a-f0-9]{64})$'
   OR batch !~ '^[a-f0-9]{32}$' OR length(p->>'title')>500
   OR length(p->>'body')>200000 OR jsonb_typeof(p->'assets')<>'array'
   OR jsonb_array_length(p->'assets')>100 THEN
   RETURN jsonb_build_object('error','invalid_draft');
 END IF;
 -- Lock even when this is the first import; advisory lock serializes two
 -- concurrent creations for the same identifier.
 PERFORM pg_advisory_xact_lock(hashtextextended(p->>'draft_id', 91847));
 PERFORM pg_advisory_xact_lock(hashtextextended(batch, 91848));
 SELECT version_hash INTO d FROM read_member_private.drafts WHERE id=p->>'draft_id' FOR UPDATE;
 IF (NOT FOUND AND p->>'expected_version'<>'absent') OR
    (FOUND AND p->>'expected_version' IS DISTINCT FROM d.version_hash) THEN
   RETURN jsonb_build_object('error','draft_version_conflict');
 END IF;
 IF EXISTS (SELECT 1 FROM read_member_private.staged_assets s WHERE s.batch_id=batch
   AND s.draft_id<>p->>'draft_id') THEN RETURN jsonb_build_object('error','batch_conflict'); END IF;
 -- Check every asset before touching the visible draft. A failed validation
 -- returns without deleting staging and without changing any visible row.
 FOR a IN SELECT value FROM jsonb_array_elements(p->'assets') LOOP
   aid:=a->>'id';
   IF aid !~ '^[A-Za-z0-9_-]{1,100}$' OR a->>'mime' NOT IN ('image/png','image/jpeg','image/webp')
      OR a->>'sha256' !~ '^[a-f0-9]{64}$' OR a->>'parts' !~ '^[1-9][0-9]{0,2}$'
      OR (a->>'parts')::integer>256 THEN RETURN jsonb_build_object('error','invalid_asset_manifest'); END IF;
   SELECT count(*),string_agg(s.chunk,'' ORDER BY s.part) INTO parts,encoded
     FROM read_member_private.staged_assets s WHERE s.batch_id=batch AND s.draft_id=p->>'draft_id'
       AND s.asset_id=aid AND s.mime=a->>'mime';
   IF parts<>(a->>'parts')::integer OR EXISTS (SELECT 1 FROM read_member_private.staged_assets s
     WHERE s.batch_id=batch AND s.asset_id=aid AND s.part<0) OR
     EXISTS (SELECT 1 FROM generate_series(0,parts-1) i WHERE NOT EXISTS
       (SELECT 1 FROM read_member_private.staged_assets s WHERE s.batch_id=batch
        AND s.asset_id=aid AND s.part=i)) THEN
     RETURN jsonb_build_object('error','incomplete_asset');
   END IF;
   bytes:=decode(encoded,'base64'); actual:=encode(sha256(bytes),'hex');
   IF octet_length(bytes)>20*1024*1024 OR actual<>a->>'sha256' THEN
     RETURN jsonb_build_object('error','asset_digest_mismatch');
   END IF;
   seen:=seen+1;
   expected_parts:=expected_parts+parts;
 END LOOP;
 IF (SELECT count(DISTINCT value->>'id') FROM jsonb_array_elements(p->'assets'))<>seen
    OR (SELECT count(DISTINCT s.asset_id) FROM read_member_private.staged_assets s WHERE s.batch_id=batch)<>seen
    OR (SELECT count(*) FROM read_member_private.staged_assets s WHERE s.batch_id=batch)<>expected_parts THEN
   RETURN jsonb_build_object('error','asset_manifest_mismatch');
 END IF;
 IF d.version_hash=p->>'version_hash' THEN
  IF EXISTS(SELECT 1 FROM read_member_private.drafts WHERE id=p->>'draft_id' AND (body IS DISTINCT FROM p->>'body' OR title IS DISTINCT FROM p->>'title'))
    OR (SELECT count(*) FROM read_member_private.assets WHERE draft_id=p->>'draft_id')<>seen
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'assets') m WHERE NOT EXISTS(
      SELECT 1 FROM read_member_private.assets a WHERE a.draft_id=p->>'draft_id' AND a.id=m->>'id'
      AND a.mime=m->>'mime' AND encode(sha256(decode(a.payload,'base64')),'hex')=m->>'sha256')) THEN
   RETURN jsonb_build_object('error','version_hash_collision'); END IF;
  DELETE FROM read_member_private.staged_assets WHERE batch_id=batch;
  RETURN jsonb_build_object('ok',true,'version_hash',p->>'version_hash','assets',seen,'unchanged',true);
 END IF;
 INSERT INTO read_member_private.drafts(id,version_hash,title,body)
 VALUES(p->>'draft_id',p->>'version_hash',p->>'title',p->>'body')
 ON CONFLICT(id) DO UPDATE SET version_hash=excluded.version_hash,title=excluded.title,body=excluded.body;
 DELETE FROM read_member_private.assets WHERE draft_id=p->>'draft_id';
 FOR a IN SELECT value FROM jsonb_array_elements(p->'assets') LOOP
   SELECT string_agg(s.chunk,'' ORDER BY s.part) INTO encoded
     FROM read_member_private.staged_assets s WHERE s.batch_id=batch AND s.asset_id=a->>'id';
   INSERT INTO read_member_private.assets(draft_id,id,version_hash,mime,payload)
   VALUES(p->>'draft_id',a->>'id',p->>'version_hash',a->>'mime',encoded);
 END LOOP;
 DELETE FROM read_member_private.staged_assets WHERE batch_id=batch;
 RETURN jsonb_build_object('ok',true,'version_hash',p->>'version_hash','assets',seen);
END $fn$;

-- The caller must pass an explicit list of IDs already approved for public
-- catalog inclusion. This updates catalog metadata only, never publishes a draft.
CREATE OR REPLACE FUNCTION read_member_private.trusted_catalog_upsert(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE current_version text;
BEGIN
 IF p->>'article_id' !~ '^[A-Za-z0-9_-]{1,100}$' OR p->>'version_hash' !~ '^[a-f0-9]{64}$'
    OR p->>'review_version_hash' !~ '^[a-f0-9]{64}$'
    OR p->>'article_id' <> p->>'explicit_public_id' THEN
   RETURN jsonb_build_object('error','not_explicitly_public');
 END IF;
 SELECT d.version_hash INTO current_version FROM read_member_private.drafts d
   WHERE d.id=p->>'article_id' FOR SHARE;
 IF current_version IS DISTINCT FROM p->>'review_version_hash' THEN
   RETURN jsonb_build_object('error','draft_version_conflict');
 END IF;
 INSERT INTO read_member_private.articles(id,version_hash,published)
 VALUES(p->>'article_id',p->>'version_hash',1)
 ON CONFLICT(id) DO UPDATE SET version_hash=excluded.version_hash,published=1;
 RETURN jsonb_build_object('ok',true);
END $fn$;

CREATE OR REPLACE FUNCTION read_member_private.trusted_review_snapshot(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE result jsonb;
BEGIN
 SELECT jsonb_build_object('version_hash',d.version_hash,'reviews',coalesce((
   SELECT jsonb_agg(jsonb_build_object('id',r.id,'uid',r.uid,'draft_id',r.draft_id,
   'version_hash',r.version_hash,'decision',r.decision,'created_at',r.created_at)
   ORDER BY r.created_at DESC,r.id DESC) FROM read_member_private.reviews r WHERE r.draft_id=d.id
 ),'[]'::jsonb)) INTO result FROM read_member_private.drafts d WHERE d.id=p->>'article_id';
 RETURN coalesce(result,jsonb_build_object('error','draft_not_found'));
END $fn$;

CREATE OR REPLACE FUNCTION read_member_private.trusted_feedback_page(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE items jsonb; last_item jsonb;
BEGIN
 SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at,e.id),'[]'::jsonb)
 INTO items FROM (SELECT * FROM (
   SELECT r.id,r.uid,r.draft_id,r.version_hash,r.decision AS event_type,
     r.comment,r.created_at,''::text AS target_type,''::text AS target_id,
     ''::text AS quote FROM read_member_private.reviews r
   UNION ALL
   SELECT f.id,f.uid,f.draft_id,f.version_hash,'feedback'::text AS event_type,
     f.comment,f.created_at,f.target_type,f.target_id,f.quote
     FROM read_member_private.feedback f) e0
   WHERE e0.created_at>coalesce(p->>'after','') OR
     (e0.created_at=coalesce(p->>'after','') AND e0.id>coalesce(p->>'after_id',''))
   ORDER BY e0.created_at,e0.id LIMIT 200) e;
 SELECT value INTO last_item FROM jsonb_array_elements(items) WITH ORDINALITY t(value,n)
   ORDER BY n DESC LIMIT 1;
 RETURN jsonb_build_object('events',items,'cursor',CASE WHEN last_item IS NULL
   THEN jsonb_build_object('after',coalesce(p->>'after',''),'after_id',coalesce(p->>'after_id',''))
   ELSE jsonb_build_object('after',last_item->>'created_at','after_id',last_item->>'id') END);
END $fn$;

-- A real upstream identity check is required by the Python operator helper.
-- This DB guard additionally requires a live local session for that UID/email.
CREATE OR REPLACE FUNCTION read_member_private.trusted_grant_admin(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN
 IF p->>'uid' IS NULL OR p->>'email' IS NULL THEN
   RETURN jsonb_build_object('error','verified_session_required');
 END IF;
 PERFORM 1 FROM read_member_private.sessions s WHERE s.uid=p->>'uid'
   AND lower(s.email)=lower(p->>'email') AND s.revoked=0
   AND s.expires_at>extract(epoch from clock_timestamp())::bigint FOR SHARE;
 IF NOT FOUND THEN
   RETURN jsonb_build_object('error','verified_session_required');
 END IF;
 INSERT INTO read_member_private.admins(uid) VALUES(p->>'uid') ON CONFLICT(uid) DO NOTHING;
 RETURN jsonb_build_object('ok',true,'uid',p->>'uid');
END $fn$;

REVOKE ALL ON FUNCTION read_member_private.trusted_stage_asset(jsonb),
 read_member_private.trusted_commit_draft(jsonb),read_member_private.trusted_catalog_upsert(jsonb),
 read_member_private.trusted_review_snapshot(jsonb),read_member_private.trusted_feedback_page(jsonb),
 read_member_private.trusted_grant_admin(jsonb)
 FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION read_member_private.trusted_stage_asset(jsonb),
 read_member_private.trusted_commit_draft(jsonb),read_member_private.trusted_catalog_upsert(jsonb),
 read_member_private.trusted_review_snapshot(jsonb),read_member_private.trusted_feedback_page(jsonb),
 read_member_private.trusted_grant_admin(jsonb)
 TO service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON read_member_private.drafts,read_member_private.assets,
 read_member_private.articles TO service_role;
GRANT SELECT,INSERT ON read_member_private.admins TO service_role;
