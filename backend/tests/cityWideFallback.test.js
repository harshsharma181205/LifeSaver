const { test } = require('node:test');
const assert = require('node:assert/strict');
const { coverage, ensureFallback } = require('../services/cityWideDonorFallback');

const request = overrides => ({ request_id: 10, workflow_version: 2, recipient_id: 30,
  admission_hospital_id: 40, state: 'Uttarakhand', city: 'Dehradun', blood_group: 'A+',
  units_required: 7, status: 'Pending', donor_matching_started_at: null, ...overrides });
const progress = remaining => ({ remaining_units: remaining, fulfilled_units: 7 - remaining,
  inventory_units: 7 - remaining, donation_units: 0 });
const bank = (bankId, units, overrides = {}) => ({ bank_id: bankId, organization_id: bankId + 100,
  organization_type: 'Blood Bank', state: 'Uttarakhand', city: 'Dehradun', inventory_id: units === null ? null : bankId + 200,
  blood_group: units === null ? null : 'A+', units_available: units, ...overrides });
const donor = (donorId, overrides = {}) => ({ donor_id: donorId, name: 'Eligible donor ' + donorId,
  blood_group: 'A+', state: 'Uttarakhand', city: 'Dehradun', is_available: 1,
  response: null, screening_result: null, phone: 'PRIVATE_PHONE', email: 'PRIVATE_EMAIL',
  password_hash: 'PRIVATE_HASH', ...overrides });

function fixture(options = {}) {
  const state = { banks: options.banks ?? [bank(1, 0)], donors: options.donors ?? [donor(1)],
    queries: [], notifications: [], matching: false, failNotifications: false };
  const executor = { execute: async (sql, values = []) => {
    state.queries.push({ sql, values });
    if (sql.startsWith('SELECT b.bank_id') && sql.includes('LEFT JOIN blood_inventory i')) {
      assert.ok(sql.includes('JOIN organizations o'));
      assert.ok(values.includes('A+'), 'The city coverage query must constrain stock by the requested blood group.');
      return [state.banks.map(row => ({ ...row }))];
    }
    if (sql.startsWith('SELECT b.bank_id, o.organization_id, o.state')) {
      return [state.banks.map(row => ({ ...row }))];
    }
    if (sql.startsWith('UPDATE blood_requests SET donor_matching')) {
      assert.ok(sql.includes('COALESCE('), 'The initial donor matching timestamp must be preserved.');
      assert.deepEqual(values, [10]); state.matching = true; return [{ affectedRows: 1 }];
    }
    if (sql.startsWith('SELECT d.donor_id')) {
      assert.ok(sql.includes('LEFT JOIN donor_responses'));
      assert.ok(sql.includes('d.blood_group = ?') && sql.includes('d.is_available = 1'));
      assert.deepEqual(values, [10, 'A+', 'Accepted', 'Failed']);
      // These are database predicates; geography is checked by JavaScript after this query.
      return [state.donors.filter(row => row.blood_group === values[1] && row.is_available === 1 &&
        (!row.response || row.response === values[2]) && (!row.screening_result || row.screening_result !== values[3]))];
    }
    if (sql.startsWith('INSERT INTO workflow_notifications')) {
      if (state.failNotifications) throw new Error('Private notification failure');
      assert.ok(sql.includes('ON DUPLICATE KEY UPDATE'));
      let notification = state.notifications.find(row => row.type === values[0] && row.id === values[1] && row.event === values[3]);
      if (!notification) {
        notification = { type: values[0], id: values[1], request: values[2], event: values[3], message: values[4] };
        state.notifications.push(notification);
      }
      return [{ insertId: state.notifications.indexOf(notification) + 1 }];
    }
    throw new Error('Unexpected fallback SQL: ' + sql);
  } };
  return { state, executor };
}

function donorNotices(state) { return state.notifications.filter(row => row.type === 'donor'); }
function onlyReadOrFallbackWrites(state) {
  for (const { sql } of state.queries) assert.ok(sql.startsWith('SELECT ') ||
    sql.startsWith('UPDATE blood_requests SET donor_matching') || sql.startsWith('INSERT INTO workflow_notifications'), sql);
}

test('zero stock automatically starts city-compatible donor fallback for all remaining units', async () => {
  const { state, executor } = fixture();
  const result = await ensureFallback(executor, request(), progress(7));
  assert.equal(result.donor_units_needed, 7); assert.equal(result.inventory_coverage_units, 0);
  assert.equal(result.collecting_bank_count, 1); assert.equal(result.matched_count, 1);
  assert.equal(result.notified_count, 1); assert.equal(state.matching, true);
  assert.equal(donorNotices(state).length, 1); assert.equal(donorNotices(state)[0].id, 1);
  onlyReadOrFallbackWrites(state);
});

