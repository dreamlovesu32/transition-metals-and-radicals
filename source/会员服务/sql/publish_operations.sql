-- Publication is an explicit authenticated admin action, atomically snapshotting
-- only derived guide content and approved raster assets. Never copy feedback.
CREATE TABLE IF NOT EXISTS read_member_private.publications (
 id text NOT NULL, review_version_hash text NOT NULL, version_hash text NOT NULL,
 title text NOT NULL, body jsonb NOT NULL, published_at text NOT NULL,
 PRIMARY KEY(id,review_version_hash));
CREATE TABLE IF NOT EXISTS read_member_private.publication_heads (
 id text PRIMARY KEY, review_version_hash text NOT NULL);
CREATE TABLE IF NOT EXISTS read_member_private.publication_assets (
 draft_id text NOT NULL, version_hash text NOT NULL, id text NOT NULL,
 mime text NOT NULL, payload text NOT NULL,
 PRIMARY KEY(draft_id,version_hash,id));
ALTER TABLE read_member_private.publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE read_member_private.publication_heads ENABLE ROW LEVEL SECURITY;
ALTER TABLE read_member_private.publication_assets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON read_member_private.publications,read_member_private.publication_heads,
 read_member_private.publication_assets FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON read_member_private.publications,read_member_private.publication_heads,
 read_member_private.publication_assets TO service_role;
CREATE OR REPLACE FUNCTION read_member_private.draft_publish(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE d record; b jsonb; clean jsonb; stamp text; vh text:=p->>'version_hash'; did text:=p->>'draft_id';
BEGIN
 IF NOT EXISTS(SELECT 1 FROM read_member_private.admins WHERE uid=p->>'uid') THEN
  RETURN jsonb_build_object('error','admin_required'); END IF;
 SELECT * INTO d FROM read_member_private.drafts WHERE id=did FOR UPDATE;
 IF NOT FOUND THEN RETURN jsonb_build_object('error','draft_not_found'); END IF;
 IF d.version_hash IS DISTINCT FROM vh THEN RETURN jsonb_build_object('error','stale_review'); END IF;
 IF EXISTS(SELECT 1 FROM read_member_private.publication_heads WHERE id=did AND review_version_hash=vh) THEN
  RETURN jsonb_build_object('id',did,'version_hash',vh,'published',true,'already_published',true,'url','/read.html?article='||did); END IF;
 b:=d.body::jsonb;
 IF b->'article'->>'id' IS DISTINCT FROM did OR jsonb_typeof(b->'blocks') IS DISTINCT FROM 'array'
  OR jsonb_typeof(b->'asset_map') IS DISTINCT FROM 'object' OR (b->>'version_hash' ~ '^[a-f0-9]{64}$') IS NOT TRUE OR b#>>'{blocks,0,kind}' IS DISTINCT FROM 'title' THEN
  RETURN jsonb_build_object('error','invalid_publication'); END IF;
 -- Only the known public metadata, public blocks, raster mapping and content hash.
 SELECT jsonb_object_agg(key,value) INTO clean FROM jsonb_each(b->'article') WHERE key IN
 ('id','readingId','displayNumber','title','sourceUrl','journal','published','kind','doi','figurePages','scrollThreshold','firstPublishedOn','updatedAt');
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(b->'blocks') x WHERE
  x->>'kind' IS NULL OR x->>'kind' NOT IN ('title','heading','paragraph','figure','bullet','number','quote','table')
  OR jsonb_typeof(x->'text') IS DISTINCT FROM 'string'
  OR (x->>'kind'='figure' AND NOT (b->'asset_map' ? (x->>'src')))) THEN
  RETURN jsonb_build_object('error','invalid_publication'); END IF;
 clean:=jsonb_build_object('article',clean||jsonb_build_object('reviewStatus','approved'),'blocks',(SELECT jsonb_agg(
  jsonb_build_object('id',x->'id','kind',x->'kind','text',x->'text') ||
  CASE WHEN x->>'kind'='heading' THEN jsonb_build_object('level',coalesce(x->'level','2'::jsonb))
       WHEN x->>'kind'='figure' THEN jsonb_build_object('src',x->'src') ELSE '{}'::jsonb END)
  FROM jsonb_array_elements(b->'blocks') x),'asset_map',b->'asset_map');
 IF EXISTS(SELECT 1 FROM jsonb_each_text(b->'asset_map') m WHERE NOT EXISTS(
  SELECT 1 FROM read_member_private.assets a WHERE a.draft_id=did AND a.version_hash=vh
  AND a.id=m.value AND a.mime IN ('image/png','image/jpeg','image/webp'))) THEN
  RETURN jsonb_build_object('error','invalid_publication'); END IF;
 stamp:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"');
 INSERT INTO read_member_private.publications VALUES(did,vh,b->>'version_hash',d.title,clean,stamp)
 ON CONFLICT(id,review_version_hash) DO NOTHING;
 INSERT INTO read_member_private.publication_assets
 SELECT did,vh,a.id,a.mime,a.payload FROM read_member_private.assets a
 WHERE a.draft_id=did AND a.version_hash=vh AND a.id IN(SELECT value FROM jsonb_each_text(b->'asset_map'))
 ON CONFLICT DO NOTHING;
 INSERT INTO read_member_private.publication_heads VALUES(did,vh)
 ON CONFLICT(id) DO UPDATE SET review_version_hash=excluded.review_version_hash;
 INSERT INTO read_member_private.articles(id,version_hash,published) VALUES(did,b->>'version_hash',1)
 ON CONFLICT(id) DO UPDATE SET version_hash=excluded.version_hash,published=1;
 INSERT INTO read_member_private.reviews(id,uid,draft_id,version_hash,decision,comment,created_at)
 VALUES(replace(gen_random_uuid()::text,'-',''),p->>'uid',did,vh,'approved','管理员一键审核通过并发布',stamp);
 RETURN jsonb_build_object('id',did,'version_hash',vh,'published',true,'already_published',false,'url','/read.html?article='||did);
