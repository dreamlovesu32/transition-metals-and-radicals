"""CloudBase Auth BFF persistence through one-call private PostgreSQL operations.

The upstream refresh request is never made while a database transaction is open.
Pending/ambiguous refreshes cannot replay a potentially rotated refresh token.
"""
import json
import logging
import secrets
import time
from concurrent.futures import ThreadPoolExecutor

from .cloudbase_auth import CloudBaseAuth
from .cloudbase_pg import CloudPGError
from .service import ServiceError


def operator_admin_attested(user, binding, lookup):
    """Independent control-plane evidence; never invent provider claims."""
    if not isinstance(binding,dict) or not callable(lookup) or not isinstance(user,dict):
        return False
    uid=binding.get('uid');email=binding.get('email')
    if (not isinstance(uid,str) or not uid or not isinstance(email,str) or not email
            or user.get('sub')!=uid or str(user.get('email','')).strip().lower()!=email):
        return False
    if user.get('email_verified') is False or user.get('status') not in (None,'ACTIVE','active'):
        return False
    try:
        result=lookup(uid,email)
    except Exception:
        raise ServiceError(503,'admin_identity_unavailable') from None
    # DescribeUserList SDK/control-plane responses wrap the page in Data.
    # Keep the flat form for existing adapters, but never fall back from a
    # malformed explicit Data envelope to unrelated root fields.
    page=result.get('Data') if isinstance(result,dict) and 'Data' in result else result
    rows=page.get('UserList') if isinstance(page,dict) else None
    if isinstance(page,dict) and 'Total' in page and (type(page['Total']) is not int or page['Total']!=1):
        return False
    if not isinstance(rows,list) or len(rows)!=1:
        return False
    record=rows[0]
    return (isinstance(record,dict) and record.get('Uid')==uid
            and str(record.get('Email','')).strip().lower()==email
            and record.get('UserStatus')=='ACTIVE')


