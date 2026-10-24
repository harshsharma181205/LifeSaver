const test = require('node:test');
const assert = require('node:assert/strict');
const migration = require('../migrations/cityWideWorkflow');

function schema(complete = false) {
  const names = ['organizations', 'blood_banks', 'blood_requests', 'donors', 'donor_responses', 'donations', 'blood_inventory', 'request_allocations'];
  const data = { tables: names.map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB' })), columns: [], indexes: [], keys: [], checks: [] };
  const column = (table, name, type = 'int', nullable = 'YES', fallback = null, charset = null) =>
    data.columns.push({ TABLE_NAME: table, COLUMN_NAME: name, COLUMN_TYPE: type, IS_NULLABLE: nullable, COLUMN_DEFAULT: fallback, CHARACTER_SET_NAME: charset });
  for (const key of ['blood_requests.request_id', 'blood_requests.bank_id', 'blood_requests.organization_id', 'donor_responses.request_id',
    'donor_responses.donor_id', 'donor_responses.screening_result', 'donor_responses.screened_by_organization_id', 'blood_inventory.inventory_id',
    'blood_inventory.version', 'request_allocations.inventory_id', 'request_allocations.operation_key', 'organizations.organization_type', 'blood_banks.organization_id']) {
    const [table, name] = key.split('.'); column(table, name);
  }
  const index = (table, names, unique = true, name = names.join('_')) => names.forEach((COLUMN_NAME, i) => data.indexes.push({
    TABLE_NAME: table, INDEX_NAME: name, NON_UNIQUE: unique ? 0 : 1, SEQ_IN_INDEX: i + 1, COLUMN_NAME,
  }));
  index('donor_responses', ['request_id', 'donor_id']); index('request_allocations', ['request_id', 'operation_key']);
  if (!complete) return data;
  column('blood_requests', 'workflow_version', 'tinyint unsigned', 'NO', '1');
  column('blood_requests', 'admission_hospital_id');
  column('donor_responses', 'collecting_bank_id'); column('request_allocations', 'actor_bank_id'); column('request_allocations', 'collection_id');
  const newColumns = {
    donor_collections: { collection_id: 'int', request_id: 'int', donor_id: 'int', bank_id: 'int', donation_id: 'int',
      accounting_path: "enum('DirectRequest','Inventory')", inventory_id: 'int', units_collected: 'int', operation_key: 'char(36)', collected_at: 'timestamp' },
    workflow_notifications: { notification_id: 'int', audience_type: "enum('donor','recipient','organization','blood_bank')", audience_id: 'int',
      request_id: 'int', event_key: 'varchar(100)', message: 'varchar(500)', is_read: 'tinyint(1)', sent_at: 'timestamp' },
    workflow_schema_versions: { version: 'tinyint unsigned', applied_at: 'timestamp' },
  };
  for (const [table, columns] of Object.entries(newColumns)) {
    data.tables.push({ TABLE_NAME: table, ENGINE: 'InnoDB' });
    for (const [name, type] of Object.entries(columns)) column(table, name, type, name === 'inventory_id' ? 'YES' : 'NO', null,
      (table === 'donor_collections' && name === 'operation_key') || (table === 'workflow_notifications' && name === 'event_key') ? 'ascii' : null);
    index(table, [table === 'donor_collections' ? 'collection_id' : table === 'workflow_notifications' ? 'notification_id' : 'version'], true, 'PRIMARY');
  }
  const foreignKey = (table, names, parent, parents, name = table + '_' + names.join('_')) => names.forEach((COLUMN_NAME, i) => data.keys.push({
    CONSTRAINT_NAME: name, TABLE_NAME: table, COLUMN_NAME, ORDINAL_POSITION: i + 1, REFERENCED_TABLE_NAME: parent, REFERENCED_COLUMN_NAME: parents[i], DELETE_RULE: 'RESTRICT',
  }));
  foreignKey('blood_requests', ['admission_hospital_id'], 'organizations', ['organization_id']);
  foreignKey('donor_responses', ['collecting_bank_id'], 'blood_banks', ['bank_id']);
  foreignKey('request_allocations', ['actor_bank_id'], 'blood_banks', ['bank_id']);
  foreignKey('request_allocations', ['collection_id'], 'donor_collections', ['collection_id']);
  foreignKey('donor_collections', ['request_id', 'donor_id'], 'donor_responses', ['request_id', 'donor_id']);
  foreignKey('donor_collections', ['bank_id'], 'blood_banks', ['bank_id']);
  foreignKey('donor_collections', ['donation_id'], 'donations', ['donation_id']);
  foreignKey('donor_collections', ['inventory_id'], 'blood_inventory', ['inventory_id']);
  foreignKey('workflow_notifications', ['request_id'], 'blood_requests', ['request_id']);
  index('request_allocations', ['collection_id']);
  index('blood_requests', ['workflow_version', 'status', 'state', 'city', 'request_date', 'request_id'], false);
  index('blood_requests', ['admission_hospital_id', 'request_date', 'request_id'], false);
  index('organizations', ['organization_type', 'state', 'city'], false);
  index('donors', ['state', 'city', 'blood_group', 'is_available'], false);
  index('donor_responses', ['collecting_bank_id', 'request_id'], false);
  index('donor_collections', ['request_id', 'donor_id']); index('donor_collections', ['donation_id']); index('donor_collections', ['request_id', 'operation_key']);
  index('workflow_notifications', ['audience_type', 'audience_id', 'event_key']);
  index('workflow_notifications', ['audience_type', 'audience_id', 'sent_at', 'notification_id'], false);
  const check = (TABLE_NAME, CONSTRAINT_NAME, CHECK_CLAUSE) => data.checks.push({ TABLE_NAME, CONSTRAINT_NAME, CHECK_CLAUSE, ENFORCED: 'YES' });
  check('blood_requests', 'chk_workflow_version', 'workflow_version IN (1, 2)');
  check('blood_requests', 'chk_admission_v2', 'workflow_version = 1 OR (admission_hospital_id IS NOT NULL AND bank_id IS NULL AND organization_id IS NULL)');
  check('donor_responses', 'chk_collecting_bank_response', "collecting_bank_id IS NULL OR response = 'Accepted'");
  check('request_allocations', 'chk_collection_credit_source', 'collection_id IS NULL OR (donation_id IS NOT NULL AND inventory_id IS NULL)');
  check('donor_collections', 'chk_collection_positive', 'units_collected > 0');
  check('donor_collections', 'chk_collection_accounting', "(accounting_path = 'DirectRequest' AND inventory_id IS NULL) OR (accounting_path = 'Inventory' AND inventory_id IS NOT NULL)");
  check('workflow_notifications', 'chk_workflow_audience', 'audience_id > 0');
  return data;
}

function executor(data = schema(), options = {}) {
  const calls = [];
  return { calls, execute: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.startsWith('SELECT DATABASE()')) return [[{ database_name: options.database || 'lifesaver_v2_test_fixture' }]];
    if (sql.includes('INFORMATION_SCHEMA.TABLES')) return [data.tables];
    if (sql.includes('INFORMATION_SCHEMA.COLUMNS')) return [data.columns];
    if (sql.includes('INFORMATION_SCHEMA.STATISTICS')) return [data.indexes];
    if (sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE')) return [data.keys];
    if (sql.includes('INFORMATION_SCHEMA.TABLE_CONSTRAINTS')) return [data.checks];
    if (/^(CREATE|ALTER) TABLE/.test(sql)) {
      if (options.failDDL) throw new Error('fixture DDL failure');
      if (options.completeAfterDDL) Object.assign(data, schema(true));
      return [{}];
    }
    if (sql.startsWith('INSERT INTO workflow_schema_versions')) return [{ affectedRows: 1 }];
    throw new Error('Unexpected fixture SQL.');
  } };
}

