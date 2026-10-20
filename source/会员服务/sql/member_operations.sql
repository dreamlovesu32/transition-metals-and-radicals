-- Install only as the private-schema owner after reviewing grants. Every call
-- runs as the caller and is one PostgreSQL statement/transaction. No BFF UID
-- is accepted from browser input; the trusted BFF supplies p.uid.
CREATE OR REPLACE FUNCTION read_member_private.member_dispatch(op text, p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE
  u text := p->>'uid'; aid text := p->>'article_id'; did text := p->>'draft_id';
  vh text := p->>'version_hash'; cid text := p->>'client_id';
  rec record; prior record; result jsonb; items jsonb; nid text;
  stamp text; expected bigint; affected integer;
BEGIN
  IF u IS NULL OR u = '' THEN RETURN jsonb_build_object('error','admin_required'); END IF;
  IF op IN ('drafts_list','draft_get','review_add','feedback_add','feedback_list') THEN
    PERFORM 1 FROM read_member_private.admins WHERE uid=u;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','admin_required'); END IF;
  END IF;
  IF op IN ('favorite_set','notes_list','note_add','progress_get','progress_set')
     AND aid IS NOT NULL THEN
    -- The row lock serializes version checks with trusted article imports.
    SELECT a.id,a.version_hash INTO rec FROM read_member_private.articles a
      WHERE a.id=aid AND a.published=1 FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','article_not_found'); END IF;
  END IF;
  IF op='member_me' THEN
    RETURN jsonb_build_object('uid',u,'admin',EXISTS(
      SELECT 1 FROM read_member_private.admins WHERE uid=u));
  ELSIF op='favorites_list' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('article_id',f.article_id,
      'created_at',f.created_at) ORDER BY f.created_at), '[]'::jsonb) INTO items
      FROM read_member_private.favorites f JOIN read_member_private.articles a
      ON a.id=f.article_id AND a.published=1 WHERE f.uid=u;
    RETURN jsonb_build_object('items',items);
  ELSIF op='favorite_set' THEN
    IF rec.id IS NULL THEN RETURN jsonb_build_object('error','article_not_found'); END IF;
    IF p->>'enabled'='true' THEN
      stamp := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"');
      INSERT INTO read_member_private.favorites(uid,article_id,created_at)
        VALUES(u,aid,stamp) ON CONFLICT(uid,article_id) DO NOTHING;
    ELSE
      DELETE FROM read_member_private.favorites WHERE uid=u AND article_id=aid;
    END IF;
    RETURN jsonb_build_object('article_id',aid,'favorited',p->>'enabled'='true');
  ELSIF op='notes_list' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',n.id,'article_id',n.article_id,
      'version_hash',n.version_hash,'anchor',n.anchor,'quote',n.quote,'text',n.text,
      'client_id',(SELECT q.client_id FROM read_member_private.note_requests q
        WHERE q.note_id=n.id AND q.uid=n.uid))), '[]'::jsonb) INTO items
      FROM read_member_private.notes n JOIN read_member_private.articles a
      ON a.id=n.article_id AND a.published=1 WHERE n.uid=u
      AND (aid IS NULL OR n.article_id=aid);
    RETURN jsonb_build_object('items',items);
  ELSIF op='note_add' THEN
    IF rec.id IS NULL THEN RETURN jsonb_build_object('error','article_not_found'); END IF;
    IF cid IS NOT NULL THEN
      SELECT q.note_id,q.request_hash INTO prior FROM read_member_private.note_requests q
        WHERE q.uid=u AND q.client_id=cid;
      IF FOUND THEN
        IF prior.request_hash <> p->>'request_hash' THEN
          RETURN jsonb_build_object('error','idempotency_conflict');
        END IF;
        SELECT to_jsonb(n) - 'uid' INTO result FROM read_member_private.notes n
          WHERE n.id=prior.note_id AND n.uid=u;
        IF result IS NULL THEN RETURN jsonb_build_object('error','note_deleted'); END IF;
        RETURN result || jsonb_build_object('client_id',cid);
      END IF;
    END IF;
    IF rec.version_hash <> vh THEN RETURN jsonb_build_object('error','version_mismatch'); END IF;
    nid := replace(gen_random_uuid()::text,'-','');
    INSERT INTO read_member_private.notes(id,uid,article_id,version_hash,anchor,quote,text)
      VALUES(nid,u,aid,vh,p->>'anchor',p->>'quote',p->>'text');
    IF cid IS NOT NULL THEN
      INSERT INTO read_member_private.note_requests(uid,client_id,note_id,request_hash)
        VALUES(u,cid,nid,p->>'request_hash') ON CONFLICT(uid,client_id) DO NOTHING;
      GET DIAGNOSTICS affected = ROW_COUNT;
      IF affected=0 THEN
        DELETE FROM read_member_private.notes WHERE id=nid;
        SELECT q.note_id,q.request_hash INTO prior FROM read_member_private.note_requests q
          WHERE q.uid=u AND q.client_id=cid;
        IF prior.request_hash <> p->>'request_hash' THEN
          RETURN jsonb_build_object('error','idempotency_conflict');
        END IF;
        SELECT to_jsonb(n) - 'uid' INTO result FROM read_member_private.notes n
          WHERE n.id=prior.note_id AND n.uid=u;
        IF result IS NULL THEN RETURN jsonb_build_object('error','note_deleted'); END IF;
        RETURN result || jsonb_build_object('client_id',cid);
      END IF;
    END IF;
    RETURN jsonb_build_object('id',nid,'client_id',cid,'article_id',aid,
      'version_hash',vh,'anchor',p->>'anchor','quote',p->>'quote','text',p->>'text');
  ELSIF op='note_delete' THEN
    DELETE FROM read_member_private.notes WHERE id=p->>'note_id' AND uid=u;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected=0 THEN RETURN jsonb_build_object('error','note_not_found'); END IF;
    RETURN jsonb_build_object('deleted',true);
  ELSIF op='progress_get' THEN
    IF rec.id IS NULL THEN RETURN jsonb_build_object('error','article_not_found'); END IF;
    SELECT jsonb_build_object('version_hash',r.version_hash,'position',r.position::jsonb,
      'revision',r.revision,'updated_at',r.updated_at) INTO result
      FROM read_member_private.progress r WHERE r.uid=u AND r.article_id=aid;
    RETURN coalesce(result,jsonb_build_object('revision',0,'position',NULL,
      'version_hash',NULL,'updated_at',NULL));
  ELSIF op='progress_set' THEN
    IF rec.id IS NULL THEN RETURN jsonb_build_object('error','article_not_found'); END IF;
    IF rec.version_hash <> vh THEN RETURN jsonb_build_object('error','version_mismatch'); END IF;
    expected := (p->>'revision')::bigint;
    stamp := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"');
    -- The conditional UPSERT is a compare-and-swap even under concurrent calls.
    INSERT INTO read_member_private.progress AS existing(uid,article_id,version_hash,position,revision,updated_at)
      SELECT u,aid,vh,p->>'encoded_position',1,stamp WHERE expected=0
      ON CONFLICT(uid,article_id) DO UPDATE SET version_hash=EXCLUDED.version_hash,
        position=EXCLUDED.position,revision=existing.revision+1,
        updated_at=EXCLUDED.updated_at
      WHERE existing.revision=expected;
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected=0 THEN
      IF expected>0 THEN
        UPDATE read_member_private.progress r SET version_hash=vh,
          position=p->>'encoded_position',revision=r.revision+1,updated_at=stamp
          WHERE r.uid=u AND r.article_id=aid AND r.revision=expected;
        GET DIAGNOSTICS affected = ROW_COUNT;
      END IF;
      IF affected=0 THEN RETURN jsonb_build_object('error','progress_conflict'); END IF;
    END IF;
    RETURN jsonb_build_object('version_hash',vh,'position',p->'position',
      'revision',expected+1,'updated_at',stamp);
  ELSIF op='drafts_list' THEN
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',d.id,'title',d.title,
      'version_hash',d.version_hash,'published',coalesce(a.published=1,false),
      'review_status',coalesce(r.decision, CASE
        WHEN d.body::jsonb#>>'{review_baseline,version_hash}'=d.version_hash
        THEN CASE d.body::jsonb#>>'{review_baseline,status}'
          WHEN 'proofreading' THEN 'proofreading'
          WHEN 'approved' THEN 'approved'
          WHEN 'existing-public-baseline' THEN 'approved'
          ELSE 'pending' END
        ELSE 'pending' END)) ORDER BY d.id), '[]'::jsonb) INTO items
      FROM read_member_private.drafts d
      LEFT JOIN read_member_private.articles a ON a.id=d.id
      LEFT JOIN LATERAL (SELECT decision FROM read_member_private.reviews
        WHERE draft_id=d.id AND version_hash=d.version_hash
        ORDER BY created_at DESC,id DESC LIMIT 1) r ON true;
    RETURN jsonb_build_object('items',items);
  ELSIF op='draft_get' THEN
    SELECT d.id,d.version_hash,d.title,d.body INTO rec FROM read_member_private.drafts d
      WHERE d.id=did FOR SHARE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','draft_not_found'); END IF;
    RETURN jsonb_build_object('id',rec.id,'version_hash',rec.version_hash,
      'title',rec.title,'body',rec.body,'assets',(
        SELECT coalesce(jsonb_agg(jsonb_build_object('id',a.id,'mime',a.mime,
          'version_hash',a.version_hash)),'[]'::jsonb)
        FROM read_member_private.assets a WHERE a.draft_id=did), 'feedback',(
        SELECT coalesce(jsonb_agg(jsonb_build_object('uid',f.uid,'version_hash',f.version_hash,
          'target_type',f.target_type,'target_id',f.target_id,'quote',f.quote,
          'comment',f.comment,'created_at',f.created_at)),'[]'::jsonb)
        FROM read_member_private.feedback f WHERE f.draft_id=did AND f.version_hash=rec.version_hash), 'reviews',(
        SELECT coalesce(jsonb_agg(jsonb_build_object('uid',r.uid,'version_hash',r.version_hash,
          'decision',r.decision,'comment',r.comment,'created_at',r.created_at)),'[]'::jsonb)
        FROM read_member_private.reviews r WHERE r.draft_id=did AND r.version_hash=rec.version_hash));
  ELSIF op IN ('review_add','feedback_add') THEN
    -- A trusted import updates this row, so locking it prevents approval races.
    SELECT d.version_hash INTO rec FROM read_member_private.drafts d
      WHERE d.id=did FOR UPDATE;
    IF NOT FOUND THEN RETURN jsonb_build_object('error','draft_not_found'); END IF;
    IF rec.version_hash <> vh THEN
      RETURN jsonb_build_object('error',CASE WHEN op='review_add'
        THEN 'stale_review' ELSE 'stale_feedback' END);
    END IF;
    nid := replace(gen_random_uuid()::text,'-','');
    stamp := to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"');
    IF op='review_add' THEN
      INSERT INTO read_member_private.reviews(id,uid,draft_id,version_hash,decision,comment,created_at)
        VALUES(nid,u,did,vh,p->>'decision',p->>'comment',stamp);
      RETURN jsonb_build_object('id',nid,'version_hash',vh,
        'decision',p->>'decision','published',false);
    ELSE
      INSERT INTO read_member_private.feedback(id,uid,draft_id,version_hash,
        target_type,target_id,quote,comment,created_at)
        VALUES(nid,u,did,vh,p->>'target_type',p->>'target_id',p->>'quote',p->>'comment',stamp);
      RETURN jsonb_build_object('id',nid,'version_hash',vh,
        'target',p->'target','comment',p->>'comment');
    END IF;
  ELSIF op='feedback_list' THEN
    SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at,e.id),'[]'::jsonb)
      INTO items FROM (SELECT * FROM (
        SELECT r.id,r.uid,r.draft_id,r.version_hash,r.decision AS event_type,
          r.comment,r.created_at,''::text AS target_type,''::text AS target_id,
          ''::text AS quote FROM read_member_private.reviews r
        UNION ALL
        SELECT f.id,f.uid,f.draft_id,f.version_hash,'feedback'::text AS event_type,
          f.comment,f.created_at,f.target_type,f.target_id,f.quote
          FROM read_member_private.feedback f) e0
        WHERE e0.created_at > coalesce(p->>'after','')
          OR (e0.created_at=coalesce(p->>'after','') AND e0.id>coalesce(p->>'after_id',''))
        ORDER BY e0.created_at,e0.id LIMIT 200) e;
    SELECT value INTO result FROM jsonb_array_elements(items) WITH ORDINALITY t(value,n)
      ORDER BY n DESC LIMIT 1;
    RETURN jsonb_build_object('events',items,'cursor',CASE WHEN result IS NULL
      THEN jsonb_build_object('after',coalesce(p->>'after',''),
        'after_id',coalesce(p->>'after_id',''))
      ELSE jsonb_build_object('after',result->>'created_at','after_id',result->>'id') END);
  END IF;
  RAISE EXCEPTION 'unknown member operation';
