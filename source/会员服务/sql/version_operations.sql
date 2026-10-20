CREATE TABLE IF NOT EXISTS read_member_private.version_notes(draft_id text NOT NULL,version_hash text NOT NULL,note text NOT NULL,PRIMARY KEY(draft_id,version_hash));
REVOKE ALL ON read_member_private.version_notes FROM PUBLIC,anon,authenticated;
ALTER TABLE read_member_private.version_notes ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON read_member_private.version_notes TO service_role;
CREATE OR REPLACE FUNCTION read_member_private.trusted_set_version_note(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN
 IF length(p->>'note')>500 OR nullif(p->>'note','') IS NULL THEN RETURN jsonb_build_object('error','invalid_note'); END IF;
 IF NOT EXISTS(SELECT 1 FROM read_member_private.drafts WHERE id=p->>'draft_id' AND version_hash=p->>'version_hash') AND NOT EXISTS(SELECT 1 FROM read_member_private.draft_versions WHERE draft_id=p->>'draft_id' AND version_hash=p->>'version_hash') THEN RETURN jsonb_build_object('error','draft_not_found'); END IF;
 INSERT INTO read_member_private.version_notes(draft_id,version_hash,note) VALUES(p->>'draft_id',p->>'version_hash',p->>'note') ON CONFLICT DO NOTHING;
 IF NOT EXISTS(SELECT 1 FROM read_member_private.version_notes WHERE draft_id=p->>'draft_id' AND version_hash=p->>'version_hash' AND note=p->>'note') THEN RETURN jsonb_build_object('error','note_conflict'); END IF;
 RETURN jsonb_build_object('ok',true);
END $fn$;
REVOKE ALL ON FUNCTION read_member_private.trusted_set_version_note(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION read_member_private.trusted_set_version_note(jsonb) TO service_role;
-- Install after trusted_operations.sql and member_operations.sql. Private immutable snapshots.
CREATE TABLE IF NOT EXISTS read_member_private.draft_versions (
 draft_id text NOT NULL, version_hash text NOT NULL, title text NOT NULL, body text NOT NULL,
 version_number bigint GENERATED ALWAYS AS IDENTITY, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 note text NOT NULL DEFAULT '', PRIMARY KEY(draft_id,version_hash));
CREATE TABLE IF NOT EXISTS read_member_private.version_assets (
 draft_id text NOT NULL, version_hash text NOT NULL, id text NOT NULL, mime text NOT NULL,payload text NOT NULL,
 PRIMARY KEY(draft_id,version_hash,id));
REVOKE ALL ON read_member_private.draft_versions,read_member_private.version_assets FROM PUBLIC,anon,authenticated;
ALTER TABLE read_member_private.draft_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE read_member_private.version_assets ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON read_member_private.draft_versions,read_member_private.version_assets TO service_role;
GRANT USAGE,SELECT ON SEQUENCE read_member_private.draft_versions_version_number_seq TO service_role;
CREATE OR REPLACE FUNCTION read_member_private.archive_before_draft_update() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN
 IF OLD.version_hash=NEW.version_hash THEN
  IF OLD.body IS DISTINCT FROM NEW.body OR OLD.title IS DISTINCT FROM NEW.title THEN
   RAISE EXCEPTION 'version_hash_collision'; END IF;
  RETURN NEW;
 END IF;
 IF EXISTS(SELECT 1 FROM read_member_private.draft_versions WHERE draft_id=NEW.id AND version_hash=NEW.version_hash) THEN
  RAISE EXCEPTION 'historical_version_read_only'; END IF;
 INSERT INTO read_member_private.draft_versions(draft_id,version_hash,title,body)
 VALUES(OLD.id,OLD.version_hash,OLD.title,OLD.body) ON CONFLICT DO NOTHING;
 INSERT INTO read_member_private.version_assets(draft_id,version_hash,id,mime,payload)
 SELECT draft_id,version_hash,id,mime,payload FROM read_member_private.assets
 WHERE draft_id=OLD.id AND version_hash=OLD.version_hash ON CONFLICT DO NOTHING;
 RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS archive_draft_version ON read_member_private.drafts;
CREATE TRIGGER archive_draft_version BEFORE UPDATE ON read_member_private.drafts
 FOR EACH ROW EXECUTE FUNCTION read_member_private.archive_before_draft_update();
CREATE OR REPLACE FUNCTION read_member_private.draft_versions(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE items jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM read_member_private.admins WHERE uid=p->>'uid') THEN RETURN jsonb_build_object('error','admin_required'); END IF;
 IF NOT EXISTS(SELECT 1 FROM read_member_private.drafts WHERE id=p->>'draft_id') THEN RETURN jsonb_build_object('error','draft_not_found'); END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('version_hash',v.version_hash,'content_hash',v.content_hash,'version_number',v.version_number,
 'label',CASE WHEN v.is_current THEN '当前版本' ELSE '历史版本' END,'created_at',v.created_at,
 'archived_at',v.archived_at,'summary',coalesce(n.note,v.note),'note',coalesce(n.note,v.note),'is_current',v.is_current,'feedback_count',
 (SELECT count(*) FROM read_member_private.feedback f WHERE f.draft_id=p->>'draft_id' AND f.version_hash=v.version_hash))
 ORDER BY v.is_current DESC,v.version_number DESC),'[]'::jsonb) INTO items FROM (
 SELECT d.version_hash,d.body::jsonb->>'version_hash' AS content_hash,(SELECT count(*)+1 FROM read_member_private.draft_versions WHERE draft_id=d.id) AS version_number,
 NULLIF(d.body::jsonb#>>'{article,updatedAt}','')::timestamptz AS created_at,NULL::timestamptz AS archived_at,'' AS note,true AS is_current FROM read_member_private.drafts d WHERE d.id=p->>'draft_id'
 UNION ALL SELECT version_hash,body::jsonb->>'version_hash',row_number() OVER(ORDER BY created_at,version_number),NULLIF(body::jsonb#>>'{article,updatedAt}','')::timestamptz,created_at,note,false FROM read_member_private.draft_versions WHERE draft_id=p->>'draft_id') v LEFT JOIN read_member_private.version_notes n ON n.draft_id=p->>'draft_id' AND n.version_hash=v.version_hash;
 RETURN jsonb_build_object('items',items);
END $fn$;
CREATE OR REPLACE FUNCTION read_member_private.draft_version_get(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE result jsonb; v record;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM read_member_private.admins WHERE uid=p->>'uid') THEN RETURN jsonb_build_object('error','admin_required'); END IF;
 IF EXISTS(SELECT 1 FROM read_member_private.drafts WHERE id=p->>'draft_id' AND version_hash=p->>'version_hash') THEN
  RETURN read_member_private.draft_get(p)||jsonb_build_object('is_current',true); END IF;
 SELECT * INTO v FROM read_member_private.draft_versions WHERE draft_id=p->>'draft_id' AND version_hash=p->>'version_hash';
 IF NOT FOUND THEN RETURN jsonb_build_object('error','draft_not_found'); END IF;
 RETURN jsonb_build_object('id',v.draft_id,'version_hash',v.version_hash,'title',v.title,'body',v.body,'is_current',false,
 'assets',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'mime',mime,'version_hash',version_hash)),'[]') FROM read_member_private.version_assets WHERE draft_id=v.draft_id AND version_hash=v.version_hash),
 'feedback',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY created_at,id),'[]') FROM read_member_private.feedback f WHERE draft_id=v.draft_id AND version_hash=v.version_hash),
 'reviews',(SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY created_at,id),'[]') FROM read_member_private.reviews f WHERE draft_id=v.draft_id AND version_hash=v.version_hash));
