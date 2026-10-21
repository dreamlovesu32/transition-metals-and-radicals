"""Audit and optionally copy an exact source allowlist into the existing public repo.

Default is a read-only plan. --apply writes reviewed code only, without git staging,
committing, pushing, Pages activation, cloud deployment, or scientific content.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import uuid
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = ROOT / "发布" / "github-pages"
FRONTEND = (
    "toast.js", "toast.css",
    "reader-core.js", "reader-contract.js", "reader_contract.py", "workbench-reader.js", "README.md", "文章模板.md",
    "tests/section-resume.test.cjs", "tests/reading-resume-sync.test.cjs", "tests/toast-toolbar.test.cjs", "tests/preload-harness.cjs", "tests/preload-queue.test.cjs", "tests/catalog-patch.test.cjs",
    "tests/reader-contract.test.cjs", "tests/test_article_interface.py", "tests/fixtures/reading-contract.json",
    "tests/figure-native-touch.test.cjs", "tests/highlight-entry.test.cjs", "tests/private-review-reader.test.cjs", "tests/version-history.test.cjs",
    "app.css", "app.js", "media_assets.py", "progressive-media.js", "progressive-media.css", "card-actions.js", "card-actions.css", "article_config.py", "catalog.css", "catalog.html",
    "catalog.js", "export_github_pages.py", "index.html", "literature-lookup.css",
    "literature-lookup.js", "reader-chrome.css", "reader-chrome.js", "inline-format.js", "server.py",
    "validate_article.py", "public-site/published-library.js", "public-site/read.html",
    "public-site/reader-boot.js", "public-site/reader-prelude.js",
    "member-system/members.js", "member-system/members.css",
    "member-system/article-export.js", "member-system/account.html",
    "member-system/favorites.html", "member-system/admin.html",
    "templates/article-manifest.example.json", "templates/content-en.example.md",
    "templates/content-zh.example.md",
    "tests/chemical-inline-export.test.cjs", "tests/loading-performance.test.cjs", "tests/card-actions.test.cjs", "tests/published-library.test.cjs", "tests/wechat-export.test.cjs",
)
FRONTEND_TESTS = (
    "account-entry.test.cjs", "admin-feedback.test.cjs", "admin-navigation.test.cjs",
    "draft-selection.test.cjs", "members.test.cjs", "navigation-init.test.cjs",
    "review-queue.test.cjs", "review-reader.test.cjs", "session-check.test.cjs",
    "reader-ui.test.cjs",
)
BACKEND_MODULES = (
    "__init__.py", "article_export.py", "cloud_assets.py", "cloud_member_service.py",
    "cloud_trusted.py", "cloudbase_auth.py", "cloudbase_pg.py",
    "cloudbase_shared_auth.py", "http.py", "ingest.py", "literature.py",
    "local_site.py", "runtime.py", "service.py", "storage.py",
)
BACKEND_BUILD = (
    "build_scf_bundle.py", "stage_linux_wheels.py", "scf_handler.py",
    "requirements.txt", "load_private_env.py", "initialize_private_config.py",
    "provision_admin.py", "run_local.py", "verify_review.py", "deployment.example.yaml",
)
BACKEND_SQL = (
    "asset_operations.sql", "auth_operations.sql", "export_operations.sql",
    "member_operations.sql", "publish_operations.sql", "trusted_operations.sql",
    "version_operations.sql",
    "feedback_edit_operations.sql",
)
BACKEND_TESTS = (
    "test_admin_attestation.py", "test_auth.py", "test_auth_startup_latency.py",
    "test_business.py", "test_cloud_assets.py", "test_cloud_member_service.py",
    "test_cloud_runtime.py", "test_cloud_trusted.py", "test_cloudbase_pg.py",
    "test_cloudbase_shared_auth.py", "test_deployment.py", "test_idempotence.py",
    "test_publication.py", "test_review_gate.py", "test_scf_handler.py",
    "test_verification_provider.py",
    "test_feedback_edit.py", "test_reader_context.py",
)
EXCLUSIONS = (
    "All private configuration, environment values, credentials, administrator bindings and IDs",
    "All build archives, dependencies, SDK copies, runtime databases, caches and logs",
    "All article bodies, article manifests, state snapshots, PDFs, SI, figures and covers",
    "All original feedback, research records, review data, backups and publication baselines",
    "Local-demo implementation and data; operational deployment/probe/admin tools",
    "Tests using real article snapshots, real bibliographic fixtures, cloud sessions or local demo data",
    "All unlisted files; the CloudBase public-site deployment allowlist is not expanded",
)
README = """# Website source

This directory contains an explicit, audited subset of application source code,
SQL definitions, build tools and tests with synthetic identities/data.
`MANIFEST.json` records each file's SHA-256; runtime source is copied byte for byte.

The directory deliberately contains no research drafts, PDF/SI files, crops,
article snapshots, feedback, administrator bindings, live credentials or databases.
It is independent of the static public website files in the repository root.
The fixed website deployment allowlist never includes `source/`.

Frontend checks: run `node --test *.test.cjs` inside
`导读工作台/member-system`. These tests run offline with fake DOM objects.

