"""Loopback development runner. No fake users, no public draft files."""
import os
from wsgiref.simple_server import make_server
from member_service.runtime import create_app
from member_service.local_site import LocalSite

if __name__=='__main__':
    from load_private_env import load_private_env
    load_private_env()
    if os.getenv('READ_MEMBER_MODE')!='development':raise SystemExit('Set READ_MEMBER_MODE=development and an explicit SQLite path first.')
    app=create_app()
    if os.getenv('READ_MEMBER_STATIC_ROOT'):app=LocalSite(app,os.environ['READ_MEMBER_STATIC_ROOT'])
    with make_server('127.0.0.1',int(os.getenv('READ_MEMBER_LOCAL_PORT','8770')),app) as server:server.serve_forever()
