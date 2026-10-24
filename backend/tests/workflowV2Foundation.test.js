const test = require('node:test');
const assert = require('node:assert/strict');
const policy = require('../services/requestAccessPolicy');
const config = require('../services/workflowV2Config');
const notifications = require('../services/workflowV2Notifications');

const request = (overrides = {}) => ({ request_id: 70, workflow_version: 2, recipient_id: 9, admission_hospital_id: 11,
  state: 'Uttarakhand', city: 'Dehradun', status: 'Pending', ...overrides });
const bank = (overrides = {}) => ({ organization_type: 'Blood Bank', organization_id: 20, bank_id: 7,
  state: ' Uttarakhand ', city: 'DEHRADUN', ...overrides });
const actor = provider => ({ user_type: 'organization', user_id: provider.organization_id, provider });

for (const [name, value, expected] of [
  ['case and whitespace', '  DEHRA  DUN ', 'dehra dun'], ['unicode NFC', 'Cafe\u0301', 'café'],
  ['missing', undefined, ''], ['invalid type', 123, ''], ['blank', ' \t ', ''],
]) test('normalization: ' + name, () => assert.equal(policy.normalizeLocation(value), expected));




test('same-location compares both normalized keys', () => {
  assert.equal(policy.sameLocation(request(), bank()), true);
  assert.equal(policy.sameLocation(request(), bank({ state: 'Delhi' })), false);
  assert.equal(policy.sameLocation(request(), bank({ city: 'Other' })), false);
  assert.equal(policy.sameLocation({}, {}), false);
  assert.equal(policy.sameLocation({ state: 'A', city: 'Cafe\u0301' }, { state: 'a', city: 'Café' }), true);
  assert.equal(policy.sameLocation({ state: 'A', city: 'Cafe' }, { state: 'a', city: 'Café' }), false);
});


for (const type of ['Hospital', 'NGO', 'Admin', null]) test('cannot supply as ' + type, () => assert.equal(policy.canSupply(bank({ organization_type: type }), request()), false));
for (const changes of [{ bank_id: null }, { organization_id: null }, { city: 'Other' }, { state: null }, { bank_id: -1 }]) {
  test('ineligible bank ' + JSON.stringify(changes), () => assert.equal(policy.canSupply(bank(changes), request()), false));
}
for (const status of ['Cancelled', 'Fulfilled', null]) test('closed status ' + status + ' blocks fresh supply but permits authorized replay check', () => {
  assert.equal(policy.canSupply(bank(), request({ status })), false);
  assert.equal(policy.canSupply(bank(), request({ status }), { allowClosedReplay: true }), true);
  assert.equal(policy.canSupply(bank({ city: 'Other' }), request({ status }), { allowClosedReplay: true }), false);
});
test('V1 selected-bank supply compatibility without organization link', () => {
  const provider = bank({ organization_id: null });
  assert.equal(policy.canSupply(provider, request({ workflow_version: 1, bank_id: 7 })), true);
  assert.equal(policy.canSupply(provider, request({ workflow_version: 1, bank_id: 8 })), false);
});
test('requireSupply fails with safe 403', () => {
  assert.throws(() => policy.requireSupply(bank({ city: 'Other' }), request()), error => error.status === 403);
  assert.doesNotThrow(() => policy.requireSupply(bank(), request({ status: 'Fulfilled' }), { allowClosedReplay: true }));
});
test('recipient owns only its requests', () => {
  assert.equal(policy.canView(request(), { user_type: 'recipient', user_id: 9 }), true);
  assert.equal(policy.canView(request(), { user_type: 'recipient', user_id: 10 }), false);
});
test('admission Hospital sees only its patients even after closure', () => {
  const hospital = bank({ organization_type: 'Hospital', organization_id: 11 });
  assert.equal(policy.canView(request({ status: 'Fulfilled' }), actor(hospital)), true);
  assert.equal(policy.canView(request({ admission_hospital_id: 99 }), actor(hospital)), false);
});
test('open bank visibility city-wide, closed history requires verified contribution', () => {
  assert.equal(policy.canView(request({ bank_id: 99 }), actor(bank())), true);
  assert.equal(policy.canView(request({ status: 'Fulfilled' }), actor(bank())), false);
  assert.equal(policy.canView(request({ status: 'Fulfilled' }), actor(bank()), { hasOwnContribution: true }), true);
  assert.equal(policy.canView(request(), actor(bank({ city: 'Other' }))), false);
  assert.equal(policy.canView(request({ status: 'Cancelled' }), actor(bank({ city: 'Other' })), { hasOwnContribution: true }), true);
});
test('actor cannot substitute another resolved provider', () => {
  assert.equal(policy.canView(request(), { ...actor(bank()), user_id: 99 }), false);
  assert.equal(policy.canView(request(), { user_type: 'blood_bank', user_id: 99, provider: bank() }), false);
});
for (const type of ['donor', 'admin', 'NGO', undefined]) test('request-view role denied ' + type, () => {
  assert.equal(policy.canView(request(), { user_type: type, user_id: 20, provider: bank() }), false);
});
test('unknown workflow does not inherit legacy permissions', () => {
  assert.equal(policy.canView(request({ workflow_version: 3, bank_id: 7 }), actor(bank())), false);
  assert.equal(policy.canSupply(bank(), request({ workflow_version: 3, bank_id: 7 })), false);
});
test('legacy view remains selected provider, including historical Hospital companion', () => {
  const hospital = bank({ organization_type: 'Hospital', organization_id: 11 });
  assert.equal(policy.canView(request({ workflow_version: 1, bank_id: 7 }), actor(hospital)), true);
  assert.equal(policy.canView(request({ workflow_version: 1, bank_id: 8 }), actor(hospital)), false);
});

