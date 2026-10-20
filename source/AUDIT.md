# Navigation repair and source isolation audit — 2026-10-20

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
