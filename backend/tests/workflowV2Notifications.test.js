const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../services/workflowV2Config');
const dbPath = require.resolve('../db');
const oldDb = require.cache[dbPath];
let queries, provider, notifications, failAt;
const pool = { execute: async (sql, values = []) => {
  queries.push({ sql, values });
  if (sql.includes(failAt) && failAt) throw new Error('private SQL password details');
  if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [Object.entries(config.requiredColumns).flatMap(([TABLE_NAME, names]) => names.map(COLUMN_NAME => ({ TABLE_NAME, COLUMN_NAME })))];
  if (sql.startsWith('SELECT version')) return [[{ version: 2 }]];
  if (sql.includes('FROM organizations o') || sql.includes('FROM blood_banks b LEFT JOIN organizations')) return [provider ? [provider] : []];
  if (sql.startsWith('SELECT notification_id')) {
    const withId = sql.includes('WHERE notification_id = ?');
    const id = withId ? values[0] : null;
    const audiences = withId ? values.slice(1) : values;
    return [notifications.filter(row => (!withId || row.notification_id === id) &&
      audiences.some((type, i) => i % 2 === 0 && row.audience_type === type && row.audience_id === audiences[i + 1]))
      .map(({ audience_type, audience_id, ...row }) => row)];
  }
  if (sql.startsWith('UPDATE workflow_notifications')) {
    const row = notifications.find(item => item.notification_id === values[0] && item.audience_type === values[1] && item.audience_id === values[2]);
    if (row) row.is_read = 1;
    return [{ affectedRows: row ? 1 : 0 }];
  }
  throw new Error('Unexpected fixture SQL.');
} };
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: pool };
const controller = require('../controllers/providerNotificationsV2Controller');
const oldFlag = process.env.LIFESAVER_WORKFLOW_V2;
test.beforeEach(() => {
  process.env.LIFESAVER_WORKFLOW_V2 = 'true';
  queries = []; failAt = null;
  provider = { organization_id: 20, bank_id: 7, organization_type: 'Blood Bank' };
  notifications = [
    { notification_id: 1, audience_type: 'blood_bank', audience_id: 7, request_id: 70, event_key: 'created', message: 'Request created.', is_read: 0, sent_at: '2026-10-21' },
    { notification_id: 2, audience_type: 'blood_bank', audience_id: 8, request_id: 70, event_key: 'created', message: 'Other bank.', is_read: 0 },
    { notification_id: 3, audience_type: 'organization', audience_id: 11, request_id: 70, event_key: 'created', message: 'Hospital.', is_read: 0 },
    { notification_id: 4, audience_type: 'recipient', audience_id: 9, request_id: 70, event_key: 'created', message: 'Recipient.', is_read: 0 },
    { notification_id: 5, audience_type: 'donor', audience_id: 3, request_id: 70, event_key: 'accepted', message: 'Donor.', is_read: 0 },
  ];
});
test.after(() => {
  if (oldDb) require.cache[dbPath] = oldDb; else delete require.cache[dbPath];
  if (oldFlag === undefined) delete process.env.LIFESAVER_WORKFLOW_V2; else process.env.LIFESAVER_WORKFLOW_V2 = oldFlag;
});
async function call({ user = { user_id: 20, user_type: 'organization' }, query = {}, id, body, mark = false } = {}) {
  const req = { user, query, params: { notificationId: id }, body };
  const response = { code: null, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await (mark ? controller.markNotificationRead : controller.listNotifications)(req, response);
  assert.equal(/password|SQL|stack/.test(JSON.stringify(response.body)), false);
  return response;
}
test('missing authentication is 401 without querying readiness', async () => {
  assert.equal((await call({ user: null })).code, 401); assert.equal(queries.length, 0);
});
test('disabled V2 is safe 503', async () => {
  process.env.LIFESAVER_WORKFLOW_V2 = 'false';
  assert.equal((await call()).code, 503); assert.equal(queries.length, 0);
});
test('Bank organization login sees only canonical own-bank notifications', async () => {
  const result = await call();
  assert.equal(result.code, 200); assert.deepEqual(result.body.notifications.map(row => row.notification_id), [1]);
  assert.equal(result.body.notifications[0].source, 'workflow');
  assert.equal('audience_id' in result.body.notifications[0], false);
});
test('legacy bank identity resolves to the same canonical bank audience', async () => {
  const result = await call({ user: { user_type: 'blood_bank', user_id: 7 } });
  assert.deepEqual(result.body.notifications.map(row => row.notification_id), [1]);
});
test('Hospital receives admission audience but not companion-bank notifications', async () => {
  provider = { organization_id: 11, bank_id: 7, organization_type: 'Hospital' };
  const result = await call({ user: { user_type: 'organization', user_id: 11 } });
  assert.deepEqual(result.body.notifications.map(row => row.notification_id), [3]);
});
test('new Hospital without a companion bank still receives its admission notifications', async () => {
  provider = { organization_id: 11, bank_id: null, organization_type: 'Hospital' };
  const result = await call({ user: { user_type: 'organization', user_id: 11 } });
  assert.equal(result.code, 200);
  assert.deepEqual(result.body.notifications.map(row => row.notification_id), [3]);
});
for (const [role, userId, notificationId] of [['recipient', 9, 4], ['donor', 3, 5]]) {
  test(role + ' reads own workflow notifications only', async () => {
    const result = await call({ user: { user_type: role, user_id: userId } });
    assert.deepEqual(result.body.notifications.map(row => row.notification_id), [notificationId]);
    assert.ok(queries.every(query => !query.sql.includes('FROM organizations')));
  });
}
test('NGO provider has no workflow audience', async () => {
  provider.organization_type = 'NGO'; assert.equal((await call()).code, 403);
});
test('unknown provider has no workflow audience', async () => { provider = null; assert.equal((await call()).code, 403); });
for (const query of [{ bank_id: '8' }, { audience_id: '8' }, { user_type: 'recipient' }]) {
  test('reject query ownership override ' + Object.keys(query)[0], async () => {
    assert.equal((await call({ query })).code, 400); assert.ok(queries.every(row => !row.sql.includes('workflow_notifications WHERE')));
  });
}
test('mark-read owned notification and replay remain successful', async () => {
  assert.equal((await call({ mark: true, id: '1', body: { source: 'workflow' } })).code, 200);
  assert.equal(notifications[0].is_read, 1);
  assert.equal((await call({ mark: true, id: '1', body: {} })).code, 200);
});
for (const id of ['2', '3', '999']) test('foreign or missing notification ' + id + ' safe 404', async () => {
  assert.equal((await call({ mark: true, id })).code, 404);
  assert.ok(queries.every(row => !row.sql.startsWith('UPDATE')));
});
for (const id of ['0', '-1', '1.5', 'abc', '1 OR 1=1', '2147483648']) test('invalid notification ID ' + id, async () => {
  assert.equal((await call({ mark: true, id })).code, 400);
});
for (const body of [{ source: 'legacy' }, { is_read: false }, [], 'text', 0, false]) test('mark-read cannot mutate extra data ' + JSON.stringify(body), async () => {
  assert.equal((await call({ mark: true, id: '1', body })).code, 400);
});
test('database error is safe 500 without leaked implementation details', async () => {
  failAt = 'FROM workflow_notifications'; assert.equal((await call()).code, 500);
});
test('readiness database error is safe 503', async () => {
  failAt = 'INFORMATION_SCHEMA'; assert.equal((await call()).code, 503);
});
