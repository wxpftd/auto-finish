# auto-finish-be-smoke

Backend half of the auto-finish two-repo smoke. Pairs with
[`auto-finish-fe-smoke`](https://github.com/wxpftd/auto-finish-fe-smoke).

Currently exposes:
- `GET /api/health` → `{ok: true}`

Pending (added by an auto-finish run):
- `GET /api/echo?msg=...` → `{echoed: msg, at: <ISO timestamp>}`