test('migration plan is additive and never rewrites/deletes historical business records', async () => {
  const database = executor(); const plan = await migration.buildPlan(database);
  assert.equal(plan.version, 2); assert.equal(plan.historyBackfills, 0);
  assert.ok(plan.steps.length > 20);
  assert.ok(database.calls.every(call => call.sql.startsWith('SELECT')));
  assert.ok(plan.steps.every(step => /^(CREATE|ALTER) TABLE/.test(step.sql) && !/\b(DROP|TRUNCATE)\b|;\s*(DELETE|UPDATE)/.test(step.sql)));
  assert.ok(plan.steps.find(step => step.label === 'blood_requests.workflow_version').sql.includes('DEFAULT 1'));
});
test('collection event prevents fresh-key duplicate and double direct credit', async () => {
  const sql = (await migration.buildPlan(executor())).steps.map(step => step.sql).join('\n');
  assert.match(sql, /UNIQUE KEY uq_collection_donor_event \(request_id, donor_id\)/);
  assert.match(sql, /UNIQUE KEY uq_collection_donation \(donation_id\)/);
  assert.match(sql, /UNIQUE KEY uq_collection_operation \(request_id, operation_key\)/);
  assert.match(sql, /UNIQUE KEY uq_allocation_collection \(collection_id\)/);
  assert.match(sql, /FOREIGN KEY \(request_id, donor_id\) REFERENCES donor_responses\(request_id, donor_id\) ON DELETE RESTRICT/);
  assert.match(sql, /accounting_path = 'DirectRequest' AND inventory_id IS NULL/);
  assert.match(sql, /accounting_path = 'Inventory' AND inventory_id IS NOT NULL/);
});
test('V2 separates admission identity from legacy exclusive bank and organization fields', async () => {
  const plan = await migration.buildPlan(executor());
  const sql = plan.steps.find(step => step.label === 'chk_admission_v2').sql;
  assert.match(sql, /workflow_version = 1 OR \(admission_hospital_id IS NOT NULL AND bank_id IS NULL AND organization_id IS NULL\)/);
});
test('collecting bank constraint allows legacy null and only Accepted assignment', async () => {
  const plan = await migration.buildPlan(executor());
  const sql = plan.steps.find(step => step.label === 'chk_collecting_bank_response').sql;
  assert.match(sql, /collecting_bank_id IS NULL OR response = 'Accepted'/);
});

