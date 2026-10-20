# Website source

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
