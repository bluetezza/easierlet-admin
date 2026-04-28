# easierlet-admin

Admin dashboard for [EasierLet](https://easierlet.com), deployed to **admin.easierlet.com** via GitHub Pages.

## Stack

Pure static — no build step. Vanilla JS + the Supabase JS SDK loaded from `esm.sh` CDN. The same pattern as `bluetezza/easierlet-web`.

## Auth model

- **Separate Supabase auth account** from any landlord identity (e.g. `admin@easierlet.com`).
- Mandatory **TOTP MFA** — no password-only access.
- Server-side gate via `admin-auth` and `admin-api` Edge Functions, which check the `admin_users` table and the session's AAL2 status before doing anything.

## Pages

| Path | Purpose |
|---|---|
| `index.html`      | Login + MFA challenge + first-time MFA enrollment |
| `dashboard.html`  | Stats cards, recent audit feed, alerts |
| `landlord.html`   | Per-landlord detail (`?id=…`) |
| `audit.html`      | Audit log explorer with filters + CSV export |
| `retention.html`  | Tenants approaching/past retention; defer / force overrides |
| `dsar.html`       | Generate a DSAR PDF for a landlord or tenant |
| `settings.html`   | MFA management; admin user management (owner only) |

## Local dev

Open `index.html` directly in a browser, or serve with `python3 -m http.server`. There's nothing to compile.

## Deployment

GitHub Pages is configured to serve from `main`. Pushing to `main` deploys within ~30 seconds. The `CNAME` file maps the site to `admin.easierlet.com`.

## DNS

Add a `CNAME` record at the easierlet.com DNS host:

```
admin    CNAME    bluetezza.github.io.
```
