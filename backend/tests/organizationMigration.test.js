const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildPlan, migrate } = require('../migrations/organizationWorkflow');

const tableNames = ['blood_banks', 'donors', 'recipients', 'blood_requests', 'blood_inventory', 'donations', 'request_allocations', 'donor_responses'];
const newColumns = [
  ['blood_banks', 'organization_id', 'int'],
  ['donors', 'state', 'varchar(100)'], ['donors', 'city', 'varchar(100)'],
  ['blood_requests', 'organization_id', 'int'], ['blood_requests', 'state', 'varchar(100)'], ['blood_requests', 'city', 'varchar(100)'],
  ['donor_responses', 'screening_result', "enum('Passed','Failed')"],
  ['donor_responses', 'screened_at', 'timestamp'], ['donor_responses', 'screened_by_organization_id', 'int'],
  ['blood_inventory', 'version', 'bigint unsigned'],
  ['request_allocations', 'inventory_id', 'int'], ['request_allocations', 'operation_key', 'varchar(64)'],
];
const orgColumns = [
  ['organization_id', 'int'], ['organization_type', "enum('Hospital','Blood Bank','NGO')"],
  ['name', 'varchar(100)'], ['state', 'varchar(100)'], ['city', 'varchar(100)'],
  ['address', 'varchar(255)'], ['phone', 'varchar(15)'], ['email', 'varchar(100)'],
  ['password_hash', 'varchar(255)'], ['created_at', 'timestamp'],
];
const newKeys = [
  ['blood_banks', 'organization_id', 'organizations', 'organization_id'],
  ['blood_requests', 'organization_id', 'organizations', 'organization_id'],
  ['donor_responses', 'screened_by_organization_id', 'organizations', 'organization_id'],
  ['request_allocations', 'inventory_id', 'blood_inventory', 'inventory_id'],
];
const expectedCheck = '((donation_id is not null) and (inventory_id is null)) or ((donation_id is null) and (inventory_id is not null))';

