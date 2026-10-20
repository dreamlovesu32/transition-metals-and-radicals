"""Single-call private PostgreSQL operations; never a cross-request transaction.

The transport deliberately cannot execute arbitrary SQL or impersonate a UID.
The BFF supplies authenticated operation arguments, and each database function
must validate them and complete its entire transaction inside one invocation.
Not wired into runtime until those functions and cloud permission tests exist.
"""
import json
import re


class CloudPGError(RuntimeError):
    pass


class CloudPGOutcomeUnknown(CloudPGError):
    """Do not retry a write automatically: it may already have committed."""


OPERATIONS = frozenset({
    'session_get', 'session_create', 'session_revoke', 'sessions_revoke_email',
    'refresh_claim', 'refresh_commit', 'refresh_abort', 'rate_limit',
    'captcha_create', 'captcha_get', 'captcha_verify', 'captcha_consume',
    'verification_create', 'verification_get', 'verification_consume',
    'member_me', 'favorites_list', 'favorite_set', 'notes_list', 'note_add',
    'note_delete', 'progress_get', 'progress_set', 'drafts_list', 'draft_get',
    'draft_publish', 'public_articles', 'public_article', 'public_asset_chunk',
    'draft_asset_chunk', 'feedback_add', 'review_add', 'feedback_list',
    'export_plan', 'draft_versions', 'draft_version_get', 'version_asset_chunk', 'feedback_edit','feedback_records',
})


def operation_sql(operation, payload):
    if operation not in OPERATIONS:
        raise ValueError('unknown_database_operation')
    if not isinstance(payload, dict):
        raise ValueError('operation_payload_must_be_object')
    # Hex is an alphabet with no SQL delimiters. No user-controlled SQL literal,
    # identifier or expression is interpolated. jsonb parsing happens on server.
    try:
        raw = json.dumps(payload, ensure_ascii=False, allow_nan=False,
                         separators=(',', ':')).encode('utf-8')
    except (TypeError, ValueError, UnicodeError) as exc:
        raise ValueError('invalid_operation_payload') from exc
    if len(raw) > 262144 or b'\\u0000' in raw:
        raise ValueError('operation_payload_limit')
    return (f"SELECT read_member_private.{operation}("
            f"convert_from(decode('{raw.hex()}','hex'),'UTF8')::jsonb) AS result")


def decode_result(response):
    if not isinstance(response, dict) or response.get('Error'):
        raise CloudPGError('database_operation_failed')
    if response.get('Columns') != ['result']:
        raise CloudPGError('unexpected_database_columns')
    rows = response.get('Rows')
    if not isinstance(rows, list) or len(rows) != 1:
        raise CloudPGError('unexpected_database_rows')
    try:
        row = json.loads(rows[0])
        if not isinstance(row, list) or len(row) != 1 or not isinstance(row[0], str):
            raise ValueError()
        result = json.loads(row[0])
        if not isinstance(result, dict):
            raise ValueError()
    except (TypeError, ValueError) as exc:
        raise CloudPGError('invalid_database_result') from exc
    return result


class CloudPGOperations:
    """api_call takes one ExecutePGSql request; no retries, no raw-error logging."""
    def __init__(self, api_call, env_id, role='service_role'):
        if not re.fullmatch(r'[a-zA-Z0-9-]{1,128}', env_id):
            raise ValueError('invalid_environment')
        # The actual role was verified by SELECT current_user in this environment.
        # Its private-schema grants still need explicit deployment verification.
        if role != 'service_role':
            raise ValueError('unverified_database_role')
        self.api_call, self.env_id, self.role = api_call, env_id, role

    def call(self, operation, payload):
        request = {'EnvId': self.env_id, 'Role': self.role,
                   'Sql': operation_sql(operation, payload)}
        try:
            response = self.api_call(request)
        except Exception:
            # Includes transport failure after sending. Never echo SQL, payload,
            # credentials or upstream exception text to HTTP clients or logs.
            raise CloudPGOutcomeUnknown('database_outcome_unknown') from None
        return decode_result(response)


def tencent_sdk_caller(client):
    """Use an official Tencent SDK client configured with server-only credentials.

    Deployment must disable SDK automatic retries and grant ExecutePGSql only
    for the intended environment. This helper never discovers CLI credentials.
    """
    def execute(payload):
        from tencentcloud.tcb.v20180608.models import ExecutePGSqlRequest
        request = ExecutePGSqlRequest()
        request.from_json_string(json.dumps(payload))
        return json.loads(client.ExecutePGSql(request).to_json_string())
    return execute
