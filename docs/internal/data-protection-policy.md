# EasierLet — Data Protection Policy

**Owner:** Oakrise Estates Ltd (Company No. 16852456) trading as EasierLet
**Last reviewed:** 2026-04-28
**Review cadence:** Annual, or after any significant change to platform or law
**Contact:** privacy@easierlet.com

---

## 1. Scope

This policy covers all personal data processed by EasierLet — the SwiftUI iOS app, the website at easierlet.com (including landlord and tenant portals), the admin dashboard at admin.easierlet.com, and all backend services (Supabase, Cloudflare R2, Resend, Stripe).

It applies to:

- Landlord users (Oakrise Estates Ltd customers — currently only Terry Baldwin as the sole landlord)
- Tenant users (current and former tenants of any property managed in EasierLet)
- Prospective tenants (people who apply for or request a viewing of a property)
- Referees (employers, previous landlords, guarantors named on a tenancy reference)
- Admin users (Terry Baldwin and any future support staff)

**Roles under UK GDPR:**

- **Data controller** for landlord account data: Oakrise Estates Ltd (EasierLet). Landlords sign up with us and we decide how their account data is used.
- **Data controller** for tenant data: the **landlord** (Oakrise Estates Ltd in the current single-landlord configuration). Landlords decide which tenants they engage and what data they collect.
- **Data processor** for tenant data on behalf of landlords: EasierLet. We provide the tools but don't decide whose data is collected.

