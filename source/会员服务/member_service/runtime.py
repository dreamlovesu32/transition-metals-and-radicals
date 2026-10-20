"""Fail-closed factory. Importing this module does not initialize/change any database."""
import os
import json
import time
import logging
from .http import MemberApp
from .service import MemberService
from .storage import PostgresStore,SQLiteStore


def _scf_sdk_client():
    """Read the current SCF identity for each call, not once per warm instance."""
    keys = ('TENCENTCLOUD_SECRETID', 'TENCENTCLOUD_SECRETKEY',
            'TENCENTCLOUD_SESSIONTOKEN')
    if os.environ.get('TENCENTCLOUD_RUNENV') != 'SCF' or any(not os.environ.get(k) for k in keys):
        raise RuntimeError('SCF temporary credentials required')
    from tencentcloud.common.credential import Credential
    from tencentcloud.common.profile.client_profile import ClientProfile
    from tencentcloud.common.retry import NoopRetryer
    from tencentcloud.tcb.v20180608.tcb_client import TcbClient
    credential = Credential(*(os.environ[k] for k in keys))
    profile = ClientProfile(disable_region_breaker=True, retryer=NoopRetryer())
    client = TcbClient(credential, os.environ['READ_MEMBER_REGION'], profile)
    return client

def _scf_sdk_caller():
    from .cloudbase_pg import tencent_sdk_caller
    return tencent_sdk_caller(_scf_sdk_client())

def _admin_status_lookup(uid,email):
    from tencentcloud.tcb.v20180608.models import DescribeUserListRequest
    request=DescribeUserListRequest()
    request.from_json_string(json.dumps({'EnvId':os.environ['READ_MEMBER_ENV_ID'],
        'UidList':[uid],'Email':email,'PageNo':1,'PageSize':2}))
    started=time.monotonic()
    outcome='failed'
    try:
        result=json.loads(_scf_sdk_client().DescribeUserList(request).to_json_string())
        outcome='ok'
        return result
    finally:
        logging.getLogger(__name__).warning('auth_timing stage=operator_identity outcome=%s elapsed_ms=%d',outcome,int((time.monotonic()-started)*1000))

def _admin_binding():
    raw=os.getenv('READ_MEMBER_ADMIN_BINDING','')
    if not raw:return None
    try:binding=json.loads(raw)
    except (TypeError,ValueError):raise ValueError('invalid_admin_binding') from None
    if (not isinstance(binding,dict) or set(binding)!={'uid','email'}
            or not isinstance(binding['uid'],str) or not 0<len(binding['uid'])<=256
            or not isinstance(binding['email'],str) or not 0<len(binding['email'])<=254
            or binding['email']!=binding['email'].strip().lower()
            or '@' not in binding['email'] or '\x00' in binding['uid']+binding['email']):
        raise ValueError('invalid_admin_binding')
    return binding

def _cloudbase_operations():
    from .cloudbase_pg import CloudPGOperations
    # Validate at startup, but do not retain temporary keys in a cached client.
    _scf_sdk_caller()
    def execute(payload):
        return _scf_sdk_caller()(payload)
    return CloudPGOperations(execute, os.environ['READ_MEMBER_ENV_ID'])

def create_app():
    mode=os.getenv('READ_MEMBER_MODE','production')
    if mode=='development':
        path=os.environ['READ_MEMBER_SQLITE_PATH']
        store=SQLiteStore(path)
    elif mode=='production':store=PostgresStore(os.environ['READ_MEMBER_DATABASE_DSN'])
    elif mode=='cloudbase':store=_cloudbase_operations()
    else:raise ValueError('invalid READ_MEMBER_MODE')
    if mode=='cloudbase':
        from .cloud_member_service import CloudMemberService
        service=CloudMemberService(store)
    else:service=MemberService(store)
    origin=os.getenv('READ_MEMBER_ORIGIN','https://metalradical.xyz')
    auth=None
    if os.getenv('READ_MEMBER_AUTH_ENABLED')=='1':
        if mode=='cloudbase':
            from .cloudbase_shared_auth import CloudBaseSharedAuth as Auth
        else:
            from .cloudbase_auth import CloudBaseAuth as Auth
        auth=Auth(store,os.environ['READ_MEMBER_AUTH_ORIGIN'],os.environ['READ_MEMBER_SESSION_KEY'],os.environ['READ_MEMBER_ENV_ID'],origin,tuple(filter(None,os.getenv('READ_MEMBER_CAPTCHA_HOSTS','').split(','))))
    if mode=='cloudbase' and auth is not None:
        auth.admin_binding=_admin_binding()
        auth.admin_status_lookup=_admin_status_lookup
    return MemberApp(service,auth,origin)
