-- Private function: no public REST route; only the BFF service role may execute.
CREATE OR REPLACE FUNCTION read_member_private.draft_asset_chunk(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, pg_temp AS $fn$
DECLARE a record; fingerprint text; start_at integer; padding integer;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM read_member_private.admins WHERE uid=p->>'uid') THEN
    RETURN jsonb_build_object('error','admin_required');
  END IF;
  SELECT s.mime,s.payload,s.version_hash INTO a FROM read_member_private.assets s
    JOIN read_member_private.drafts d ON s.draft_id=d.id AND s.version_hash=d.version_hash
    WHERE s.draft_id=p->>'draft_id' AND s.id=p->>'asset_id' FOR SHARE OF s,d;
  IF NOT FOUND THEN RETURN jsonb_build_object('error','asset_not_found'); END IF;
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
REVOKE ALL ON FUNCTION read_member_private.draft_asset_chunk(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION read_member_private.draft_asset_chunk(jsonb) TO service_role;
GRANT SELECT, UPDATE(id) ON read_member_private.assets TO service_role;
