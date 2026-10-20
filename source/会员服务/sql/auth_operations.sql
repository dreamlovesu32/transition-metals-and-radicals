-- Install with the private schema already created and owned by the BFF database role.
-- Every function is one ExecutePGSql call/transaction. Never grant schema usage to clients.
CREATE SCHEMA IF NOT EXISTS read_member_private;
ALTER TABLE read_member_private.sessions ADD COLUMN IF NOT EXISTS refresh_owner text;
ALTER TABLE read_member_private.sessions ADD COLUMN IF NOT EXISTS refresh_state text NOT NULL DEFAULT 'ready';
ALTER TABLE read_member_private.sessions ADD COLUMN IF NOT EXISTS refresh_started_at bigint;

CREATE OR REPLACE FUNCTION read_member_private.session_get(p jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path = pg_catalog AS $$
 SELECT coalesce((SELECT to_jsonb(s) FROM read_member_private.sessions s
  WHERE s.id_hash=p->>'id_hash' AND s.revoked=0 AND s.expires_at>extract(epoch from clock_timestamp())::bigint), '{}'::jsonb)
$$;

CREATE OR REPLACE FUNCTION read_member_private.session_create(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 INSERT INTO read_member_private.sessions(id_hash,token_cipher,uid,email,csrf,expires_at,revoked)
 VALUES (p->>'id_hash',p->>'token_cipher',p->>'uid',p->>'email',p->>'csrf',(p->>'expires_at')::bigint,0);
 RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.session_revoke(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 UPDATE read_member_private.sessions SET revoked=1,refresh_state='revoked',refresh_owner=NULL
 WHERE id_hash=p->>'id_hash';
 RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.sessions_revoke_email(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 UPDATE read_member_private.sessions SET revoked=1,refresh_state='revoked',refresh_owner=NULL
 WHERE email=p->>'email';
 RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.refresh_claim(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE s read_member_private.sessions%ROWTYPE; now_s bigint := extract(epoch from clock_timestamp())::bigint;
BEGIN
 SELECT * INTO s FROM read_member_private.sessions WHERE id_hash=p->>'id_hash' FOR UPDATE;
 IF NOT FOUND OR s.revoked<>0 OR s.expires_at<=now_s THEN RETURN jsonb_build_object('status','expired'); END IF;
 IF s.refresh_state='pending' THEN
   IF s.refresh_started_at<=now_s-45 THEN
     UPDATE read_member_private.sessions SET revoked=1,refresh_state='revoked',refresh_owner=NULL WHERE id_hash=s.id_hash;
     RETURN jsonb_build_object('status','expired');
   END IF;
   RETURN jsonb_build_object('status','busy');
 END IF;
 IF s.refresh_state<>'ready' THEN RETURN jsonb_build_object('status','expired'); END IF;
 -- A concurrent caller may have committed a newer ciphertext since its initial read.
 IF s.token_cipher<>p->>'token_cipher' THEN RETURN jsonb_build_object('status','updated','row',to_jsonb(s)); END IF;
 UPDATE read_member_private.sessions SET refresh_state='pending',refresh_owner=p->>'owner',refresh_started_at=now_s
 WHERE id_hash=s.id_hash;
 RETURN jsonb_build_object('status','claimed','row',to_jsonb(s));
END $$;

CREATE OR REPLACE FUNCTION read_member_private.refresh_commit(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE n integer;
BEGIN
 UPDATE read_member_private.sessions SET token_cipher=p->>'token_cipher',refresh_state='ready',refresh_owner=NULL,refresh_started_at=NULL
 WHERE id_hash=p->>'id_hash' AND refresh_owner=p->>'owner' AND refresh_state='pending' AND revoked=0
 AND refresh_started_at>extract(epoch from clock_timestamp())::bigint-45
 AND expires_at>extract(epoch from clock_timestamp())::bigint;
 GET DIAGNOSTICS n = ROW_COUNT;
 RETURN jsonb_build_object('ok',n=1);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.refresh_abort(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 UPDATE read_member_private.sessions SET revoked=1,refresh_state='revoked',refresh_owner=NULL
 WHERE id_hash=p->>'id_hash' AND refresh_owner=p->>'owner' AND refresh_state='pending';
 RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.rate_limit(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE n integer; now_s bigint := extract(epoch from clock_timestamp())::bigint;
BEGIN
 INSERT INTO read_member_private.rate_limits AS r(bucket,window_start,attempts) VALUES (p->>'bucket',now_s,1)
 ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN r.window_start<=now_s-(p->>'seconds')::integer THEN 1 ELSE r.attempts+1 END,
 window_start=CASE WHEN r.window_start<=now_s-(p->>'seconds')::integer THEN now_s ELSE r.window_start END
 RETURNING attempts INTO n;
 RETURN jsonb_build_object('attempts',n);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.captcha_create(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 INSERT INTO read_member_private.captcha_images(state_hash,session_hash,token_cipher,expires_at,verified_cipher,consumed)
 VALUES(p->>'state_hash',p->>'session_hash',p->>'token_cipher',(p->>'expires_at')::bigint,'',0);
 RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.captcha_get(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE c read_member_private.captcha_images%ROWTYPE;
BEGIN
 -- Claim before upstream verification. Unknown upstream outcome leaves it unusable.
 UPDATE read_member_private.captcha_images SET consumed=2
 WHERE state_hash=p->>'state_hash' AND session_hash=p->>'session_hash' AND consumed=0
 AND verified_cipher='' AND expires_at>extract(epoch from clock_timestamp())::bigint RETURNING * INTO c;
 IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
 RETURN to_jsonb(c);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.captcha_verify(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE n integer;
BEGIN
 UPDATE read_member_private.captcha_images SET verified_cipher=p->>'verified_cipher',expires_at=least(expires_at,(p->>'expires_at')::bigint),consumed=0
 WHERE state_hash=p->>'state_hash' AND session_hash=p->>'session_hash' AND consumed=2
 AND expires_at>extract(epoch from clock_timestamp())::bigint;
 GET DIAGNOSTICS n = ROW_COUNT;
 RETURN jsonb_build_object('ok',n=1);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.captcha_consume(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE c read_member_private.captcha_images%ROWTYPE;
BEGIN
 UPDATE read_member_private.captcha_images SET consumed=1
 WHERE state_hash=p->>'state_hash' AND session_hash=p->>'session_hash' AND consumed=0
 AND verified_cipher<>'' AND expires_at>extract(epoch from clock_timestamp())::bigint RETURNING * INTO c;
 IF NOT FOUND THEN RETURN '{}'::jsonb; END IF;
 RETURN to_jsonb(c);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.verification_create(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
BEGIN
 INSERT INTO read_member_private.issued_verifications(id_hash,session_hash,email,usage,expires_at)
 VALUES(p->>'id_hash',p->>'session_hash',p->>'email',p->>'usage',(p->>'expires_at')::bigint);
 RETURN jsonb_build_object('ok',true);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.verification_get(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE v read_member_private.issued_verifications%ROWTYPE;
BEGIN
 SELECT * INTO v FROM read_member_private.issued_verifications
 WHERE id_hash=p->>'id_hash' AND session_hash=p->>'session_hash';
 IF NOT FOUND OR v.expires_at<=extract(epoch from clock_timestamp())::bigint THEN RETURN '{}'::jsonb; END IF;
 IF EXISTS(SELECT 1 FROM read_member_private.used_verifications u WHERE u.id_hash=v.id_hash)
 THEN RETURN jsonb_build_object('already_used',true); END IF;
 RETURN to_jsonb(v);
END $$;

CREATE OR REPLACE FUNCTION read_member_private.verification_consume(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog AS $$
DECLARE n integer;
BEGIN
 INSERT INTO read_member_private.used_verifications(id_hash,used_at)
 SELECT v.id_hash,extract(epoch from clock_timestamp())::bigint FROM read_member_private.issued_verifications v
 WHERE v.id_hash=p->>'id_hash' AND v.session_hash=p->>'session_hash'
 AND v.expires_at>extract(epoch from clock_timestamp())::bigint
 ON CONFLICT (id_hash) DO NOTHING;
 GET DIAGNOSTICS n = ROW_COUNT;
 RETURN jsonb_build_object('ok',n=1);
END $$;

-- Only the BFF role can call these functions or touch their backing tables.
REVOKE ALL ON FUNCTION read_member_private.session_get(jsonb), read_member_private.session_create(jsonb),
 read_member_private.session_revoke(jsonb), read_member_private.sessions_revoke_email(jsonb),
 read_member_private.refresh_claim(jsonb), read_member_private.refresh_commit(jsonb),
 read_member_private.refresh_abort(jsonb), read_member_private.rate_limit(jsonb),
 read_member_private.captcha_create(jsonb), read_member_private.captcha_get(jsonb),
 read_member_private.captcha_verify(jsonb), read_member_private.captcha_consume(jsonb),
 read_member_private.verification_create(jsonb), read_member_private.verification_get(jsonb),
 read_member_private.verification_consume(jsonb) FROM PUBLIC;
GRANT USAGE ON SCHEMA read_member_private TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE read_member_private.sessions,
 read_member_private.rate_limits, read_member_private.captcha_images TO service_role;
GRANT SELECT, INSERT ON TABLE read_member_private.issued_verifications,
 read_member_private.used_verifications TO service_role;
GRANT EXECUTE ON FUNCTION read_member_private.session_get(jsonb), read_member_private.session_create(jsonb),
 read_member_private.session_revoke(jsonb), read_member_private.sessions_revoke_email(jsonb),
 read_member_private.refresh_claim(jsonb), read_member_private.refresh_commit(jsonb),
 read_member_private.refresh_abort(jsonb), read_member_private.rate_limit(jsonb),
 read_member_private.captcha_create(jsonb), read_member_private.captcha_get(jsonb),
 read_member_private.captcha_verify(jsonb), read_member_private.captcha_consume(jsonb),
 read_member_private.verification_create(jsonb), read_member_private.verification_get(jsonb),
 read_member_private.verification_consume(jsonb) TO service_role;
