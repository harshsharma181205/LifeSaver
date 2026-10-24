# Blood-bank integration

Run the inspected, repeatable migration from backend:

```
node migrations/bloodBankIntegration.js
```

It adds only missing schema fields and foreign keys. It never inserts, updates, assigns, deletes, or resets existing records.

- blood_banks.password_hash: compatible salted scrypt credential, nullable for existing banks. A bank without a credential cannot log in.
- blood_requests.bank_id: selected bank foreign key. The live database had one legacy request and no banks, so this column remains nullable to preserve that request without inventing an assignment. Every new API request requires an existing selected bank. Legacy requests show ?Not assigned? and cannot be processed by a bank.
- blood_requests.donor_matching_started_at: records a genuine insufficient-stock processing attempt. Creating a request alone never activates donor matching.
- donor_responses: request/donor primary key, Accepted or Declined response, and response timestamp. request_allocations requires an actual donation_id, so it cannot safely represent screening agreement.

No blood-bank registration or credential provisioning endpoint is added. A real bank account with a server-generated scrypt:<salt>:<hex key> credential must be provisioned before live bank login. Use the existing 16-byte random salt and 64-byte scrypt key format; never store a plain password.

Processing locks the owned request and selected bank/group inventory in one transaction. Enough stock fulfills exactly the requested units. Insufficient stock preserves stock and Pending status, records the marker, and saves only matched donors' internal notifications. Repeated processing does not duplicate invitations. Accept/Decline does not record donations, change inventory, or fulfill requests.

The automated suites use in-memory SQL fixtures; they never create live test users, inventory, requests, donations, or responses. Keep actual donation and medical screening in the established future workflow.