class CloudBaseSharedAuth(CloudBaseAuth):
    def _call(self, name, **values):
        started=time.monotonic()
        outcome='failed'
        try:
            result = self.store.call(name, values)
            if not isinstance(result, dict):
                raise CloudPGError('invalid_database_result')
            outcome='ok'
            return result
        except CloudPGError:
            raise ServiceError(503, 'auth_unavailable') from None
        finally:
            from .cloudbase_pg import OPERATIONS
            stage=name if name in OPERATIONS else 'other'
            logging.getLogger(__name__).warning('auth_timing stage=database_%s outcome=%s elapsed_ms=%d',stage,outcome,int((time.monotonic()-started)*1000))

    def _ok(self, name, **values):
        if self._call(name, **values).get('ok') is not True:
            raise ServiceError(503, 'auth_unavailable')

    def _session_get(self, key):
        return self._call('session_get', id_hash=key) or None

    def _session_create(self, key, encoded, uid, email, csrf, expiry):
        self._ok('session_create', id_hash=key, token_cipher=encoded, uid=uid,
                 email=email, csrf=csrf, expires_at=expiry)

    def _session_revoke(self, key):
        self._ok('session_revoke', id_hash=key)

    def _sessions_revoke_email(self, email):
        self._ok('sessions_revoke_email', email=email)

    def _rate_attempt(self, key, now, threshold):
        result = self._call('rate_limit', bucket=key, seconds=now-threshold)
        attempts = result.get('attempts')
        if type(attempts) is not int or attempts < 1:
            raise ServiceError(503, 'auth_unavailable')
        return attempts

    def _captcha_create(self, state_hash, session_hash, token_cipher, expiry):
        self._ok('captcha_create', state_hash=state_hash, session_hash=session_hash,
                 token_cipher=token_cipher, expires_at=expiry)

    def _captcha_get(self, state_hash, session_hash):
        # This operation atomically claims the challenge before upstream HTTP.
        return self._call('captcha_get', state_hash=state_hash, session_hash=session_hash) or None

    def _captcha_verify(self, state_hash, session_hash, verified_cipher, expiry):
        self._ok('captcha_verify', state_hash=state_hash, session_hash=session_hash,
                 verified_cipher=verified_cipher, expires_at=expiry)

    def _captcha_consume(self, state_hash, session_hash):
        return self._call('captcha_consume', state_hash=state_hash, session_hash=session_hash) or None

    def _verification_create(self, id_hash, session_hash, email, usage, expiry):
        self._ok('verification_create', id_hash=id_hash, session_hash=session_hash,
                 email=email, usage=usage, expires_at=expiry)

    def _verification_exchange(self, id_hash, session_hash, vid, code):
        # Claim first so two BFF instances cannot redeem the same code. A failed
        # or ambiguous upstream call consumes the attempt and requires a new code.
        if not self._call('verification_consume', id_hash=id_hash,
                          session_hash=session_hash).get('ok'):
            raise ServiceError(409, 'verification_already_used')
        return self._upstream('/auth/v1/verification/verify',
                              {'verification_id':vid, 'verification_code':code})

    def _verification_get(self, id_hash, session_hash):
        result = self._call('verification_get', id_hash=id_hash, session_hash=session_hash)
        if result.get('already_used') is True:
            raise ServiceError(409, 'verification_already_used')
        return result or None

    def authenticate(self, e):
        row = self._row(e)
        e['member.preauth_row'] = (self, row)
        if not row:
            return None
        tokens = self._tokens(row)
        if not tokens.get('access_token'):
            return None
        if tokens.get('_expires_at', 0) <= time.time() + 30:
            owner = secrets.token_hex(32)
            claim = self._call('refresh_claim', id_hash=row['id_hash'],
                               token_cipher=row['token_cipher'], owner=owner)
            state = claim.get('status')
            if state == 'updated':
                fresh = claim.get('row')
                if not isinstance(fresh, dict):
                    raise ServiceError(503, 'auth_unavailable')
                tokens = self._tokens(fresh)
            elif state == 'claimed':
                fresh = claim.get('row')
                if not isinstance(fresh, dict):
                    raise ServiceError(503, 'auth_unavailable')
                tokens = self._tokens(fresh)
                try:
                    renewed = self._upstream('/auth/v1/token', {
                        'client_id':self.client_id, 'grant_type':'refresh_token',
                        'refresh_token':tokens.get('refresh_token')})
                    renewed['_expires_at'] = int(time.time()) + int(renewed.get('expires_in', 0))
                    renewed['_auth_time'] = tokens.get('_auth_time', 0)
                    if not renewed.get('refresh_token'):
                        renewed['refresh_token'] = tokens.get('refresh_token')
                    cipher = self.cipher.encrypt(json.dumps(renewed).encode()).decode()
                    self._ok('refresh_commit', id_hash=row['id_hash'], owner=owner,
                             token_cipher=cipher)
                    tokens = renewed
                except Exception:
                    # Abort is best effort. If it or commit has unknown outcome,
                    # never retry the old token in this request. Pending claims
                    # expire by revoking the session, never by reassignment.
                    try:
                        self._call('refresh_abort', id_hash=row['id_hash'], owner=owner)
                    except ServiceError:
                        pass
                    raise ServiceError(503, 'auth_unavailable') from None
            elif state == 'expired':
                raise ServiceError(401, 'session_expired')
            else:
                raise ServiceError(503, 'auth_unavailable')
            if tokens.get('_expires_at', 0) <= time.time():
                raise ServiceError(503, 'auth_unavailable')
        e['member.auth_time'] = tokens.get('_auth_time', 0)
        # These independent reads used to run serially on every request. Only
        # role discovery/admin routes need the extra control-plane attestation.
        # The persisted row merely selects a lookup candidate; it never grants
        # access. Both responses are checked against the live identity below.
        path = e.get('PATH_INFO', '')
        needs_admin = path in ('/api/member/session', '/api/member/reader-context') or path.startswith('/api/member/admin/')
        binding = getattr(self, 'admin_binding', None)
        lookup = getattr(self, 'admin_status_lookup', None)
        candidate = (needs_admin and isinstance(binding, dict) and callable(lookup)
                     and row.get('uid') == binding.get('uid')
                     and str(row.get('email', '')).strip().lower() == binding.get('email'))
        if candidate:
            with ThreadPoolExecutor(max_workers=1) as pool:
                attestation = pool.submit(lookup, binding['uid'], binding['email'])
                user = self._upstream('/auth/v1/user/me', token=tokens['access_token'])
            # Consume only after the same live-identity checks as before. Errors
            # remain sanitized by operator_admin_attested and fail closed.
            lookup = lambda uid, email: attestation.result()
        else:
            user = self._upstream('/auth/v1/user/me', token=tokens['access_token'])
        uid = user.get('sub')
        if user.get('status') not in (None, 'ACTIVE', 'active'):
            raise ServiceError(401, 'account_inactive')
        if not isinstance(uid, str) or not uid or uid != row['uid']:
            raise ServiceError(401, 'invalid_identity')
        from .http import Identity
        return Identity(uid, user.get('email', ''), row['csrf'],
                        user.get('email_verified') is True, user.get('status') == 'ACTIVE',
                        operator_admin_attested(user, binding, lookup) if needs_admin else False)