function fixture(options = {}) {
  const calls = [], transactions = [];
  let complete = !!options.complete;
  const bank = { bank_id: 9, bank_name: 'Existing genuine bank', address: 'Original address',
    phone: null, email: 'existing@example.invalid', password_hash: null, created_at: null };
  const columns = () => {
    const rows = [
      ['blood_banks', 'bank_id', 'int'], ['blood_banks', 'password_hash', 'varchar(255)'],
      ['blood_requests', 'bank_id', 'int'], ['donor_responses', 'request_id', 'int'],
      ['request_allocations', 'donation_id', 'int'],
    ];
    if (complete) rows.push(...newColumns, ...orgColumns.map(([name, type]) => ['organizations', name, type]));
    return rows.map(([TABLE_NAME, COLUMN_NAME, COLUMN_TYPE]) => ({
      TABLE_NAME, COLUMN_NAME, COLUMN_TYPE: options.badType && TABLE_NAME === 'blood_inventory' && COLUMN_NAME === 'version' ? 'varchar(100)' : COLUMN_TYPE,
      IS_NULLABLE: TABLE_NAME === 'request_allocations' && COLUMN_NAME === 'donation_id' && !complete ? 'NO' : 'YES',
    }));
  };
  const indexes = () => {
    const rows = [];
    if (complete) {
      for (const [table, names] of [
        ['organizations', ['phone']], ['organizations', ['email']], ['blood_banks', ['organization_id']],
        ['recipients', ['phone']], ['recipients', ['email']], ['request_allocations', ['request_id', 'operation_key']],
      ]) for (let i = 0; i < names.length; i++) rows.push({ TABLE_NAME: table,
        INDEX_NAME: 'unique_' + table + '_' + names.join('_'), NON_UNIQUE: 0, SEQ_IN_INDEX: i + 1, COLUMN_NAME: names[i] });
    }
    return rows;
  };
  const pool = {
    execute: async (sql, values) => {
      calls.push({ sql, values });
      if (sql.includes('INFORMATION_SCHEMA.TABLES')) {
        return [[...tableNames, ...(complete ? ['organizations'] : [])].map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB' }))];
      }
      if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [columns()];
      if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) return [indexes()];
      if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) {
        const rows = complete ? newKeys : [];
        return [rows.map(([TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME]) => ({
          TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME,
          REFERENCED_COLUMN_NAME: options.badForeignKey && TABLE_NAME === 'blood_banks' ? 'wrong_id' : REFERENCED_COLUMN_NAME,
        }))];
      }
      if (sql.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) return [complete ? [
        { TABLE_NAME: 'request_allocations', CONSTRAINT_NAME: 'chk_allocation_one_source',
          CHECK_CLAUSE: options.badCheck ? 'donation_id IS NOT NULL OR inventory_id IS NOT NULL' : expectedCheck },
      { TABLE_NAME: 'donor_responses', CONSTRAINT_NAME: 'chk_screening_consistency', CHECK_CLAUSE: options.actualMysqlClause ? "(((screening_result is null) and(screened_at is null) and(screened_by_organization_id is null)) or ((response = _utf8mb4\\'Accepted\\') and(screening_result is not null) and(screened_at is not null) and(screened_by_organization_id is not null)))" : "(screening_result IS NULL AND screened_at IS NULL AND screened_by_organization_id IS NULL) OR (response = " + (options.utf8Literal ? "_utf8mb4" : "") + "'Accepted' AND screening_result IS NOT NULL AND screened_at IS NOT NULL AND screened_by_organization_id IS NOT NULL)" },
      ] : []];
      if (sql.startsWith('SELECT COUNT(*)') && sql.includes('GROUP BY')) {
        return [options.duplicate && sql.includes('FROM recipients WHERE phone') ? [{ total: 2 }] : []];
      }
      if (sql.startsWith('SELECT COUNT(*) AS total FROM donor_responses WHERE')) return [[{ total: options.invalidScreening ? 1 : 0 }]];
      if (sql.startsWith('SELECT COUNT(*) AS total FROM request_allocations WHERE')) return [[{ total: options.invalidSources ? 1 : 0 }]];
      if (sql.startsWith('ALTER TABLE') || sql.startsWith('CREATE TABLE')) return [{}];
      if (sql.startsWith('SELECT COUNT(*) AS total FROM organizations')) return [[{ total: 1 }]];
      if (sql.startsWith('SELECT COUNT(*) AS total FROM blood_requests')) return [[{ total: 5 }]];
      throw new Error('Unexpected migration SQL: ' + sql);
    },
    getConnection: async () => ({
      beginTransaction: async () => { transactions.push('begin'); },
      execute: async (sql, values) => {
        calls.push({ sql, values });
        if (sql.startsWith('SELECT bank_id')) return [options.noBanks || complete ? [] : [bank]];
        if (sql.startsWith('INSERT INTO organizations')) {
          if (options.copyError) { const error = new Error('Private SQL information'); error.code = 'ER_DUP_ENTRY'; throw error; }
          return [{ insertId: 12 }];
        }
        if (sql.startsWith('UPDATE blood_banks')) return [{ affectedRows: 1 }];
        throw new Error('Unexpected migration transaction SQL');
      },
      commit: async () => { transactions.push('commit'); complete = true; },
      rollback: async () => { transactions.push('rollback'); },
      release: () => { transactions.push('release'); },
    }),
  };
  return { pool, calls, transactions, bank };
}