END $fn$;
CREATE OR REPLACE FUNCTION read_member_private.public_articles(p jsonb)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT jsonb_build_object('items',coalesce(jsonb_agg(jsonb_build_object('id',s.id,'title',s.title,
 'version_hash',s.version_hash,'review_version_hash',s.review_version_hash,'published_at',s.published_at,
 'article',s.body->'article','asset_map',s.body->'asset_map') ORDER BY s.published_at DESC),'[]'::jsonb))
 FROM read_member_private.publications s JOIN read_member_private.publication_heads h
 ON s.id=h.id AND s.review_version_hash=h.review_version_hash;
$fn$;
CREATE OR REPLACE FUNCTION read_member_private.public_article(p jsonb)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
 SELECT coalesce((SELECT s.body||jsonb_build_object('id',s.id,'title',s.title,'version_hash',s.version_hash,
 'review_version_hash',s.review_version_hash,'published_at',s.published_at)
 FROM read_member_private.publications s JOIN read_member_private.publication_heads h
 ON s.id=h.id AND s.review_version_hash=h.review_version_hash WHERE s.id=p->>'article_id'),jsonb_build_object('error','article_not_found'));
$fn$;
CREATE OR REPLACE FUNCTION read_member_private.public_asset_chunk(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $fn$
DECLARE a record; n integer:=coalesce((p->>'start')::integer,0); padding integer;
BEGIN
 SELECT * INTO a FROM read_member_private.publication_assets
 WHERE draft_id=p->>'draft_id' AND version_hash=p->>'version_hash' AND id=p->>'asset_id';
 IF NOT FOUND THEN RETURN jsonb_build_object('error','asset_not_found'); END IF;
 IF n<0 OR n%196608<>0 OR n>length(a.payload) THEN RETURN jsonb_build_object('error','invalid_asset_offset'); END IF;
 padding:=CASE WHEN right(a.payload,2)='==' THEN 2 WHEN right(a.payload,1)='=' THEN 1 ELSE 0 END;
 RETURN jsonb_build_object('mime',a.mime,'encoded_size',length(a.payload),'length',length(a.payload)/4*3-padding,
 'version_hash',a.version_hash,'fingerprint',a.version_hash,'chunk',substr(a.payload,n+1,196608));
END $fn$;
REVOKE ALL ON FUNCTION read_member_private.draft_publish(jsonb),read_member_private.public_articles(jsonb),
 read_member_private.public_article(jsonb),read_member_private.public_asset_chunk(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION read_member_private.draft_publish(jsonb),read_member_private.public_articles(jsonb),
 read_member_private.public_article(jsonb),read_member_private.public_asset_chunk(jsonb) TO service_role;
