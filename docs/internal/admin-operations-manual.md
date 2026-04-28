# EasierLet — Admin Operations Manual

**Audience:** Anyone with an `admin_users` row.
**Last reviewed:** 2026-04-28

This is the day-to-day playbook for running the admin dashboard at https://admin.easierlet.com. Read `data-protection-policy.md` first.

---

## 1. Logging in

1. Go to https://admin.easierlet.com.
2. Sign in with your admin email + password.
3. **First time only:** scan the QR code with Microsoft Authenticator (or any TOTP app) and enter the 6-digit code to confirm enrolment.
4. Subsequent logins: enter the 6-digit code from your authenticator after the password.
5. Sessions expire on browser close (no persistent login). Sign out via the header button when you finish.

If you lose access to your authenticator: there is currently no self-serve recovery — another `owner`-role admin removes your factor in Supabase Dashboard → Authentication → Users → find your account → "MFA Factors" → revoke. You can then re-enroll on next sign-in. Document who recovered for whom and why.

## 2. Looking up a landlord

- **Dashboard search bar** — name, email, or company name (case-insensitive partial match).
- Each result links to the landlord detail page.
- The detail page shows profile, subscription, properties, tenants (names + status only), document compliance, recent activity. Sensitive tenant fields (DoB, income, employer, adverse credit) are deliberately not surfaced — they're only available via DSAR.

## 3. Extending a trial

On the landlord detail page → Subscription card:

- "Extend trial 14 days" or "Extend trial 30 days" — pushes `trial_ends_at` out by that many days from the current value (or now if expired).
- Action is logged as `admin.action` with `description: "extend_trial 14d"`.
- If you need to grant an unusual extension (e.g. 90 days for a paid pilot), use the SQL editor:
  ```sql
  UPDATE landlord_subscriptions
  SET trial_ends_at = now() + interval '90 days', status = 'trialing'
  WHERE user_id = 'LANDLORD_USER_ID';
  ```
  and audit-log it manually:
  ```sql
  SELECT log_audit('YOUR_ADMIN_ID', 'admin', 'admin.action', 'subscription', 'LANDLORD_USER_ID', '{"description":"extend_trial 90d for paid pilot"}'::jsonb, NULL, NULL);
  ```

## 4. Resending a failed email

- Check Resend logs first: https://resend.com/emails — search by recipient.
- If genuinely failed, the action button is on the landlord detail page (resend welcome) or on the relevant resource (e.g. a viewing detail in the landlord portal lets the landlord re-send the proposed-time email).
- For one-offs without a UI, use the relevant Edge Function directly:
  - Welcome email: re-call `landlord-signup` is **not** the right move (it would create a duplicate account). Instead, call `auth.admin.generateLink` to send a magic link.
  - Maintenance status email: call `maintenance-notify` with the right action.
  - Visit notice: call `visit-notify` with `send_update`.

## 5. Handling a DSAR (Data Subject Access Request)

Step-by-step. **Verify identity first.**

1. **Receive the request.** Usually email to `privacy@easierlet.com`.
2. **Verify** the requester. Match the email to a landlord_profile / tenant. If they ask in writing that doesn't match what we hold, request alternate verification (e.g. confirm a piece of data only they would know).
3. **Generate the export.** Admin dashboard → DSAR page → search by email → pick → "Generate PDF". The signed URL expires in 24 hours.
4. **Review.** Open the link, scan for any third-party data (e.g. a referee's contact details on a tenant DSAR). Remove if necessary by editing the underlying record and regenerating.
5. **Deliver.** Reply to the original email with the link. Don't email the file as an attachment unless the recipient explicitly asks for it (URLs are safer).
6. **Log.** Already happens automatically (`admin.dsar_generated`).
7. **Deadline.** UK GDPR allows 30 days. We aim for under 7 days.

Tenants can also self-serve from the iOS portal (Profile menu → "Download My Data"). Those are logged as `tenant.dsar_self_serve`.

## 6. Handling a deletion request

1. **Verify identity.**
2. **Confirm scope.** "Right to erasure" doesn't override our legal obligation to keep tenancy + financial records for tax and legal limitation periods. We can anonymise personal identifiers but tenancy timelines must remain.
3. **Tenants:** they can self-serve via the iOS portal (Profile menu → "Delete My Account"), which calls `tenant-delete-account`. The EF anonymises and deletes the auth account; the landlord is emailed.
4. **Landlords:** there's no self-serve flow yet. Manually:
   - Use `supabase.auth.admin.deleteUser(LANDLORD_USER_ID)`.
   - Their `landlord_profiles`, `landlord_subscriptions`, properties, tenants, etc. cascade-delete via FK constraints (where they exist) — verify before pulling the trigger.
   - Audit `auth.account_deleted` with `metadata.initiator: "admin"` and the requester's email.
5. **Document the request and outcome** in `docs/internal/dsar-log.md` (create when needed).

## 7. Handling a data breach

See `data-protection-policy.md` Section 8 for the full procedure.

Quick reference for the first hour:

1. **Stop the bleed.** Rotate the leaked secret. If unsure which secret, rotate them all (Supabase service-role, Stripe, Resend).
2. **Snapshot evidence.** Screenshot the Edge Function log, the audit log entries around the time of compromise.
3. **Tell Terry.** Phone, not email.
4. **Then start the formal procedure.**

## 8. Managing retention overrides

Admin → Retention page lists tenants whose data is scheduled to be anonymised in the next 30 days, plus anything that's already overdue.

- **Defer 30 days** — pushes `retention_deferred_until` forward and clears the warning timestamp so the warning email is re-sent. Use when there's an active dispute or pending refund.
- **Force anonymise** — sets `retention_expires_at = now()`; the next nightly run will process it. Use when a tenant has formally requested erasure mid-cycle.

Both actions are audit-logged with `admin.retention_override` and the override type.

## 9. Adding / removing admin users

Currently `owner`-only. To add a `support` admin:

1. **Have them create a Supabase auth account.** Either via Supabase Dashboard → Authentication → Add user, or via the seed-admin EF (one-shot, requires `SEED_SECRET`).
2. **Insert the admin_users row:**
   ```sql
   INSERT INTO admin_users (auth_id, name, email, role, is_active)
   VALUES ('THEIR_AUTH_ID', 'Their Name', 'their-email@easierlet.com', 'support', true);
   ```
3. **Send them this manual + the data protection policy.** They must read both before first login.
4. **They sign in** at admin.easierlet.com, are prompted to enrol MFA, scan the QR, confirm, and are in.

To revoke access:
```sql
UPDATE admin_users SET is_active = false WHERE id = 'ADMIN_ID';
```
Their session keeps working until expiry; for immediate effect, also delete their MFA factor in Supabase Dashboard.

## 10. Reading the audit log

Admin → Audit log page. Filterable by:

- Actor type / actor user ID
- Resource type / resource ID
- Action (supports `%` wildcards — e.g. `tenant.%` matches all tenant actions)
- Date range

Each row expandable to show full metadata JSON + IP + user agent.

CSV export is available for any filtered view.

The catalogue of all action strings lives in `PROJECT_LOG.md` under "Audit catalogue".

## 11. Escalation

- **Technical (platform broken):** Terry Baldwin first.
- **Privacy / legal (DSAR, breach, ICO contact):** Terry Baldwin + write everything down.
- **Billing (Stripe, customer payment dispute):** Terry first; engage Stripe support if it's a Stripe-side issue (https://support.stripe.com).
- **Account fraud / abuse:** Disable the account immediately (`admin_users.is_active = false` for admin abuse, `landlord_subscriptions.status = 'cancelled'` for landlord abuse), then investigate.