test('migration plan is read-only and includes each agreed workflow field', async () => {
  const database = fixture();
  const plan = await buildPlan(database.pool);
  const sql = plan.steps.map(row => row.sql).join('\n');
  assert.ok(sql.includes('CREATE TABLE organizations'));
  for (const [table, column] of newColumns) assert.ok(sql.includes('ALTER TABLE ' + table + ' ADD COLUMN ' + column));
  assert.ok(sql.includes('MODIFY COLUMN donation_id INT NULL'));
  assert.ok(sql.includes('chk_allocation_one_source CHECK'));
  assert.ok(sql.includes('chk_screening_consistency CHECK'));
  assert.ok(sql.includes('UNIQUE KEY uq_request_operation (request_id, operation_key)'));
  assert.ok(sql.includes('REFERENCES organizations(organization_id)'));
  assert.ok(sql.includes('UNIQUE KEY uq_recipient_phone'));
  assert.ok(sql.includes('UNIQUE KEY uq_recipient_email'));
  assert.ok(database.calls.every(row => row.sql.startsWith('SELECT')));
  assert.deepEqual(database.transactions, []);
});
test('recipient identifier duplicates stop migration before any write', async () => {
  const database = fixture({ duplicate: true });
  await assert.rejects(migrate(database.pool), /duplicates require manual review/);
  assert.ok(database.calls.every(row => row.sql.startsWith('SELECT')));
  assert.deepEqual(database.transactions, []);
});
test('invalid existing source allocation stops migration before DDL', async () => {
  const database = fixture({ invalidSources: true });
  await assert.rejects(migrate(database.pool), /allocation sources are invalid/);
  assert.ok(database.calls.every(row => row.sql.startsWith('SELECT')));
});
test('migration copies genuine legacy bank data and preserves its original fields and request history', async () => {
  const database = fixture();
  const result = await migrate(database.pool);
  assert.equal(result.migratedBanks, 1);
  assert.equal(result.organizationsNeedingLocation, 1);
  assert.equal(result.historicalRequestsWithoutLocationSnapshots, 5);
  assert.deepEqual(database.transactions, ['begin', 'commit', 'release']);
  const copy = database.calls.find(row => row.sql.startsWith('INSERT INTO organizations'));
  assert.deepEqual(copy.values, [database.bank.bank_name, database.bank.address, database.bank.phone,
    database.bank.email, database.bank.password_hash, database.bank.created_at]);
  assert.ok(copy.sql.includes("VALUES ('Blood Bank', ?, NULL, NULL"));
  const update = database.calls.filter(row => row.sql.startsWith('UPDATE'));
  assert.equal(update.length, 1);
  assert.equal(update[0].sql, 'UPDATE blood_banks SET organization_id = ? WHERE bank_id = ? AND organization_id IS NULL');
  assert.deepEqual(update[0].values, [12, 9]);
  assert.ok(database.calls.every(row => !/^DELETE|^DROP|^INSERT INTO (donations|request_allocations)|^UPDATE blood_requests/i.test(row.sql)));
});
test('legacy account copy failure rolls back its mapping transaction', async () => {
  const database = fixture({ copyError: true });
  await assert.rejects(migrate(database.pool), { code: 'ER_DUP_ENTRY' });
  assert.deepEqual(database.transactions, ['begin', 'rollback', 'release']);
  assert.ok(database.calls.every(row => !row.sql.startsWith('UPDATE blood_banks')));
});
test('a fully applied schema produces an empty plan and no fabricated account copies', async () => {
  const database = fixture({ complete: true });
  const plan = await buildPlan(database.pool);
  assert.deepEqual(plan.steps, []);
  const result = await migrate(database.pool);
  assert.equal(result.migratedBanks, 0);
  assert.deepEqual(result.changes, []);
  assert.ok(database.calls.every(row => !/^(ALTER|CREATE|INSERT|UPDATE|DELETE|DROP)\b/.test(row.sql)));
});
for (const options of [{ badType: true }, { badForeignKey: true }, { badCheck: true }]) {
  test('conflicting existing schema stops before DDL: ' + Object.keys(options)[0], async () => {
    const database = fixture({ complete: true, ...options });
    await assert.rejects(migrate(database.pool), /unexpected type|foreign key conflicts|source constraint conflicts/);
    assert.ok(database.calls.every(row => row.sql.startsWith('SELECT')));
  });
}


test('invalid partial screening metadata stops before any schema write', async () => {
  const database = fixture({ invalidScreening: true });
  await assert.rejects(migrate(database.pool), /screening metadata is incomplete/);
  assert.ok(database.calls.every(row => row.sql.startsWith('SELECT')));
});

test('MySQL UTF-8 literal rendering does not prevent repeat migration planning', async () => {
  const database = fixture({ complete: true, utf8Literal: true });
  assert.deepEqual((await buildPlan(database.pool)).steps, []);
});


test('actual MySQL screening clause with escaped UTF-8 quotes allows a repeat plan', async () => {
  const database = fixture({ complete: true, actualMysqlClause: true });
  assert.deepEqual((await buildPlan(database.pool)).steps, []);
});
