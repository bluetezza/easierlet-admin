# EasierLet — Security Policy

**Last reviewed:** 2026-04-28

Technical security documentation for the EasierLet platform.

---

## 1. Architecture overview

| Layer | Provider | Purpose |
|---|---|---|
| Frontend (iOS) | Native SwiftUI | Landlord + tenant clients |
| Frontend (web) | Static HTML + vanilla JS, deployed via GitHub Pages | easierlet.com (public + portals), admin.easierlet.com (admin), bluetezza.github.io (origin) |
| Auth | Supabase Auth | Email/password + magic-link + TOTP MFA |
| Database | Supabase Postgres (eu-west-2) | All structured data |
| Storage | Cloudflare R2 (private bucket for documents) + Supabase Storage (DSAR HTML, listing media) | File storage |
| Compute | Supabase Edge Functions (Deno) | All server-side logic |
| Email | Resend (verified `easierlet.com` domain) | Transactional + system emails |
| Billing | Stripe (test mode currently) | Subscription + Customer Portal |

DNS is managed at the easierlet.com registrar with CNAMEs pointing to GitHub Pages.

## 2. Authentication model

### Three identity tiers

1. **Landlord** — Supabase Auth user with a row in `landlord_profiles`. RLS gates everything by `auth.uid()`. JWT in localStorage on web, Keychain on iOS.
2. **Tenant** — Supabase Auth user linked via `tenants.tenant_auth_id = auth.uid()`. Limited RLS scope.
3. **Admin** — Supabase Auth user with a row in `admin_users.auth_id`. **Mandatory TOTP MFA** — no password-only access. `aal2` enforced server-side by `admin-api`.

### Routing

The web `/login/` page checks `profiles.role` after sign-in to decide between `/landlord/` and `/tenant/`. Admin sign-in is at `admin.easierlet.com/index.html` only — separate auth account, separate domain.

### Password policy

Supabase Auth enforces minimum 6 characters by default. We enforce **8 characters** for landlord signup (`landlord-signup` EF) and **12 characters** for admin (`seed-admin` EF). Adjust in Supabase Dashboard → Authentication → Settings if we tighten.

### Session lifetime

- Landlord / tenant: 1 hour access token + 30-day refresh, rotated on use.
- Admin: same Supabase defaults but the admin-api requires `aal2` on every call, so the practical limit is set by the AAL2 cookie (re-prompts for TOTP after browser close or 24h, depending on Supabase config).

## 3. Encryption

| At rest | In transit |
|---|---|
| AES-256 in Supabase (managed by AWS RDS / S3) | TLS 1.2+ enforced via HSTS on easierlet.com |
| AES-256 in Cloudflare R2 | TLS 1.2+ enforced by Cloudflare |
| Encrypted backups (Supabase daily snapshots) | TLS for all Edge Function ↔ third-party calls |

We don't currently use customer-managed keys (CMK). All keys are managed by the platform provider.

## 4. API security

### RLS

Every public table has Row Level Security enabled. Policies are documented in `data-protection-policy.md` Section 4 and verified by the `security-check` Edge Function.

`audit_log` and `admin_users` have RLS enabled with **no user-facing policies** — these are service-role only. The audit log additionally has `RULE audit_no_update DO INSTEAD NOTHING` and `RULE audit_no_delete DO INSTEAD NOTHING`, which prevents *anyone* including service-role from modifying or deleting entries.

### Edge Function auth

Three patterns:

1. **JWT verification at gateway** (`verify_jwt = true`, default). The function receives `request.user` from Supabase. Used by most landlord-facing functions.
2. **Token in body** (`verify_jwt = false`). The function reads the JWT itself and calls `getUser(jwt)`. Used for `address-lookup`, `send-viewing-confirmation`, and any function called via raw `URLSession.shared.data(for:)` from Swift (where the supabase-swift SDK's session refresh is awkward).
3. **No JWT** (`verify_jwt = false`). Function uses a different auth mechanism — Turnstile token (`landlord-signup`, `listing-apply`), per-row `access_token` (`viewing-response`, `visit-response`), or shared secret (`retention-enforce` + `RETENTION_CRON_SECRET`, `seed-admin` + `SEED_SECRET`, `stripe-webhook` + signature verification).

### Service role usage

The `SUPABASE_SERVICE_ROLE_KEY` is **only** used inside Edge Functions, never in any client-side JS or Swift code. It's auto-injected by Supabase as `Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")`.

The `admin-api` function uses service-role to read across the platform after gating on the admin's JWT + `aal2` + `admin_users` row. The `generate-dsar` function uses service-role similarly.

## 5. Secret management

Secrets live in:

- **Supabase Dashboard → Edge Functions → Secrets** for runtime EF env vars
  - `RESEND_API_KEY`
  - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BUCKET`, `R2_PRIVATE_BUCKET`, `R2_PUBLIC_URL_BASE`
  - `IDEAL_POSTCODES_API_KEY`
  - `TURNSTILE_SECRET_KEY`
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_*` (when configured)
  - `RETENTION_CRON_SECRET`
  - `SEED_SECRET` (set during admin bootstrap, can be unset after)
  - `APP_BASE_URL`, `WEB_BASE_URL`
  - Auto-injected: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`
- **Supabase Vault** (`supabase_vault` extension) for secrets read by SQL (currently `retention_cron_secret` referenced by the pg_cron job).
- **GitHub Pages** — no secrets; the only exposed token is the public anon key embedded in client JS.
- **Local dev** — no secrets stored locally. Service-role key is never copied to a developer machine.

Rotation:

- **Quarterly** (or after suspected compromise) — rotate Resend, Stripe, Cloudflare R2, Turnstile keys.
- **Immediately on staff change** — rotate `RETENTION_CRON_SECRET` and `SEED_SECRET`.
- **Annually** — rotate Supabase JWT signing key (note: this invalidates all live sessions; schedule a maintenance window).

## 6. Incident response plan

See `data-protection-policy.md` Section 8 for the breach-response timeline. Technical reference:

| Step | Tool / action |
|---|---|
| Detect | Resend bounce reports; Supabase Edge Function logs; Stripe Radar; ICO complaint pings |
| Snapshot | `pg_dump` of audit_log around the suspected window; export Edge Function logs from Supabase Dashboard |
| Contain | `UPDATE landlord_subscriptions SET status='cancelled' WHERE …`; `auth.admin.deleteUser()`; rotate the relevant secret in Supabase + the third-party dashboard |
| Notify | Email Terry directly. If breach is high-risk, ICO online form within 72 hours |
| Recover | Re-issue any rotated keys to Edge Functions; re-deploy any affected EFs |
| Review | Add to `docs/internal/breaches/{date}-{slug}.md` with full timeline |

## 7. Penetration testing

- **Today:** No external pen test has been commissioned (single-landlord, pre-revenue platform).
- **Trigger for first pen test:** First non-Terry landlord onboarded, OR first commercial transaction processed via Stripe in live mode. Whichever comes first.
- **Cadence after that:** Annual, plus a focused re-test 6 months after a major architectural change.
- **Recommended providers:** Hacker One bug bounty, or a UK CHECK-accredited firm if budget allows.

Until a formal pen test is run:

- The `security-check` Edge Function performs basic automated checks (RLS, orphaned data, retention queue, audit recent writes, service-role-in-URLs sanity).
- Run it manually from the admin dashboard → Settings → "Run check" weekly.

## 8. Vulnerability disclosure

Security researchers are asked to email `privacy@easierlet.com` with the subject prefix `[security]`. We commit to:

- Acknowledging within 5 working days
- Triaging within 14 working days
- Crediting the researcher (if they wish) once the issue is resolved
- Not pursuing legal action against good-faith reporters

Out of scope: social engineering of EasierLet staff, physical attacks, denial-of-service.

## 9. Backup & disaster recovery

- **Database:** Supabase takes daily automated backups, retained for 7 days on the current plan. Point-in-time recovery is available within that window.
- **Storage:** Cloudflare R2 has built-in durability (11 9s). We don't take additional backups of stored documents.
- **Secrets:** Stored in Supabase Dashboard / Vault — recoverable by the project owner via Supabase support if locked out.
- **Code:** All in GitHub (`bluetezza/easierlet-swift`, `bluetezza/easierlet-web`, `bluetezza/easierlet-admin`).
- **DNS:** Registrar-side; we don't have a separate backup but DNS is straightforward to reconstruct from this document if needed.

**Recovery time objective (RTO):** 2 hours for a full reconstruction from backups assuming team is available.

**Recovery point objective (RPO):** Up to 24 hours of data loss (one daily backup cycle). Acceptable for current scale; revisit when first paying customer arrives.

## 10. Change log

- **2026-04-28** — Initial security policy. Covers Parts A–E of the audit/admin/privacy build.