(When EasierLet onboards external landlord customers, the platform acts as **processor** for those landlords' tenants.)

## 2. Legal basis for processing

For each processing purpose:

| Purpose | Legal basis | Notes |
|---|---|---|
| Tenancy administration (creating tenant records, agreements, inventories) | Contract (Art. 6(1)(b)) | Necessary to deliver the tenancy agreement |
| Tenant referencing | Legitimate interest (Art. 6(1)(f)) + Consent | Tenants tick a consent box in the apply form |
| Right-to-Rent checks (nationality, visa) | Legal obligation (Art. 6(1)(c)) | Immigration Act 2014 |
| Gas Safety / EICR / EPC certificate retention | Legal obligation | Gas Safety (Installation and Use) Regulations 1998; Electrical Safety Standards Regulations 2020 |
| Transaction records (rent, expenses) | Legal obligation | HMRC requires 6-year tax record retention (Companies Act / ITA) |
| Maintenance request handling | Contract (delivery of repair obligations under the LTA 1985) | |
| Sending operational emails (visit notices, reference forms, payment confirmations) | Contract / Legitimate interest | |
| Marketing / sales communications | (Not currently used) | Would require fresh opt-in consent |
| Audit logging | Legitimate interest + Legal obligation | Compliance, security, dispute resolution |
| Subscription billing | Contract | Stripe is the processor |

## 3. Data inventory

The full column-level inventory is encoded as Postgres `COMMENT ON COLUMN` annotations in the `public` schema (categories: `PII:personal`, `PII:financial`, `PII:employment`, `PII:sensitive`, `PRIVATE:landlord`, `AUDIT:consent`).

To regenerate this list:

```sql
SELECT
  c.table_name,
  c.column_name,
  pgd.description
FROM information_schema.columns c
JOIN pg_catalog.pg_statio_all_tables st ON st.schemaname = c.table_schema AND st.relname = c.table_name
LEFT JOIN pg_catalog.pg_description pgd
  ON pgd.objoid = st.relid AND pgd.objsubid = c.ordinal_position
WHERE c.table_schema = 'public' AND pgd.description LIKE 'PII%'
ORDER BY c.table_name, c.column_name;
```

The `tenants` table has the highest density of personal data — names, contact details, DoB, nationality, employer, income, credit history, eviction history. The `tenant_references` table mirrors much of this. `landlord_profiles` holds landlord contact details. Other tables hold operational data (properties, transactions, documents, maintenance requests, viewing requests, property visits).

## 4. Access controls

| Role | Can see |
|---|---|
| **Landlord** (logged-in via JWT) | Their own landlord profile, all properties, tenants, documents, transactions, maintenance, agreements, inventories, visits, listings — gated by RLS `user_id = auth.uid()`. **Cannot see** other landlords' data, audit log, or admin user records. |
| **Tenant** (logged-in via JWT, `tenants.tenant_auth_id = auth.uid()`) | Their own tenant row, tenant references they submitted, documents shared with them on their property, maintenance requests they submitted, visits scheduled on their property. **Cannot see** the landlord's notes about them (`ranking_score`, `ranking_band`, `landlord_notes`, etc.), other tenants' data, or financial data about the property. |
| **Admin** (admin@easierlet.com via TOTP MFA) | Everything via the `admin-api` Edge Function, which checks `admin_users.is_active` and AAL2 before serving. Every read of landlord or tenant data is logged to `audit_log`. Sensitive PII (DoB, income, employer details, adverse credit) is **deliberately excluded** from admin views — only available via DSAR export. |
| **Anonymous web visitor** | Public listings (`property_listings.status = 'live'`), the public viewing-request and apply-v2 forms, the marketing pages. |
| **System** (Edge Functions running with `SUPABASE_SERVICE_ROLE_KEY`) | Everything. Used for reading data the user couldn't directly access (cross-table joins, sending emails, etc.). All system actions are also audit-logged. |

Row-level security (RLS) is enabled on every table in the `public` schema except `spatial_ref_sys` (PostGIS metadata). `audit_log` and `admin_users` have RLS enabled with **no user-visible policies** — service-role only.

## 5. Data retention schedule

The full schedule lives in the `retention_rules` table in Postgres. Summary:

| Data | Retention period | Legal basis |
|---|---|---|
| Active tenant data | 6 years after tenancy end | HMRC tax records + 6-year limitation period |
| Rejected applicant data | 6 months | Allow re-application; no ongoing legitimate interest |
| Tenant references | Same as tenant record | |
| Gas Safety certificates | 2 years (current + previous) | Industry practice |
| EICR certificates | 6 years | Replacement cycle + 1 year |
| EPC certificates | Lifetime of certificate (10 years) | Statutory validity |
| Viewing requests | 12 months | No ongoing need; anonymise prospect details |
| Transactions | 7 years | HMRC requirement |
| Audit logs | 7 years | Regulatory + dispute resolution |

Enforcement runs nightly via the `retention-enforce` Edge Function (cron `0 3 * * *`, scheduled by `pg_cron`).

## 6. Anonymisation procedure

When a tenant record reaches its retention deadline:

1. **30 days before** — automated email to the landlord listing the tenant and the planned anonymisation date. Landlord can defer (with a stated reason) or proceed.
2. **On the deadline** — the `retention-enforce` job clears every field listed in the `retention_rules.anonymise_fields` array (full name → "[REDACTED]", email → `[redacted-{id}]@redacted.local`, all PII fields → NULL).
3. **Auth account** — `supabase.auth.admin.deleteUser()` removes the tenant's login.
4. **Tenant references** — fields listed in the `tenant_reference` rule are cleared on related rows.
5. **Audit log** — `retention.anonymised` entry written with the list of cleared fields.
6. **Hard delete** — for rejected applicants only (`delete_after_anonymise = true`), the row is dropped after anonymisation. Active tenants keep an anonymised stub for tax/audit purposes.

## 7. DSAR (Data Subject Access Request) procedure

1. **Verify identity.** If the request comes via email, confirm with a reply-to address that matches what we hold. If we can't verify, reject and explain why.
2. **Generate the export.** Use the admin dashboard → DSAR page, or have the data subject self-serve via the tenant portal.
3. **Review for third-party data.** The export EF deliberately excludes landlord-only fields (ranking, internal notes), but the human reviewer must scan for any incidental third-party data before sending.
4. **Deliver within 30 days** of the request. Use the 24-hour signed URL the EF generates. Don't email the file as an attachment to anyone other than the data subject.
5. **Log the action.** `admin.dsar_generated` or `tenant.dsar_self_serve` is written automatically.

The export is a styled HTML report — the recipient uses Print → Save as PDF for a permanent copy.

## 8. Breach procedure

If we suspect personal data has been compromised:

1. **Within 1 hour** — assess scope. Which data, how many people, how it was exposed.
2. **Within 4 hours** — contain. Rotate any leaked secrets (Supabase service-role key, Stripe key, Resend key), revoke compromised sessions, lock the affected accounts.
3. **Within 72 hours** — if the breach is high risk to data subjects, notify the ICO at https://ico.org.uk/for-organisations/report-a-breach/.
4. **As soon as possible** — notify affected individuals if there's a high risk to their rights and freedoms. Plain English; avoid jargon.
5. **Document everything** — timeline, what was exposed, who was notified, what we changed. Add to the breach register kept under `docs/internal/breaches/` (create when needed).

## 9. Data processor agreements

We process data via these third-party providers. Each requires a Data Processing Agreement (DPA):

| Provider | Purpose | DPA status |
|---|---|---|
| **Supabase** (Inc., USA + EU regions) | Auth, Postgres, Edge Functions, Storage | DPA in place via Supabase ToS |
| **Cloudflare** (R2 storage) | Listing media + DSAR document hosting | DPA via Cloudflare ToS |
| **Resend** (transactional email) | All system emails | DPA via Resend ToS |
| **Stripe** (subscription billing) | Landlord billing | DPA via Stripe ToS |
| **Vorensys** (referencing — Phase 1 deep-link) | Tenant referencing | Sub-processor — review their DPA before scaling |

Annual review: confirm each DPA is current and that the provider's sub-processor list hasn't materially changed.

## 10. Staff training

Admin users must:

- Read this document before being granted admin access
- Re-read it annually or when a material update is published
- Read `admin-operations-manual.md` for day-to-day operations
- Know the breach procedure (Section 8) by heart

The owner (Terry Baldwin) maintains a record of admin onboarding and training in `docs/internal/training-log.md` (create when first non-owner admin is added).

## 11. Review schedule

This policy is reviewed:

- **Annually** — every April, around the start of the financial year
- **After significant change** — material new feature, change in third-party processor, change in UK GDPR / ICO guidance
- **After incident** — any breach or near-miss triggers a review of Section 8

The review log lives at the bottom of this file:

### Review history

- **2026-04-28** — Initial policy. Author: Terry Baldwin via EasierLet platform automation.