test('partial coverage sums eligible banks and falls back for only the uncovered remainder', async () => {
  const { state, executor } = fixture({ banks: [bank(1, 2), bank(2, 1)] });
  const result = await ensureFallback(executor, request(), progress(5));
  assert.equal(result.inventory_coverage_units, 3); assert.equal(result.donor_units_needed, 2);
  assert.equal(result.collecting_bank_count, 2); assert.equal(state.matching, true);
  assert.deepEqual(state.banks.map(row => row.units_available), [2, 1]);
});

test('coverage uses ledger remaining units instead of the original requested quantity', async () => {
  const { executor } = fixture({ banks: [bank(1, 2)] });
  assert.equal((await coverage(executor, request(), progress(3))).donor_units_needed, 1);
});

test('sufficient combined bank stock does not trigger fallback even if the first bank is empty', async () => {
  const { state, executor } = fixture({ banks: [bank(1, 0), bank(2, 7)] });
  const result = await ensureFallback(executor, request(), progress(7));
  assert.equal(result.donor_units_needed, 0); assert.equal(result.inventory_coverage_units, 7);
  assert.equal(state.matching, false); assert.equal(state.notifications.length, 0);
  onlyReadOrFallbackWrites(state);
});

test('coverage is capped at current remaining units without consuming stock', async () => {
  const { state, executor } = fixture({ banks: [bank(1, 100), bank(2, 100)] });
  const result = await coverage(executor, request(), progress(2));
  assert.equal(result.donor_units_needed, 0); assert.equal(result.inventory_coverage_units, 2);
  assert.deepEqual(state.banks.map(row => row.units_available), [100, 100]);
  assert.ok(state.queries.every(row => row.sql.startsWith('SELECT ')));
});

test('other city or state stock does not cover the local request', async () => {
  const { executor } = fixture({ banks: [bank(1, 1), bank(2, 100, { city: 'Rishikesh' }),
    bank(3, 100, { state: 'Haryana' })] });
  const result = await coverage(executor, request(), progress(7));
  assert.equal(result.inventory_coverage_units, 1); assert.equal(result.donor_units_needed, 6);
  assert.equal(result.collecting_bank_count, 1);
});

test('state and city normalization preserve same-city fallback eligibility', async () => {
  const { executor } = fixture({ banks: [bank(1, 2, { city: '  DEHRADUN  ', state: ' uttarakhand ' })],
    donors: [donor(1, { city: ' dehradun ', state: 'UTTARAKHAND' })] });
  const result = await ensureFallback(executor, request(), progress(7));
  assert.equal(result.donor_units_needed, 5); assert.equal(result.matched_count, 1);
});

test('bank without matching inventory remains a designated collection option', async () => {
  const { executor } = fixture({ banks: [bank(1, null)] });
  const result = await ensureFallback(executor, request(), progress(7));
  assert.equal(result.inventory_coverage_units, 0); assert.equal(result.collecting_bank_count, 1);
  assert.equal(result.donor_units_needed, 7); assert.equal(result.matched_count, 1);
});

test('wrong-group stock is never counted toward coverage', async () => {
  const { executor } = fixture({ banks: [bank(1, 100, { blood_group: 'B+' }), bank(2, 1)] });
  const result = await coverage(executor, request(), progress(7));
  assert.equal(result.inventory_coverage_units, 1); assert.equal(result.donor_units_needed, 6);
});

test('Hospital and unlinked provider rows cannot provide city inventory or collect donors', async () => {
  const { executor } = fixture({ banks: [bank(1, 1), bank(2, 100, { organization_type: 'Hospital' }),
    bank(3, 100, { organization_id: null })] });
  const result = await coverage(executor, request(), progress(7));
  assert.equal(result.inventory_coverage_units, 1); assert.equal(result.collecting_bank_count, 1);
});

for (const units of [-1, 1.5, '3']) {
  test('invalid local stock quantity fails closed: ' + units, async () => {
    const { executor } = fixture({ banks: [bank(1, units)] });
    await assert.rejects(ensureFallback(executor, request(), progress(7)), error => error.status === 409);
  });
}

test('duplicate inventory rows for one eligible bank fail closed', async () => {
  const { state, executor } = fixture({ banks: [bank(1, 2), bank(1, 3, { inventory_id: 999 })] });
  await assert.rejects(ensureFallback(executor, request(), progress(7)), error => error.status === 409);
  assert.equal(state.matching, false); assert.equal(state.notifications.length, 0);
});