const previous = process.env.LIFESAVER_WORKFLOW_V2;
test.after(() => { if (previous === undefined) delete process.env.LIFESAVER_WORKFLOW_V2; else process.env.LIFESAVER_WORKFLOW_V2 = previous; });
const completeColumns = () => Object.entries(config.requiredColumns).flatMap(([TABLE_NAME, names]) => names.map(COLUMN_NAME => ({ TABLE_NAME, COLUMN_NAME })));
test('activation disabled by default and no readiness SQL executed', async () => {
  delete process.env.LIFESAVER_WORKFLOW_V2;
  let calls = 0;
  await assert.rejects(config.assertReady({ execute: async () => { calls++; } }), error => error.status === 503);
  assert.equal(calls, 0);
});
for (const value of ['TRUE', '1', 'yes', 'false']) test('activation rejects nonliteral true ' + value, () => {
  process.env.LIFESAVER_WORKFLOW_V2 = value;
  assert.equal(config.isEnabled(), false);
});
test('enabled complete schema plus version marker is ready; no readiness cache', async () => {
  process.env.LIFESAVER_WORKFLOW_V2 = 'true';
  let calls = 0;
  const executor = { execute: async sql => { calls++; return sql.includes('INFORMATION_SCHEMA') ? [completeColumns()] : [[{ version: 2 }]]; } };
  await config.assertReady(executor); await config.assertReady(executor);
  assert.equal(calls, 4);
});
test('missing column/marker and driver error all fail closed without SQL disclosure', async () => {
  process.env.LIFESAVER_WORKFLOW_V2 = 'true';
  for (const execute of [async () => [completeColumns().slice(1)], async sql => sql.includes('INFORMATION_SCHEMA') ? [completeColumns()] : [[]],
    async () => { throw new Error('private password SQL detail'); }]) {
    await assert.rejects(config.assertReady({ execute }), error => error.status === 503 && !/password|SQL/.test(error.message));
  }
});

function notificationExecutor() {
  const records = [];
  const executor = { execute: async (sql, values) => {
    if (sql.startsWith('SELECT')) return [[bank(), bank({ bank_id: 8, organization_id: 21 }),
      bank({ bank_id: 9, organization_id: 22, city: 'Other' }), bank()]];
    assert.ok(sql.startsWith('INSERT INTO workflow_notifications'));
    assert.ok(sql.includes('ON DUPLICATE KEY UPDATE'));
    assert.equal(values.length, 5);
    if (!records.some(row => row[0] === values[0] && row[1] === values[1] && row[3] === values[3])) records.push([...values]);
    return [{ insertId: records.length }];
  } };
  return { executor, records };
}
test('notification audiences include recipient/Hospital/city banks/donor, not another city', async () => {
  const { executor, records } = notificationExecutor();
  const response = await notifications.notifyRequestAudience(executor, request(), 'created', 'A city request was created.', { donorId: 3 });
  assert.equal(response.audience_count, 5);
  assert.deepEqual(records.map(row => row.slice(0, 2)), [['recipient', 9], ['organization', 11], ['blood_bank', 7], ['blood_bank', 8], ['donor', 3]]);
  assert.equal(records.every(row => row[3] === 'request:70:created'), true);
});
test('replayed event identity does not duplicate deliveries or reset read state', async () => {
  const { executor, records } = notificationExecutor();
  await notifications.notifyRequestAudience(executor, request(), 'created', 'Created.');
  await notifications.notifyRequestAudience(executor, request(), 'created', 'Created.');
  assert.equal(records.length, 4);
});
test('collecting bank is explicitly notified after location changes', async () => {
  const { executor, records } = notificationExecutor();
  await notifications.notifyRequestAudience(executor, request(), 'accepted', 'Accepted.', { donorId: 3, collectingBankId: 9 });
  assert.ok(records.some(row => row[0] === 'blood_bank' && row[1] === 9));
});
test('private coordination excludes city banks except designated collector', async () => {
  const { executor, records } = notificationExecutor();
  await notifications.notifyRequestAudience(executor, request(), 'screened', 'Screening recorded.',
    { donorId: 3, collectingBankId: 7, cityBanks: false });
  assert.deepEqual(records.map(row => row.slice(0, 2)), [['recipient', 9], ['organization', 11], ['blood_bank', 7], ['donor', 3]]);
});
for (const changes of [{ type: 'admin' }, { id: 0 }, { request_id: 0 }, { event_key: '' }, { event_key: 'x'.repeat(101) }, { message: '' }, { message: 'x'.repeat(501) }]) {
  test('invalid notification rejected ' + Object.keys(changes)[0], async () => {
    await assert.rejects(notifications.notifyAudience({ execute: async () => assert.fail('SQL must not run') },
      { type: 'recipient', id: 9, request_id: 70, event_key: 'created', message: 'Created.', ...changes }), error => error.status === 400);
  });
}
test('notification failure propagates for caller transaction rollback', async () => {
  await assert.rejects(notifications.notifyAudience({ execute: async () => { throw new Error('fixture failure'); } },
    { type: 'recipient', id: 9, request_id: 70, event_key: 'created', message: 'Created.' }), /fixture failure/);
});
