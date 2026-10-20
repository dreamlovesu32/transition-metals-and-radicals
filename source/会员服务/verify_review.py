r"""Read-only human publication gate evidence. This program never publishes.

Example (DSN comes from the private configuration or process environment):
  python verify_review.py --article r20261018-01 --report D:\Read\tmp\review-evidence.json

The report is a point-in-time observation, not a new approval or a substitute
for the existing export whitelist, approved baseline, or the user's permission.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from load_private_env import load_private_env


class GateRejected(ValueError):
    pass


def _hash(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{64}", value):
        raise GateRejected("invalid_version_hash")
    return value


def _time(value):
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if parsed.utcoffset() is None:
            raise ValueError("timezone required")
        return parsed.astimezone(timezone.utc)
    except (ValueError, TypeError, OverflowError) as error:
        raise GateRejected("invalid_review_time") from error


def validate_review(article_id, local_hash, online_hash, reviews):
    """Pure validation; callers must supply rows from the trusted SQL adapter.

    All versions' decisions matter: never search backwards for an older approval
    matching the desired local hash. Equal timestamps with different decisions
    or hashes are ambiguous; identical outcomes use ID only for evidence naming.
    """
    _hash(local_hash)
    _hash(online_hash)
    if local_hash != online_hash:
        raise GateRejected("online_draft_differs_from_current_local_content")
    if not reviews:
        raise GateRejected("no_review")
    if len(reviews) > 10000:
        raise GateRejected("too_many_reviews")
    ordered = []
    for row in reviews:
        if row.get("draft_id") != article_id:
            raise GateRejected("review_article_mismatch")
        if not isinstance(row.get("id"), str) or not row["id"] or not isinstance(row.get("uid"), str) or not row["uid"]:
            raise GateRejected("invalid_review_identity")
        _hash(row.get("version_hash"))
        if row.get("decision") not in ("approved", "changes_requested"):
            raise GateRejected("invalid_review_decision")
        ordered.append((_time(row.get("created_at")), row))
    ordered.sort(key=lambda pair: (pair[0], pair[1]["id"]), reverse=True)
    tied = [row for timestamp, row in ordered if timestamp == ordered[0][0]]
    if len({(row["decision"], row["version_hash"]) for row in tied}) > 1:
        raise GateRejected("ambiguous_latest_review_time")
    latest = ordered[0][1]
    if latest["decision"] != "approved":
        raise GateRejected("latest_review_requests_changes")
    if latest["version_hash"] != local_hash:
        raise GateRejected("latest_approval_is_for_another_version")
    return {
        "article_id": article_id, "approved": True,
        "local_bundle_sha256": local_hash, "online_draft_sha256": online_hash,
        "review_id": latest["id"], "reviewer_uid": latest["uid"],
        "review_version_sha256": latest["version_hash"],
        "decision": latest["decision"], "reviewed_at": latest["created_at"],
    }


def _connect(dsn):
    import psycopg
    from psycopg.rows import dict_row
    return psycopg.connect(dsn, sslmode="verify-full", connect_timeout=10, row_factory=dict_row)


def fetch_database_snapshot(dsn, article_ids, connector=None):
    """No schema initialization, mutation, HTTP input, or JSON review imports."""
    if not dsn:
        raise GateRejected("postgres_dsn_required")
    for aid in article_ids:
        if not isinstance(aid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", aid):
            raise GateRejected("invalid_article_id")
    result = {}
    with (connector or _connect)(dsn) as connection:
        connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        for aid in article_ids:
            draft = connection.execute(
                "SELECT id,version_hash FROM read_member_private.drafts WHERE id=%s", (aid,)
            ).fetchone()
            if not draft:
                raise GateRejected("online_draft_not_found")
            reviews = connection.execute(
                "SELECT id,uid,draft_id,version_hash,decision,created_at "
                "FROM read_member_private.reviews WHERE draft_id=%s ORDER BY created_at DESC,id DESC", (aid,)
            ).fetchmany(10001)
            result[aid] = {"version_hash": draft["version_hash"], "reviews": reviews}
    return result


def local_bundle(workbench, article_id):
    """Reuse the real publication digest, including all cover/figure bytes."""
    workbench = Path(workbench).resolve(strict=True)
    sys.path.insert(0, str(workbench))
    try:
        config = importlib.import_module("article_config")
        exporter = importlib.import_module("export_github_pages")
        if Path(config.__file__).resolve().parent != workbench or Path(exporter.__file__).resolve().parent != workbench:
            raise GateRejected("workbench_import_mismatch")
        article = config.load_article(article_id)
        state = json.loads(article["state"]["zh"].read_text(encoding="utf-8"))
        blocks = exporter.public_blocks(state, article, require_approval=False)
        return {"bundle_hash": exporter.publication_digest(article, blocks), "revision": state["revision"]}
    finally:
        sys.path.pop(0)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--article", action="append", required=True)
    parser.add_argument("--workbench", type=Path, default=Path(__file__).resolve().parent.parent / "导读工作台")
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        load_private_env()
    except Exception:
        print("REJECTED: private_configuration_invalid; no database was contacted.", file=sys.stderr)
        return 2
    dsn = os.environ.get("READ_MEMBER_DATABASE_DSN")
    if not dsn:
        print("REJECTED: postgres_dsn_required; no database was contacted.", file=sys.stderr)
        return 2
    try:
        ids = list(dict.fromkeys(args.article))
        local = {aid: local_bundle(args.workbench, aid) for aid in ids}
        snapshot = fetch_database_snapshot(dsn, ids)
        checks = []
        accepted = True
        for aid in ids:
            try:
                check = validate_review(aid, local[aid]["bundle_hash"], snapshot[aid]["version_hash"], snapshot[aid]["reviews"])
                check["local_revision"] = local[aid]["revision"]
            except GateRejected as error:
                accepted = False
                check = {"article_id": aid, "approved": False, "reason": str(error), "local_bundle_sha256": local[aid]["bundle_hash"], "online_draft_sha256": snapshot[aid]["version_hash"], "latest_review_records": sorted(snapshot[aid]["reviews"], key=lambda row: (_time(row["created_at"]), row["id"]), reverse=True)[:2]}
            checks.append(check)
        # Repeat the local digest after the SQL snapshot to detect edits during
        # this check. The report must still be rechecked at the publication step.
        for aid in ids:
            if local_bundle(args.workbench, aid) != local[aid]:
                raise GateRejected("local_content_changed_during_check")
        report = {"format": "read-review-evidence-v1", "checked_at": datetime.now(timezone.utc).isoformat(),
                  "all_approved": accepted, "source": "trusted_postgresql_read_only_snapshot", "checks": checks,
                  "scope": "Evidence for manual publication checks only. Does not authorize or perform publication, baseline changes, status changes, or whitelist changes."}
        encoded = json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + "\n"
        report["report_sha256"] = hashlib.sha256(encoded.encode()).hexdigest()
        # New evidence files only: never overwrite a previous audit record.
        with args.report.open("x", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        print(f"{'VERIFIED' if accepted else 'REJECTED'}: evidence written; publication was not performed.")
        return 0 if accepted else 1
    except Exception as error:
        # Do not expose DSNs, database diagnostics, or authentication secrets.
        reason = str(error) if isinstance(error, GateRejected) else type(error).__name__
        print(f"REJECTED: {reason}; no publication was performed.", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