Backend checks: install `会员服务/requirements.txt`, then run
`python -m unittest discover -s tests -v` inside `会员服务`.
The included tests use mock providers and temporary databases.

Building a real site additionally requires locally maintained, authorized article
inputs and approval baselines. They are deliberately omitted. Build tools never
create publishing permission. Environment values and administrator bindings must
be supplied privately by the operator. The sample environment file has no live values.
The private workbench's `server.py` is preserved as reference source. Its local
demo adapters are deliberately omitted because their implementation contains
project-specific history bindings. It is not a standalone runnable workbench copy.
The membership backend and its included synthetic unit tests remain self-contained.

Regenerate this subset using `工具/同步网站源码.py` from the private project.
It first audits the allowlist. `--apply` copies reviewed source and creates a local
backup of changed files; it never stages, commits, pushes or deploys anything.
"""
AUDIT = """# Navigation repair and source isolation audit — 2026-10-20

## Review editor, chemistry formatting and page jumps

The current review reuses one editor for a new selection and an existing note.
Edits retain the feedback identity and append an immutable revision; the original
comment remains untouched. The server checks administrator status, the original
author, the current article hash and the expected edit revision. Concurrent edits
fail with a conflict. Archived article versions remain read-only. A new
`feedback_edit` event has its own event ID and carries the original feedback ID
and article version; original event JSON remains compatible with existing inboxes.

A shared escaped formatter renders ASCII ligand stars as superscripts in reading
and exports while preserving Markdown bold ranges. Explicit `顶部` and `底部`
buttons live in the horizontally scrollable toolbar. A jump toggles the active
button to `返回原位` and restores the original reading anchor without browser
history changes. No page jump controls overlay article images.

Five new synthetic frontend checks cover formatting, return anchors, historic
read-only mode, drawer/editor exclusion and reused editor PUT/POST behavior. Three new backend tests cover immutable edits, cursor
events, ownership, version conflicts and CSRF. The backend suite passes 157 tests.
An isolated live database transaction verified nine edit/permission/event checks
under `service_role`, then rolled back all synthetic rows. Browser acceptance is
recorded separately by the coordinating agent; these tests do not claim a real
production administrator browser session was exercised.

## Root cause and correction

The shared navigation renderer had removed the administrator's review link.
An old regression assertion explicitly expected the link to be absent, so that
test preserved the regression. The account dialog still offered review access,
but the standalone account page had no equivalent fallback.

The shared navigation now shows `审稿` only after a successful server session
response identifies an administrator and the session has not expired. The account
dialog and standalone account page also contain `稿件审核`. Guest navigation says
`登录 / 注册`; authenticated navigation says `我的账户`. Browser storage never
grants a role. Refreshed authentication rerenders mounted menus. Expiry removes
administrator links immediately, and a server role change for the same account
clears private state and reloads the page. Backend authorization remains required.

## Verification record

The full member-module fake-DOM regression checks cover catalog, favorites,
standalone account and reader menus, including delayed session restoration,
delayed private-library responses, late/repeated mounts, modal/account fallbacks,
spoofed local cache, restore failure, session expiry and same-account demotion.
The targeted navigation/account suite passed all 45 checks.

The coordinating agent additionally reported 83 offline frontend checks and
154 backend unit tests passing. Supported browser checks on the isolated local
demo verified administrator navigation into the review queue, account-dialog
review access, and hidden privileges for ordinary readers and guests.
The exact backend subset in this source manifest was also copied into a temporary,
otherwise empty project and passed its 125 synthetic tests. Five synthetic
source-sync boundary tests passed (allowlist, secret/email rejection, dry-run,
verified copy with external backup, unlisted-file refusal and path confinement).

The coordinator reported deployment using the existing 69-file public-site
allowlist. The production browser was a guest; the real production administrator
session and its menu were not exercised in that browser. Local administrator
acceptance used isolated demo accounts. Tests are evidence for their stated
scope, not a claim that every possible interaction has been verified.

## Publication boundaries