for (const [label, changes] of [['wrong city', { city: 'Rishikesh' }], ['wrong state', { state: 'Haryana' }],
  ['wrong group', { blood_group: 'B+' }], ['unavailable', { is_available: 0 }],
  ['declined', { response: 'Declined' }], ['failed screening', { response: 'Accepted', screening_result: 'Failed' }]]) {
  test(label + ' donor is neither exposed nor notified', async () => {
    const { state, executor } = fixture({ donors: [donor(1), donor(2, changes)] });
    const result = await ensureFallback(executor, request(), progress(7));
    assert.deepEqual(result.donors.map(row => row.donor_id), [1]);
    assert.deepEqual(donorNotices(state).map(row => row.id), [1]);
  });
}

test('accepted eligible donor remains a match without another invitation', async () => {
  const { state, executor } = fixture({ donors: [donor(1, { response: 'Accepted', screening_result: 'Passed' })] });
  const result = await ensureFallback(executor, request(), progress(7));
  assert.equal(result.matched_count, 1); assert.equal(result.notified_count, 0);
  assert.equal(donorNotices(state).length, 0);
});

test('fallback responses and messages omit private donor details', async () => {
  const { state, executor } = fixture();
  const result = await ensureFallback(executor, request(), progress(7));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|phone|email|password/i);
  assert.doesNotMatch(JSON.stringify(state.notifications), /PRIVATE_/);
});

test('repeated fallback keeps one invitation and one matching event per audience', async () => {
  const { state, executor } = fixture();
  await ensureFallback(executor, request(), progress(7));
  const before = structuredClone(state.notifications);
  await ensureFallback(executor, request(), progress(7));
  assert.deepEqual(state.notifications, before);
  assert.equal(donorNotices(state).length, 1);
  assert.equal(donorNotices(state)[0].event, 'request:10:match-donor:1');
});

test('no eligible collecting bank means no unusable donor invitations', async () => {
  const { state, executor } = fixture({ banks: [bank(1, 0, { city: 'Rishikesh' })] });
  const result = await ensureFallback(executor, request(), progress(7));
  assert.equal(result.collecting_bank_count, 0); assert.equal(state.matching, false);
  assert.equal(state.notifications.length, 0);
});

for (const status of ['Fulfilled', 'Cancelled']) {
  test(status + ' request never starts fallback', async () => {
    const { state, executor } = fixture();
    await ensureFallback(executor, request({ status }), progress(status === 'Fulfilled' ? 0 : 7));
    assert.equal(state.matching, false); assert.equal(state.notifications.length, 0);
    onlyReadOrFallbackWrites(state);
  });
}

test('zero remaining units stop unnecessary fallback before status repair', async () => {
  const { state, executor } = fixture();
  await ensureFallback(executor, request({ status: 'Processing' }), progress(0));
  assert.equal(state.matching, false); assert.equal(state.notifications.length, 0);
});

for (const workflow_version of [undefined, 1]) {
  test('V1 workflow ' + workflow_version + ' is preserved without donor fallback mutations', async () => {
    const { state, executor } = fixture();
    await ensureFallback(executor, request({ workflow_version }), progress(7));
    assert.equal(state.matching, false); assert.equal(state.notifications.length, 0);
    onlyReadOrFallbackWrites(state);
  });
}

test('read-only coverage never starts matching or emits notifications', async () => {
  const { state, executor } = fixture();
  const result = await coverage(executor, request(), progress(7));
  assert.equal(result.donor_units_needed, 7); assert.equal(state.matching, false);
  assert.ok(state.queries.every(row => row.sql.startsWith('SELECT ')));
});

test('fallback never changes fulfillment, donations, inventory, clinical status or transaction ownership', async () => {
  const { state, executor } = fixture();
  const currentRequest = request(), currentProgress = progress(7);
  const before = JSON.stringify({ currentRequest, currentProgress, banks: state.banks });
  await ensureFallback(executor, currentRequest, currentProgress, { collectingBankId: 1 });
  assert.equal(JSON.stringify({ currentRequest, currentProgress, banks: state.banks }), before);
  onlyReadOrFallbackWrites(state);
  assert.ok(!state.queries.some(row => /FOR UPDATE|FOR SHARE|START TRANSACTION|COMMIT|ROLLBACK/.test(row.sql)));
});

test('notification failure propagates so the caller can roll back fallback and clinical writes together', async () => {
  const { state, executor } = fixture();
  const saved = { matching: state.matching, notifications: structuredClone(state.notifications) };
  state.failNotifications = true;
  await assert.rejects(ensureFallback(executor, request(), progress(7)), /Private notification failure/);
  // Helper owns no transaction; a caller rollback restores its marker and notices atomically.
  state.matching = saved.matching; state.notifications = saved.notifications;
  assert.equal(state.matching, false); assert.equal(state.notifications.length, 0);
  assert.ok(!state.queries.some(row => /COMMIT|ROLLBACK/.test(row.sql)));
});