END $fn$;
-- Private function: no public REST route; only the BFF service role may execute.
CREATE OR REPLACE FUNCTION read_member_private.version_asset_chunk(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE a record; fingerprint text; start_at integer; padding integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM read_member_private.admins WHERE uid=p->>'uid') THEN
    RETURN jsonb_build_object('error','admin_required');
  END IF;
  SELECT s.mime,s.payload,s.version_hash INTO a FROM read_member_private.version_assets s
    WHERE s.draft_id=p->>'draft_id' AND s.id=p->>'asset_id' AND s.version_hash=p->>'version_hash' ;
  IF NOT FOUND THEN
   IF EXISTS(SELECT 1 FROM read_member_private.drafts WHERE id=p->>'draft_id' AND version_hash=p->>'version_hash') THEN RETURN read_member_private.draft_asset_chunk(p); END IF; RETURN jsonb_build_object('error','asset_not_found');
  END IF;
  fingerprint := encode(sha256(convert_to(a.payload,'UTF8')),'hex');
  IF p ? 'fingerprint' AND (p->>'fingerprint' IS DISTINCT FROM fingerprint OR
      p->>'version_hash' IS DISTINCT FROM a.version_hash) THEN
    RETURN jsonb_build_object('error','stale_asset');
  END IF;
  start_at := COALESCE((p->>'start')::integer,0);
  IF start_at < 0 OR start_at % 196608 <> 0 OR start_at > length(a.payload) THEN
    RETURN jsonb_build_object('error','invalid_asset_offset');
  END IF;
  padding := CASE WHEN right(a.payload,2)='==' THEN 2 WHEN right(a.payload,1)='=' THEN 1 ELSE 0 END;
  RETURN jsonb_build_object('mime',a.mime,'encoded_size',length(a.payload),
    'length',length(a.payload)/4*3-padding,'version_hash',a.version_hash,
    'fingerprint',fingerprint,'chunk',substr(a.payload,start_at+1,196608));