test('notification schema deduplicates audience/event and keeps request history restrictive', async () => {
  const sql = (await migration.buildPlan(executor())).steps.find(step => step.label === 'workflow_notifications').sql;
  assert.match(sql, /UNIQUE KEY uq_workflow_notification_event \(audience_type, audience_id, event_key\)/);
  assert.match(sql, /ON DELETE RESTRICT/);
  assert.doesNotMatch(sql, /phone|password|email/);
});
test('complete schema plans no repeated DDL', async () => assert.equal((await migration.buildPlan(executor(schema(true)))).steps.length, 0));

for (const table of ['organizations', 'blood_requests', 'donations']) test('missing required table ' + table + ' fails before DDL', async () => {
  const data = schema(); data.tables = data.tables.filter(row => row.TABLE_NAME !== table);
  const database = executor(data); await assert.rejects(migration.buildPlan(database), /Required InnoDB/);
  assert.ok(database.calls.every(call => call.sql.startsWith('SELECT')));
});
test('non-InnoDB existing table blocks migration', async () => {
  const data = schema(); data.tables[0].ENGINE = 'MyISAM'; await assert.rejects(migration.buildPlan(executor(data)), /InnoDB/);
});
test('missing existing clinical schema blocks migration', async () => {
  const data = schema(); data.columns = data.columns.filter(row => row.COLUMN_NAME !== 'screening_result');
  await assert.rejects(migration.buildPlan(executor(data)), /incomplete/);
});
test('missing baseline operation uniqueness blocks migration', async () => {
  const data = schema(); data.indexes = data.indexes.filter(row => row.TABLE_NAME !== 'request_allocations');
  await assert.rejects(migration.buildPlan(executor(data)), /uniqueness/);
});
for (const change of ['wrong type', 'nonnullable admission', 'version default']) test('column conflict ' + change, async () => {
  const data = schema(true); const field = data.columns.find(row => row.COLUMN_NAME === 'admission_hospital_id');
  if (change === 'wrong type') field.COLUMN_TYPE = 'varchar(20)';
  if (change === 'nonnullable admission') field.IS_NULLABLE = 'NO';
  if (change === 'version default') data.columns.find(row => row.COLUMN_NAME === 'workflow_version').COLUMN_DEFAULT = '2';
  await assert.rejects(migration.buildPlan(executor(data)), /Conflicting|nullable|default/);
});
test('foreign key pointing to wrong parent fails preflight', async () => {
  const data = schema(true); data.keys.find(row => row.COLUMN_NAME === 'admission_hospital_id').REFERENCED_TABLE_NAME = 'blood_banks';
  await assert.rejects(migration.buildPlan(executor(data)), /foreign key/);
});
test('foreign key cascade on new clinical evidence fails preflight', async () => {
  const data = schema(true); data.keys.find(row => row.TABLE_NAME === 'donor_collections' && row.COLUMN_NAME === 'donation_id').DELETE_RULE = 'CASCADE';
  await assert.rejects(migration.buildPlan(executor(data)), /foreign key/);
});
test('conflicting collection check fails preflight', async () => {
  const data = schema(true); data.checks.find(row => row.CONSTRAINT_NAME === 'chk_collection_positive').CHECK_CLAUSE = 'units_collected >= 0';
  await assert.rejects(migration.buildPlan(executor(data)), /CHECK/);
});
test('non-enforced collection CHECK cannot certify readiness', async () => {
  const data = schema(true); data.checks.find(row => row.CONSTRAINT_NAME === 'chk_collection_positive').ENFORCED = 'NO';
  await assert.rejects(migration.buildPlan(executor(data)), /must be enforced/);
});
test('existing collection table with nullable event identity fails preflight', async () => {
  const data = schema(true); data.columns.find(row => row.TABLE_NAME === 'donor_collections' && row.COLUMN_NAME === 'donor_id').IS_NULLABLE = 'YES';
  await assert.rejects(migration.buildPlan(executor(data)), /conflicts/);
});
test('existing version registry without primary key cannot certify readiness', async () => {
  const data = schema(true); data.indexes = data.indexes.filter(row => row.TABLE_NAME !== 'workflow_schema_versions');
  await assert.rejects(migration.buildPlan(executor(data)), /primary key/);
});
for (const name of ['blood_management', 'production', 'blood_management_copy', 'lifesaver_v2_test_', 'lifesaver_v2_test_x;DROP']) {
  test('apply rejects non-isolated database ' + name, async () => {
    const database = executor(schema(), { database: name });
    await assert.rejects(migration.migrate(database, { confirmIsolated: true }), /isolated/);
    assert.equal(database.calls.length, 1);
  });
}
test('isolated apply still requires explicit confirmation', async () => {
  const database = executor(); await assert.rejects(migration.migrate(database), /confirmed isolated/); assert.equal(database.calls.length, 1);
});
test('successful isolated apply verifies then writes marker, never activates runtime', async () => {
  const database = executor(schema(), { completeAfterDDL: true });
  const result = await migration.migrate(database, { confirmIsolated: true });
  assert.equal(result.activated, false); assert.equal(result.historyBackfills, 0);
  assert.equal(database.calls.at(-1).sql.startsWith('INSERT INTO workflow_schema_versions'), true);
  assert.deepEqual(database.calls.at(-1).values, [2]);
  assert.ok(database.calls.every(call => !/^UPDATE|^DELETE|^DROP/.test(call.sql)));
});
test('DDL failure does not write activation marker', async () => {
  const database = executor(schema(), { failDDL: true });
  await assert.rejects(migration.migrate(database, { confirmIsolated: true }), /fixture DDL failure/);
  assert.ok(database.calls.every(call => !call.sql.startsWith('INSERT')));
});
test('incomplete post-DDL schema does not write activation marker', async () => {
  const database = executor();
  await assert.rejects(migration.migrate(database, { confirmIsolated: true }), /verification did not complete/);
  assert.ok(database.calls.every(call => !call.sql.startsWith('INSERT')));
});
