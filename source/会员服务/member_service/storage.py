"""SQL persistence. SQLite is development only; production requires PostgreSQL."""
import sqlite3
from contextlib import contextmanager

SCHEMA = (
    'CREATE TABLE IF NOT EXISTS captcha_images (state_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, token_cipher TEXT NOT NULL, expires_at INTEGER NOT NULL, verified_cipher TEXT NOT NULL, consumed INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS captcha_challenges (state_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS issued_verifications (id_hash TEXT PRIMARY KEY, session_hash TEXT NOT NULL, email TEXT NOT NULL, usage TEXT NOT NULL, expires_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS used_verifications (id_hash TEXT PRIMARY KEY, used_at INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS sessions (id_hash TEXT PRIMARY KEY, token_cipher TEXT NOT NULL, uid TEXT NOT NULL, email TEXT NOT NULL, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL, revoked INTEGER NOT NULL)',
    'CREATE INDEX IF NOT EXISTS sessions_uid_idx ON sessions(uid)',
    'CREATE INDEX IF NOT EXISTS sessions_email_idx ON sessions(email)',
    'CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, window_start INTEGER NOT NULL, attempts INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS progress (uid TEXT NOT NULL, article_id TEXT NOT NULL, version_hash TEXT NOT NULL, position TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(uid,article_id))',
    'CREATE TABLE IF NOT EXISTS admins (uid TEXT PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS export_plans (draft_id TEXT NOT NULL, source TEXT NOT NULL, version_hash TEXT NOT NULL, plan TEXT NOT NULL, PRIMARY KEY(draft_id,source))',
    'CREATE TABLE IF NOT EXISTS articles (id TEXT PRIMARY KEY, version_hash TEXT NOT NULL, published INTEGER NOT NULL)',
    'CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, version_hash TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS assets (draft_id TEXT NOT NULL, id TEXT NOT NULL, version_hash TEXT NOT NULL, mime TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(draft_id,id))',
    'CREATE TABLE IF NOT EXISTS favorites (uid TEXT NOT NULL, article_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(uid,article_id))',
    'CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, uid TEXT NOT NULL, article_id TEXT NOT NULL, version_hash TEXT NOT NULL, anchor TEXT NOT NULL, quote TEXT NOT NULL, text TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS note_requests (uid TEXT NOT NULL, client_id TEXT NOT NULL, note_id TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL, PRIMARY KEY(uid,client_id))',
    'CREATE TABLE IF NOT EXISTS feedback (id TEXT PRIMARY KEY, uid TEXT NOT NULL, draft_id TEXT NOT NULL, version_hash TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL, quote TEXT NOT NULL, comment TEXT NOT NULL, created_at TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS feedback_edits (id TEXT PRIMARY KEY, feedback_id TEXT NOT NULL, uid TEXT NOT NULL, revision INTEGER NOT NULL, comment TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(feedback_id,revision))',
    'CREATE TABLE IF NOT EXISTS reviews (id TEXT PRIMARY KEY, uid TEXT NOT NULL, draft_id TEXT NOT NULL, version_hash TEXT NOT NULL, decision TEXT NOT NULL, comment TEXT NOT NULL, created_at TEXT NOT NULL)',
)

class SQLSession:
    def __init__(self, connection, postgres=False):
        self.connection, self.postgres = connection, postgres
    def execute(self, sql, args=()):
        cur = self.connection.cursor()
        cur.execute(sql.replace('?', '%s') if self.postgres else sql, args)
        return cur
    def all(self, sql, args=()):
        cur = self.execute(sql,args)
        names = [d[0] for d in cur.description]
        return [dict(zip(names,row)) for row in cur.fetchall()]
    def one(self, sql,args=()):
        rows = self.all(sql,args)
        return rows[0] if rows else None

class SQLiteStore:
    development_only = True
    def __init__(self, path):
        self.path = str(path)
    @contextmanager
    def transaction(self):
        connection = sqlite3.connect(self.path, timeout=15)
        try:
            connection.execute('BEGIN IMMEDIATE')
            yield SQLSession(connection)
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            connection.close()
    def initialize(self):
        with self.transaction() as tx:
            for sql in SCHEMA: tx.execute(sql)

class PostgresStore:
    development_only = False
    def __init__(self, dsn):
        if not dsn: raise ValueError('PostgreSQL DSN is required')
        self.dsn = dsn
    @contextmanager
    def transaction(self):
        import psycopg
        with psycopg.connect(self.dsn, sslmode='verify-full', connect_timeout=10) as connection:
            # SERIALIZABLE prevents approval/version check races. A concurrent edit
            # may return retryable failure, never approve a version not checked.
            connection.execute('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE')
            connection.execute('SET LOCAL search_path = read_member_private, pg_catalog')
            yield SQLSession(connection, True)
    def initialize(self):
        with self.transaction() as tx:
            tx.execute('CREATE SCHEMA IF NOT EXISTS read_member_private')
            tx.execute('REVOKE ALL ON SCHEMA read_member_private FROM PUBLIC')
            for sql in SCHEMA: tx.execute(sql)
            from pathlib import Path
            tx.execute((Path(__file__).resolve().parent.parent/'private_schema_hardening.sql').read_text(encoding='utf-8-sig'))
