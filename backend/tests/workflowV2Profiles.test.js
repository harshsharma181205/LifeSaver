const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../db');
const config = require('../services/workflowV2Config');
const donor = require('../controllers/donorController');
const organization = require('../controllers/organizationController');
const auth = require('../controllers/authController');
const original = { execute: pool.execute, getConnection: pool.getConnection, query: pool.query, ready: config.assertReady, flag: process.env.LIFESAVER_WORKFLOW_V2 };
let queries, providerType, failure;
beforeEach(() => {
  process.env.LIFESAVER_WORKFLOW_V2 = 'true'; queries = []; providerType = 'Blood Bank'; failure = false;
  config.assertReady = async () => { if (failure) { const error = new Error('Workflow not available.'); error.status = 503; throw error; } };
  pool.query = async () => { throw new Error('Real SQL forbidden.'); };
  pool.execute = async (sql, args) => {
    queries.push({ sql, args });
    if (sql.startsWith('SELECT ')) {
      if (sql.includes('FROM organizations')) return [[{ organization_id: 1, bank_id: providerType === 'Blood Bank' ? 7 : null, organization_type: providerType, name: 'Provider', state: 'Uttarakhand', city: 'Dehradun' }]];
      if (sql.includes('FROM blood_banks')) return [[{ bank_id: 7, bank_name: 'Bank', organization_id: 1, organization_type: 'Blood Bank', state: 'Uttarakhand', city: 'Dehradun' }]];
      if (sql.includes('FROM donors')) return [[{ name: 'Donor', blood_group: 'A+', state: 'Uttarakhand', city: 'Dehradun', is_available: 1 }]];
    }
    if (sql.startsWith('INSERT INTO organizations')) return [{ insertId: 1 }];
    if (sql.startsWith('INSERT INTO blood_banks')) return [{ insertId: 7 }];
    if (sql.startsWith('INSERT INTO donors')) return [{ insertId: 3 }];
    if (sql.startsWith('UPDATE ')) return [{ affectedRows: 1 }];
    throw new Error('Unexpected mocked SQL');
  };
  pool.getConnection = async () => ({ execute: (...args) => pool.execute(...args), beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release: () => {}, destroy: () => {} });
});
after(() => { pool.execute = original.execute; pool.getConnection = original.getConnection; pool.query = original.query; config.assertReady = original.ready; if (original.flag === undefined) delete process.env.LIFESAVER_WORKFLOW_V2; else process.env.LIFESAVER_WORKFLOW_V2 = original.flag; });
async function run(handler, body, user = { user_type: 'donor', user_id: 3 }) {
  const result = { status: 200 }; const response = { status(code) { result.status = code; return this; }, json(value) { result.body = value; return this; } };
  await handler({ body, user }, response); assert.doesNotMatch(JSON.stringify(result.body), /password|scrypt|stack|\"sql\"/i); return result;
}
const donorInput = () => ({ name: 'Donor', gender: 'Other', blood_group: 'A+', date_of_birth: '2000-01-01', phone: '0123456789', password: 'In-memory-only-password', state: 'Uttarakhand', city: 'Dehradun' });
const orgInput = type => ({ organization_type: type, name: 'Provider', state: 'Uttarakhand', city: 'Dehradun', address: 'Collection desk', phone: '0123456789', email: 'test@example.invalid', password: 'In-memory-only-password' });
test('V2 Hospital registration creates no operational bank row', async () => { const result = await run(organization.registerOrganization, orgInput('Hospital')); assert.equal(result.status, 201); assert.equal(result.body.organization.bank_id, null); assert.ok(!queries.some(q => q.sql.startsWith('INSERT INTO blood_banks'))); });

test('V2 Blood Bank registration creates its own operational bank', async () => { const result = await run(organization.registerOrganization, orgInput('Blood Bank')); assert.equal(result.status,201); assert.equal(result.body.organization.bank_id,7); });
test('unready V2 schema blocks registration before any write', async () => { failure=true; assert.equal((await run(organization.registerOrganization,orgInput('Blood Bank'))).status,503); assert.equal(queries.length,0); });
test('disabled workflow preserves legacy Hospital operational bank compatibility', async () => { delete process.env.LIFESAVER_WORKFLOW_V2; const result=await run(organization.registerOrganization,orgInput('Hospital')); assert.equal(result.status,201); assert.equal(result.body.organization.bank_id,7); });