This source directory is copied through an exact allowlist and SHA-256 manifest.
It contains no article drafts, original feedback, actual administrator addresses
or IDs, credentials, databases, archived builds, real article fixtures or local
demo records. Code source publication does not approve scientific content.
The source sync command performs no git push, Pages activation or cloud upload.
`source/` remains outside the site's fixed deployment allowlist.
"""
IGNORE = """**/__pycache__/
**/.private/
**/.env
**/.env.*
!**/.env.example
**/runtime/
**/build/
**/node_modules/
**/data/
**/articles/
**/figures/
**/covers/
**/*.sqlite*
**/*.db
**/*.pdf
**/*.zip
**/*.bak
"""
ENVIRONMENT = """# Example only. Supply real values privately; authentication starts disabled.
READ_MEMBER_MODE=development
READ_MEMBER_AUTH_ENABLED=0
READ_MEMBER_DATABASE_DSN=
READ_MEMBER_AUTH_ORIGIN=https://auth.example.invalid
READ_MEMBER_ENV_ID=example-environment
READ_MEMBER_SESSION_KEY=
READ_MEMBER_ORIGIN=https://example.invalid
READ_MEMBER_SQLITE_PATH=runtime/development.sqlite
READ_MEMBER_CAPTCHA_HOSTS=
"""


def allowlist():
    files = {f"导读工作台/{name}" for name in FRONTEND}
    files.update(f"导读工作台/member-system/{name}" for name in FRONTEND_TESTS)
    files.update(f"会员服务/member_service/{name}" for name in BACKEND_MODULES)
    files.update(f"会员服务/{name}" for name in BACKEND_BUILD)
    files.update(f"会员服务/sql/{name}" for name in BACKEND_SQL)
    files.update(f"会员服务/tests/{name}" for name in BACKEND_TESTS)
    files.add("会员服务/private_schema_hardening.sql")
    files.add("工具/同步网站源码.py")
    files.add("工具/test_source_sync.py")
    files.add("工具/构建审稿预览.py")
    return sorted(files)


def confined(base, relative):
    path = base / relative
    if Path(relative).is_absolute() or ".." in Path(relative).parts:
        raise ValueError("Non-relative manifest entry")
    # Refuse junctions/symlinks anywhere in the chain, including a replaced source directory.
    for part in (path, *path.parents):
        if part == base.parent:
            break
        if part.is_symlink() or (hasattr(part, "is_junction") and part.is_junction()):
            raise ValueError("Linked source or destination refused")
    if not path.resolve().is_relative_to(base.resolve()):
        raise ValueError("Manifest path escapes root")
    return path


def audit(relative, data):
    if len(data) > 1024 * 1024:
        raise ValueError(f"Oversized source: {relative}")
    text = data.decode("utf-8-sig")
    if re.search(r"AKID[A-Za-z0-9]{16,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", text):
        raise ValueError(f"Possible credential material: {relative}")
    # Only clearly fictional test addresses are accepted; report filenames, never values.
    emails = re.findall(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{1,})", text)
    safe = {"example.org", "example.com", "example.invalid", "b.c"}
    if any(domain.lower() not in safe and not domain.lower().endswith(".example.invalid") for domain in emails):
        raise ValueError(f"Non-synthetic email address: {relative}")
    if re.search(r"\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}", text):
        raise ValueError(f"Possible session token: {relative}")


def prepare():
    payload = {}
    for relative in allowlist():
        source = confined(ROOT, relative)
        if not source.is_file():
            raise ValueError(f"Allowlisted source missing: {relative}")
        data = source.read_bytes()
        audit(relative, data)
        payload[relative] = data
    payload["README.md"] = README.encode("utf-8")
    payload["AUDIT.md"] = AUDIT.encode("utf-8")
    payload[".gitignore"] = IGNORE.encode("utf-8")
    # Hash the same bytes Git stores, regardless of the checkout's core.autocrlf.
    payload[".gitattributes"] = b"* -text\n"
    payload["会员服务/.env.example"] = ENVIRONMENT.encode("utf-8")
    manifest = {
        "format": 1,
        "policy": "exact allowlist; no git or deployment actions",
        "excluded": EXCLUSIONS,
        "files": [{"path": relative, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(),
                   "origin": "generated neutral example" if relative == "会员服务/.env.example" else
                             "generated source documentation" if relative in ("README.md", "AUDIT.md", ".gitignore", ".gitattributes") else
                             "byte-for-byte source copy"} for relative, data in sorted(payload.items())],
    }
    payload["MANIFEST.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return payload, manifest


def synchronize(apply=False):
    if not (REPOSITORY / ".git").is_dir():
        raise ValueError("Existing public Git checkout was not found")
    destination = confined(REPOSITORY, "source")
    payload, manifest = prepare()
    if destination.exists():
        existing = {item.relative_to(destination).as_posix() for item in destination.rglob("*") if item.is_file()}
        unexpected = existing - payload.keys()
        if unexpected:
            raise ValueError("Unlisted files already exist in source/; inspect them before syncing")
    changed = [name for name, data in payload.items()
               if not confined(destination, name).is_file() or confined(destination, name).read_bytes() != data]
    result = {"mode": "apply" if apply else "audit-only", "file_count": len(payload),
              "changed": changed, "manifest": manifest}
    if apply:
        backup = ROOT / "记录备份" / ("source-sync-" + datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:8])
        for relative in changed:
            target = confined(destination, relative)
            if target.exists():
                previous = backup / relative
                previous.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(target, previous)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload[relative])
        for relative, data in payload.items():
            if confined(destination, relative).read_bytes() != data:
                raise ValueError("Copied source verification failed")
        result["verified"] = True
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Copy audited code only; never push or deploy")
    parser.add_argument("--report", type=Path, help="Save audit report outside the public checkout")
    args = parser.parse_args()
    if args.report and args.report.resolve().is_relative_to(REPOSITORY.resolve()):
        raise ValueError("Keep detailed audit reports outside the public checkout")
    result = synchronize(args.apply)
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"mode": result["mode"], "files": result["file_count"],
                      "changed": len(result["changed"]), "verified": result.get("verified", False)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