END $fn$;
CREATE OR REPLACE FUNCTION read_member_private.trusted_archive_draft(p jsonb)
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
 IF d.version_hash=p->>'version_hash' THEN RETURN jsonb_build_object('error','current_version_not_history'); END IF;
 IF EXISTS(SELECT 1 FROM read_member_private.draft_versions WHERE draft_id=p->>'draft_id' AND version_hash=p->>'version_hash') THEN
 RETURN jsonb_build_object('error','version_already_archived'); END IF;
 bytes:=convert_to(p->>'digest_payload','UTF8');
 FOR a IN SELECT value FROM jsonb_array_elements(p->'assets') LOOP
 SELECT string_agg(s.chunk,'' ORDER BY s.part) INTO encoded FROM read_member_private.staged_assets s WHERE s.batch_id=batch AND s.asset_id=a->>'id';
 bytes:=bytes||decode(encoded,'base64'); END LOOP;
 IF encode(sha256(bytes),'hex') IS DISTINCT FROM p->>'version_hash' THEN RETURN jsonb_build_object('error','version_digest_mismatch'); END IF;
 IF (p->>'digest_payload')::jsonb->'blocks' IS DISTINCT FROM (p->>'body')::jsonb->'blocks' THEN RETURN jsonb_build_object('error','version_body_mismatch'); END IF;
 INSERT INTO read_member_private.draft_versions(draft_id,version_hash,title,body,note)
 VALUES(p->>'draft_id',p->>'version_hash',p->>'title',p->>'body',coalesce(p->>'note','历史补录'));
 FOR a IN SELECT value FROM jsonb_array_elements(p->'assets') LOOP
 SELECT string_agg(s.chunk,'' ORDER BY s.part) INTO encoded FROM read_member_private.staged_assets s WHERE s.batch_id=batch AND s.asset_id=a->>'id';
 INSERT INTO read_member_private.version_assets(draft_id,id,version_hash,mime,payload)
 VALUES(p->>'draft_id',a->>'id',p->>'version_hash',a->>'mime',encoded); END LOOP;
 DELETE FROM read_member_private.staged_assets WHERE batch_id=batch;
 RETURN jsonb_build_object('ok',true,'version_hash',p->>'version_hash');
END $fn$;
REVOKE ALL ON FUNCTION read_member_private.draft_versions(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION read_member_private.draft_versions(jsonb) TO service_role;
REVOKE ALL ON FUNCTION read_member_private.draft_version_get(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION read_member_private.draft_version_get(jsonb) TO service_role;
REVOKE ALL ON FUNCTION read_member_private.version_asset_chunk(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION read_member_private.version_asset_chunk(jsonb) TO service_role;
REVOKE ALL ON FUNCTION read_member_private.trusted_archive_draft(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION read_member_private.trusted_archive_draft(jsonb) TO service_role;