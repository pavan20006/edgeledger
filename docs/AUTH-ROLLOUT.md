# Authentication rollout notes

This branch adds email/password signup, login, logout, SQLite-backed sessions, and per-user access checks for trades and screenshots.

## IMPORTANT: Do not deploy or merge yet
The existing database has historical trades without a user_id. They are deliberately left unassigned, not deleted or automatically given to the first registrant. After backing up the live SQLite database and confirming the Railway volume and JOURNAL_DB path, an explicit, verified migration is required to assign those records to the intended account. Until then, historical trades will not appear after login.

## Deployment prerequisites
- Confirm Railway uses persistent SQLite storage at /app/data/journal.db (check JOURNAL_DB or working directory).
- Back up the SQLite database safely, including WAL state.
- Review the migration plan for existing trades and screenshots.
- Test with two distinct accounts, verify each can only read/change its own trades and screenshots, and confirm sessions persist across restarts.
- Confirm HTTPS is enabled on the deployment.
- Review account registration policy, login rate limiting, session expiry/cleanup, and recovery mechanisms before public release.

No deployment settings or live database were changed in this branch.
