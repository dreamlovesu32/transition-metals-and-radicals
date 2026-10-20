"""Explicit dotenv parser: no shell evaluation, interpolation or secret output."""
import os
from pathlib import Path

def load_private_env(path=None):
    path=Path(path) if path else Path(__file__).resolve().parent/'.private'/'member.env'
    if not path.exists():return
    allowed={'READ_MEMBER_MODE','READ_MEMBER_AUTH_ENABLED','READ_MEMBER_DATABASE_DSN','READ_MEMBER_AUTH_ORIGIN','READ_MEMBER_ENV_ID','READ_MEMBER_SESSION_KEY','READ_MEMBER_ORIGIN','READ_MEMBER_CAPTCHA_HOSTS','READ_MEMBER_SQLITE_PATH','READ_MEMBER_STATIC_ROOT','READ_MEMBER_LOCAL_PORT'}
    for line in path.read_text(encoding='utf-8-sig').splitlines():
        if not line.strip() or line.lstrip().startswith('#'):continue
        key,separator,value=line.partition('=')
        if not separator or key.strip() not in allowed:raise ValueError('Invalid private configuration key')
        os.environ.setdefault(key.strip(),value.strip())
