-- Append-only reviewer edits. Original feedback rows remain immutable.
CREATE TABLE IF NOT EXISTS read_member_private.feedback_edits (
 id text PRIMARY KEY,feedback_id text NOT NULL,uid text NOT NULL,
 revision integer NOT NULL,comment text NOT NULL,created_at text NOT NULL,
 UNIQUE(feedback_id,revision));
REVOKE ALL ON read_member_private.feedback_edits FROM PUBLIC,anon,authenticated;
ALTER TABLE read_member_private.feedback_edits ENABLE ROW LEVEL SECURITY;
GRANT SELECT,INSERT ON read_member_private.feedback_edits TO service_role;
GRANT UPDATE(id) ON read_member_private.feedback TO service_role;
CREATE OR REPLACE FUNCTION read_member_private.feedback_edit(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE f record;d record;n integer;stamp text;eid text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM read_member_private.admins WHERE uid=p->>'uid') THEN RETURN jsonb_build_object('error','admin_required');END IF;
 SELECT version_hash INTO d FROM read_member_private.drafts WHERE id=p->>'draft_id' FOR SHARE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','draft_not_found');END IF;
 IF d.version_hash IS DISTINCT FROM p->>'version_hash' THEN RETURN jsonb_build_object('error','stale_feedback');END IF;
 SELECT * INTO f FROM read_member_private.feedback WHERE id=p->>'feedback_id' AND draft_id=p->>'draft_id' FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','feedback_not_found');END IF;
 IF f.uid IS DISTINCT FROM p->>'uid' THEN RETURN jsonb_build_object('error','feedback_owner_required');END IF;
 IF f.version_hash IS DISTINCT FROM d.version_hash THEN RETURN jsonb_build_object('error','stale_feedback');END IF;
 SELECT coalesce(max(revision),0) INTO n FROM read_member_private.feedback_edits WHERE feedback_id=f.id;
 IF n IS DISTINCT FROM (p->>'edit_revision')::integer THEN RETURN jsonb_build_object('error','feedback_conflict');END IF;
 IF nullif(btrim(p->>'comment'),'') IS NULL OR length(p->>'comment')>10000 THEN RETURN jsonb_build_object('error','invalid_input');END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"');eid:=replace(gen_random_uuid()::text,'-','');
 INSERT INTO read_member_private.feedback_edits VALUES(eid,f.id,p->>'uid',n+1,p->>'comment',stamp);
 RETURN to_jsonb(f)||jsonb_build_object('comment',p->>'comment','edit_revision',n+1,'edited_at',stamp);
END $fn$;
CREATE OR REPLACE FUNCTION read_member_private.feedback_records(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM read_member_private.admins WHERE uid=p->>'uid') THEN RETURN jsonb_build_object('error','admin_required');END IF;
 RETURN jsonb_build_object('items',(SELECT coalesce(jsonb_agg(to_jsonb(f)||jsonb_build_object(
 'comment',coalesce(e.comment,f.comment),'edit_revision',coalesce(e.revision,0),'edited_at',e.created_at)
 ORDER BY f.created_at,f.id),'[]') FROM read_member_private.feedback f LEFT JOIN LATERAL
 (SELECT * FROM read_member_private.feedback_edits WHERE feedback_id=f.id ORDER BY revision DESC LIMIT 1)e ON true
 WHERE f.draft_id=p->>'draft_id' AND (NOT(p?'version_hash') OR f.version_hash=p->>'version_hash')));
END $fn$;
CREATE OR REPLACE FUNCTION read_member_private.feedback_list(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE items jsonb;lastrow jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM read_member_private.admins WHERE uid=p->>'uid') THEN RETURN jsonb_build_object('error','admin_required');END IF;
 SELECT coalesce(jsonb_agg(CASE WHEN e.feedback_id IS NULL THEN to_jsonb(e)-'feedback_id'-'edit_revision' ELSE to_jsonb(e) END ORDER BY e.created_at,e.id),'[]') INTO items FROM (
 SELECT * FROM (
 SELECT r.id,r.uid,r.draft_id,r.version_hash,r.decision AS event_type,r.comment,r.created_at,''::text AS target_type,''::text AS target_id,''::text AS quote,NULL::text AS feedback_id,0 AS edit_revision FROM read_member_private.reviews r
 UNION ALL SELECT f.id,f.uid,f.draft_id,f.version_hash,'feedback',f.comment,f.created_at,f.target_type,f.target_id,f.quote,NULL::text,0 FROM read_member_private.feedback f
 UNION ALL SELECT e.id,e.uid,f.draft_id,f.version_hash,'feedback_edit',e.comment,e.created_at,f.target_type,f.target_id,f.quote,f.id,e.revision FROM read_member_private.feedback_edits e JOIN read_member_private.feedback f ON f.id=e.feedback_id
 ) all_events WHERE created_at>coalesce(p->>'after','') OR(created_at=coalesce(p->>'after','') AND id>coalesce(p->>'after_id','')) ORDER BY created_at,id LIMIT 200)e;
 lastrow:=items->(jsonb_array_length(items)-1);
 RETURN jsonb_build_object('events',items,'cursor',CASE WHEN lastrow IS NULL THEN jsonb_build_object('after',coalesce(p->>'after',''),'after_id',coalesce(p->>'after_id','')) ELSE jsonb_build_object('after',lastrow->>'created_at','after_id',lastrow->>'id') END);
END $fn$;
REVOKE ALL ON FUNCTION read_member_private.feedback_edit(jsonb),read_member_private.feedback_records(jsonb),read_member_private.feedback_list(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION read_member_private.feedback_edit(jsonb),read_member_private.feedback_records(jsonb),read_member_private.feedback_list(jsonb) TO service_role;
