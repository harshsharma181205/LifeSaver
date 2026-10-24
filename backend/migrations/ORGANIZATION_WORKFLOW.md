# Organization and clinical workflow migration

The previous blood-bank integration remains part of the schema. This phase adds a separate organization account table and retains every existing bank ID, inventory relationship, donor, donation, request, notification and allocation.

Inspected database: blood_management, MySQL, InnoDB. Existing inventory is unique by bank/blood group and checks nonnegative units. Allocations currently require a real donation; the new inventory source is added explicitly.

## Review and execution

From backend, first review the read-only plan:

    node migrations/organizationWorkflow.js --plan

After a verified database backup and authorization, apply the reviewed plan:

    node migrations/organizationWorkflow.js --apply

The CLI requires DB_NAME=blood_management. No schema changes run automatically when the server starts. The migration checks existing table engines, column types, foreign keys, unique indexes, allocation sources and duplicate account identifiers before issuing DDL. Duplicate phone/email identifiers stop execution for manual review. No account is deleted, merged or invented.

MySQL DDL commits implicitly, so schema changes cannot be rolled back as one transaction. The script checks for already-added fields, keys and constraints on rerun. Existing bank account copies and mappings are handled together in one transaction after the additive DDL.

## Exact schema changes

- Creates organizations: signed INT organization_id primary key/auto increment; organization_type enum Hospital/Blood Bank/NGO; name VARCHAR(100); state/city nullable VARCHAR(100); address VARCHAR(255); nullable phone VARCHAR(15), email VARCHAR(100), password_hash VARCHAR(255); created_at TIMESTAMP. Phone and email have unique indexes. New API registrations require state, city, address, phone, email and a valid password. Nullable fields preserve genuine legacy records.
- Adds blood_banks.organization_id nullable signed INT, unique index and foreign key to organizations.
- Adds donors.state/city nullable VARCHAR(100). Existing free-text location values are retained without guessing their state or city.
- Adds blood_requests.organization_id nullable signed INT foreign key to organizations and state/city nullable VARCHAR(100) snapshots. Historical request fields stay NULL; no provider or location is fabricated.
- Adds donor_responses.screening_result nullable Passed/Failed enum, screened_at nullable TIMESTAMP and screened_by_organization_id nullable signed INT foreign key to organizations. Adds chk_screening_consistency requiring all screening metadata to be NULL or an Accepted response with complete metadata.
- Adds blood_inventory.version BIGINT UNSIGNED NOT NULL DEFAULT 0 for stale-edit protection.
- Makes request_allocations.donation_id nullable; adds inventory_id nullable signed INT foreign key to blood_inventory and operation_key nullable VARCHAR(64), unique by request_id/operation_key. Adds chk_allocation_one_source enforcing exactly one real donation or inventory source.
- Adds unique recipients.phone and recipients.email indexes after duplicate checks. Donor and recipient accounts remain separate.

A legacy blood bank is copied with its genuine name, address, phone, email, password hash and creation timestamp into one Blood Bank organization. Its existing blood_banks row is linked through organization_id; all original columns and IDs remain unchanged. Unknown state/city remain NULL until the account supplies them. Existing fulfilled requests without allocation history remain exactly as recorded.

New Hospital/Blood Bank registrations create a single operational blood_banks companion in the same transaction. This keeps established bank foreign keys explainable and compatible. NGO registration creates no clinical provider companion. Database-backed permissions distinguish organization type; Hospital staff can screen/confirm donations for their requests, and Blood Bank staff manage inventory. A Hospital account does not receive blood bank stock-edit permission merely because it has a companion row.

## API additions and compatibility

- POST /api/organizations registers a real organization.
- GET /api/organizations/states supplies the canonical Indian state/Union Territory list.
- GET /api/organizations/cities?state=... returns only cities having registered clinical providers.
- GET /api/organizations?state=...&city=... returns registered Hospital/Blood Bank provider records with a linked bank; NGO and accounts without completed location are excluded.
- PUT /api/organizations/me/location completes/updates the authenticated organization location. Existing request snapshots are untouched. Legacy blood_bank JWTs can update their mapped organization.
- POST /api/auth/organization/login accepts identifier (phone or email) plus password and returns an organization JWT/profile.
- Existing donor/recipient login URLs accept identifier or the original phone payload. Email payloads also work.
- Existing blood-bank login and blood_bank JWTs remain valid. GET /api/auth/me reads organization type/location from the database and exposes only safe account fields.

Canonical state names use Delhi, Jammu and Kashmir, Ladakh and Dadra and Nagar Haveli and Daman and Diu. Cities are trimmed, repeated whitespace collapsed and matched without case differences; city options come from registered organizations. Source for the 28 states/8 Union Territories: https://www.india.gov.in/explore-india/odop

Password storage remains the project's salted scrypt:<32-hex-salt>:<128-hex-key> format; JWT identity remains user_id/user_type. Organization authorization resolves current database rows instead of trusting a type supplied by the client or adding it to tokens.

## Recovery and operational limits

Take a backup before applying schema changes. Keep the new nullable columns/table if reverting application code: old bank relationships and credentials remain compatible, but removing organization rows once referenced would lose genuine new accounts. Do not drop referenced organization/allocation fields or delete historical records as a rollback shortcut.

Original admin dashboard/reporting endpoints are retained. Existing admin authentication limitations require a separate design; this phase does not create a new admin login or silently change that contract.
