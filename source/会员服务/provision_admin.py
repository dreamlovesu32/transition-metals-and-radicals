"""Explicit offline operator grant using a stored, live-verified hosted session.
No browser HttpOnly cookie export, raw token output, or first-user elevation.
"""
import argparse
import time
from load_private_env import load_private_env
from member_service.runtime import create_app

class ProvisionRejected(Exception):pass

def grant_admin_from_sessions(app,email):
    email=email.strip().lower()
    if not email or not getattr(app.auth,'configured',False):raise ProvisionRejected('Hosted Auth and an explicit administrator email are required.')
    with app.service.store.transaction() as tx:
        rows=tx.all('SELECT * FROM sessions WHERE email=? AND revoked=0 AND expires_at>? ORDER BY expires_at DESC LIMIT 20',(email,int(time.time())))
    for row in rows:
        try:
            tokens=app.auth._tokens(row)
            access=tokens.get('access_token')
            if not access:continue
            user=app.auth._upstream('/auth/v1/user/me',token=access)
        except Exception:continue
        if not isinstance(user,dict) or not row['uid'] or user.get('sub')!=row['uid']:continue
        if str(user.get('email','')).strip().lower()!=email or user.get('email_verified') is not True or user.get('status')!='ACTIVE':continue
        with app.service.store.transaction() as tx:
            # Recheck persisted revocation before committing the operator grant.
            current=tx.one('SELECT uid FROM sessions WHERE id_hash=? AND revoked=0 AND expires_at>?',(row['id_hash'],int(time.time())))
            if not current or current['uid']!=user['sub']:continue
            tx.execute('INSERT INTO admins VALUES (?) ON CONFLICT(uid) DO NOTHING',(user['sub'],))
        return
    raise ProvisionRejected('No live, verified ACTIVE hosted identity matched this email. Sign in normally first; no grant applied.')

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--email',required=True);args=parser.parse_args()
    load_private_env()
    try:grant_admin_from_sessions(create_app(),args.email)
    except ProvisionRejected as error:raise SystemExit(str(error)) from None
    except Exception:raise SystemExit('Administrator provisioning failed; check private service configuration. No credentials were displayed.') from None
    print('Administrator whitelist grant applied to the explicitly named, live-verified active account.')