END $$;

-- Only fixed, transport-allowlisted entry points are exposed. Deployment must
-- grant EXECUTE solely to the BFF service role; no direct client grants.
CREATE OR REPLACE FUNCTION read_member_private.member_me(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('member_me',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.favorites_list(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('favorites_list',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.favorite_set(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('favorite_set',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.notes_list(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('notes_list',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.note_add(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('note_add',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.note_delete(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('note_delete',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.progress_get(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('progress_get',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.progress_set(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('progress_set',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.drafts_list(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('drafts_list',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.draft_get(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('draft_get',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.review_add(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('review_add',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.feedback_add(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('feedback_add',p) $$;
CREATE OR REPLACE FUNCTION read_member_private.feedback_list(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog
AS $$ SELECT read_member_private.member_dispatch('feedback_list',p) $$;

REVOKE ALL ON FUNCTION read_member_private.member_dispatch(text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.member_me(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.favorites_list(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.favorite_set(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.notes_list(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.note_add(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.note_delete(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.progress_get(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.progress_set(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.drafts_list(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.draft_get(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.review_add(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.feedback_add(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION read_member_private.feedback_list(jsonb) FROM PUBLIC;

GRANT USAGE ON SCHEMA read_member_private TO service_role;
GRANT SELECT ON read_member_private.admins, read_member_private.articles,
  read_member_private.drafts, read_member_private.assets TO service_role;
-- PostgreSQL row-lock clauses require UPDATE privilege. Limit it to the ID
-- column; function code never changes these IDs. Keep this role BFF-only.
GRANT UPDATE(id) ON read_member_private.articles,
  read_member_private.drafts TO service_role;
GRANT SELECT,INSERT,DELETE ON read_member_private.favorites,
  read_member_private.notes, read_member_private.note_requests TO service_role;
GRANT SELECT,INSERT,UPDATE ON read_member_private.progress TO service_role;
GRANT SELECT,INSERT ON read_member_private.feedback,
  read_member_private.reviews TO service_role;
GRANT EXECUTE ON FUNCTION read_member_private.member_dispatch(text,jsonb),
  read_member_private.member_me(jsonb), read_member_private.favorites_list(jsonb),
  read_member_private.favorite_set(jsonb), read_member_private.notes_list(jsonb),
  read_member_private.note_add(jsonb), read_member_private.note_delete(jsonb),
  read_member_private.progress_get(jsonb), read_member_private.progress_set(jsonb),
  read_member_private.drafts_list(jsonb), read_member_private.draft_get(jsonb),
  read_member_private.review_add(jsonb), read_member_private.feedback_add(jsonb),
  read_member_private.feedback_list(jsonb) TO service_role;
