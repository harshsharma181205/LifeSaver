// Plan pehle dekho. DDL implicit commit karti hai; history backfill nahi hogi.
const baseTables = ['organizations', 'blood_banks', 'blood_requests', 'donors', 'donor_responses', 'donations', 'blood_inventory', 'request_allocations'];
const additions = [
  ['blood_requests', 'workflow_version', 'tinyint unsigned', 'TINYINT UNSIGNED NOT NULL DEFAULT 1'],
  ['blood_requests', 'admission_hospital_id', 'int', 'INT NULL DEFAULT NULL'],
  ['donor_responses', 'collecting_bank_id', 'int', 'INT NULL DEFAULT NULL'],
  ['request_allocations', 'actor_bank_id', 'int', 'INT NULL DEFAULT NULL'],
  ['request_allocations', 'collection_id', 'int', 'INT NULL DEFAULT NULL'],
];
const newTables = {
  donor_collections: {
    columns: { collection_id: 'int', request_id: 'int', donor_id: 'int', bank_id: 'int', donation_id: 'int',
      accounting_path: "enum('DirectRequest','Inventory')", inventory_id: 'int', units_collected: 'int', operation_key: 'char(36)', collected_at: 'timestamp' },
    sql: "CREATE TABLE donor_collections (collection_id INT NOT NULL AUTO_INCREMENT, request_id INT NOT NULL, donor_id INT NOT NULL, bank_id INT NOT NULL, donation_id INT NOT NULL, accounting_path ENUM('DirectRequest','Inventory') NOT NULL, inventory_id INT NULL DEFAULT NULL, units_collected INT NOT NULL, operation_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, collected_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (collection_id), UNIQUE KEY uq_collection_donor_event (request_id, donor_id), UNIQUE KEY uq_collection_donation (donation_id), UNIQUE KEY uq_collection_operation (request_id, operation_key), CONSTRAINT fk_collection_response FOREIGN KEY (request_id, donor_id) REFERENCES donor_responses(request_id, donor_id) ON DELETE RESTRICT, CONSTRAINT fk_collection_bank FOREIGN KEY (bank_id) REFERENCES blood_banks(bank_id) ON DELETE RESTRICT, CONSTRAINT fk_collection_donation FOREIGN KEY (donation_id) REFERENCES donations(donation_id) ON DELETE RESTRICT, CONSTRAINT fk_collection_inventory FOREIGN KEY (inventory_id) REFERENCES blood_inventory(inventory_id) ON DELETE RESTRICT, CONSTRAINT chk_collection_positive CHECK (units_collected > 0), CONSTRAINT chk_collection_accounting CHECK ((accounting_path = 'DirectRequest' AND inventory_id IS NULL) OR (accounting_path = 'Inventory' AND inventory_id IS NOT NULL))) ENGINE=InnoDB",
  },
  workflow_notifications: {
    columns: { notification_id: 'int', audience_type: "enum('donor','recipient','organization','blood_bank')", audience_id: 'int',
      request_id: 'int', event_key: 'varchar(100)', message: 'varchar(500)', is_read: 'tinyint(1)', sent_at: 'timestamp' },
    sql: "CREATE TABLE workflow_notifications (notification_id INT NOT NULL AUTO_INCREMENT, audience_type ENUM('donor','recipient','organization','blood_bank') NOT NULL, audience_id INT NOT NULL, request_id INT NOT NULL, event_key VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL, message VARCHAR(500) NOT NULL, is_read BOOLEAN NOT NULL DEFAULT FALSE, sent_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (notification_id), UNIQUE KEY uq_workflow_notification_event (audience_type, audience_id, event_key), KEY ix_workflow_inbox (audience_type, audience_id, sent_at, notification_id), CONSTRAINT fk_workflow_notification_request FOREIGN KEY (request_id) REFERENCES blood_requests(request_id) ON DELETE RESTRICT, CONSTRAINT chk_workflow_audience CHECK (audience_id > 0)) ENGINE=InnoDB",
  },
  workflow_schema_versions: {
    columns: { version: 'tinyint unsigned', applied_at: 'timestamp' },
    sql: 'CREATE TABLE workflow_schema_versions (version TINYINT UNSIGNED NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (version)) ENGINE=InnoDB',
  },
};

async function inspectSchema(executor) {
  const [tables] = await executor.execute('SELECT TABLE_NAME, ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  const [columns] = await executor.execute('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, CHARACTER_SET_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
  const [indexes] = await executor.execute('SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE()');
  const [keys] = await executor.execute('SELECT k.CONSTRAINT_NAME, k.TABLE_NAME, k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL');
  const [checks] = await executor.execute("SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, tc.ENFORCED, cc.CHECK_CLAUSE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'");
  return { tables, columns, indexes, keys, checks };
}

function normalizeCheck(value) { return String(value).replace(/\\'/g, "'").replace(/_(?:utf8mb4|utf8mb3|utf8|ascii|latin1)(?=')/gi, '').replace(/[()`\s]/g, '').toLowerCase(); }
function hasIndex(schema, table, names, unique) {
  const indexes = new Map();
  for (const row of schema.indexes) {
    if (row.TABLE_NAME !== table || (unique && Number(row.NON_UNIQUE) !== 0)) continue;
    if (!indexes.has(row.INDEX_NAME)) indexes.set(row.INDEX_NAME, []);
    indexes.get(row.INDEX_NAME)[Number(row.SEQ_IN_INDEX) - 1] = row.COLUMN_NAME;
  }
  return [...indexes.values()].some(columns => columns.length === names.length && names.every((name, i) => name === columns[i]));
}

async function buildPlan(executor) {
  const schema = await inspectSchema(executor);
  const tables = new Map(schema.tables.map(row => [row.TABLE_NAME, row]));
  const fields = new Map(schema.columns.map(row => [row.TABLE_NAME + '.' + row.COLUMN_NAME, row]));
  for (const table of baseTables) {
    if (!tables.has(table) || tables.get(table).ENGINE !== 'InnoDB') throw new Error('Required InnoDB workflow table is missing: ' + table);
  }
  for (const key of ['blood_requests.request_id', 'blood_requests.bank_id', 'blood_requests.organization_id',
    'donor_responses.request_id', 'donor_responses.donor_id', 'donor_responses.screening_result', 'donor_responses.screened_by_organization_id',
    'blood_inventory.inventory_id', 'blood_inventory.version', 'request_allocations.inventory_id', 'request_allocations.operation_key',
    'organizations.organization_type', 'blood_banks.organization_id']) {
    if (!fields.has(key)) throw new Error('Existing organization workflow schema is incomplete: ' + key);
  }
  if (!hasIndex(schema, 'donor_responses', ['request_id', 'donor_id'], true) ||
      !hasIndex(schema, 'request_allocations', ['request_id', 'operation_key'], true)) {
    throw new Error('Existing donor response/operation uniqueness must be reviewed first.');
  }
  const steps = [];
  const add = (label, sql) => steps.push({ label, sql });
  for (const [table, column, type, definition] of additions) {
    const existing = fields.get(table + '.' + column);
    if (existing) {
      if (existing.COLUMN_TYPE !== type) {
        throw new Error('Conflicting V2 column: ' + table + '.' + column);
      }
      if (column === 'workflow_version' && (existing.IS_NULLABLE !== 'NO' || String(existing.COLUMN_DEFAULT) !== '1')) {
        throw new Error('workflow_version must preserve V1 as its non-null default.');
      }
      if (column !== 'workflow_version' && existing.IS_NULLABLE !== 'YES') throw new Error('Legacy-compatible V2 column must remain nullable: ' + table + '.' + column);
    } else add(table + '.' + column, 'ALTER TABLE ' + table + ' ADD COLUMN ' + column + ' ' + definition);
  }
  for (const [table, definition] of Object.entries(newTables)) {
    if (!tables.has(table)) { add(table, definition.sql); continue; }
    if (tables.get(table).ENGINE !== 'InnoDB') throw new Error('V2 table must use InnoDB: ' + table);
    for (const [column, type] of Object.entries(definition.columns)) {
      const current = fields.get(table + '.' + column);
      if (current?.COLUMN_TYPE !== type || current.IS_NULLABLE !== (column === 'inventory_id' ? 'YES' : 'NO')) {
        throw new Error('Existing V2 table conflicts at ' + table + '.' + column);
      }
      if (((table === 'donor_collections' && column === 'operation_key') ||
          (table === 'workflow_notifications' && column === 'event_key')) && current.CHARACTER_SET_NAME !== 'ascii') {
        throw new Error('V2 operation/event identity must use ASCII storage.');
      }
    }
    const primary = table === 'donor_collections' ? 'collection_id' : table === 'workflow_notifications' ? 'notification_id' : 'version';
    const primaryRows = schema.indexes.filter(row => row.TABLE_NAME === table && row.INDEX_NAME === 'PRIMARY');
    if (primaryRows.length !== 1 || primaryRows[0].COLUMN_NAME !== primary) throw new Error('V2 primary key conflicts at ' + table);
  }
  const foreignKey = (table, columns, parent, parentColumns, name) => {
    if (newTables[table] && !tables.has(table)) return;
    const rows = schema.keys.filter(row => row.TABLE_NAME === table && columns.includes(row.COLUMN_NAME));
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.CONSTRAINT_NAME)) groups.set(row.CONSTRAINT_NAME, []);
      groups.get(row.CONSTRAINT_NAME)[Number(row.ORDINAL_POSITION) - 1] = row;
    }
    const matches = [...groups.values()].some(group => group.length === columns.length && columns.every((column, index) =>
      group[index]?.COLUMN_NAME === column && group[index].REFERENCED_TABLE_NAME === parent &&
      group[index].REFERENCED_COLUMN_NAME === parentColumns[index] && ['RESTRICT', 'NO ACTION'].includes(group[index].DELETE_RULE)));
    if (rows.length && !matches) {
      throw new Error('Conflicting V2 foreign key at ' + table + '.' + columns.join(','));
    }
    if (!rows.length) add(name, 'ALTER TABLE ' + table + ' ADD CONSTRAINT ' + name + ' FOREIGN KEY (' + columns.join(', ') + ') REFERENCES ' + parent + '(' + parentColumns.join(', ') + ') ON DELETE RESTRICT');
  };
  foreignKey('blood_requests', ['admission_hospital_id'], 'organizations', ['organization_id'], 'fk_request_admission_hospital');
  foreignKey('donor_responses', ['collecting_bank_id'], 'blood_banks', ['bank_id'], 'fk_response_collecting_bank');
  foreignKey('request_allocations', ['actor_bank_id'], 'blood_banks', ['bank_id'], 'fk_allocation_actor_bank');
  foreignKey('request_allocations', ['collection_id'], 'donor_collections', ['collection_id'], 'fk_allocation_collection');
  foreignKey('donor_collections', ['request_id', 'donor_id'], 'donor_responses', ['request_id', 'donor_id'], 'fk_collection_response');
  foreignKey('donor_collections', ['bank_id'], 'blood_banks', ['bank_id'], 'fk_collection_bank');
  foreignKey('donor_collections', ['donation_id'], 'donations', ['donation_id'], 'fk_collection_donation');
  foreignKey('donor_collections', ['inventory_id'], 'blood_inventory', ['inventory_id'], 'fk_collection_inventory');
  foreignKey('workflow_notifications', ['request_id'], 'blood_requests', ['request_id'], 'fk_workflow_notification_request');
  const index = (table, columns, unique, name) => {
    if (newTables[table] && !tables.has(table)) return;
    if (!hasIndex(schema, table, columns, unique)) add(name, 'ALTER TABLE ' + table + ' ADD ' + (unique ? 'UNIQUE ' : '') + 'KEY ' + name + ' (' + columns.join(', ') + ')');
  };
  index('request_allocations', ['collection_id'], true, 'uq_allocation_collection');
  index('blood_requests', ['workflow_version', 'status', 'state', 'city', 'request_date', 'request_id'], false, 'ix_city_request_queue');
  index('blood_requests', ['admission_hospital_id', 'request_date', 'request_id'], false, 'ix_admission_requests');
  index('organizations', ['organization_type', 'state', 'city'], false, 'ix_organization_city');
  index('donors', ['state', 'city', 'blood_group', 'is_available'], false, 'ix_donor_city_group');
  index('donor_responses', ['collecting_bank_id', 'request_id'], false, 'ix_collection_work');
  index('donor_collections', ['request_id', 'donor_id'], true, 'uq_collection_donor_event');
  index('donor_collections', ['donation_id'], true, 'uq_collection_donation');
  index('donor_collections', ['request_id', 'operation_key'], true, 'uq_collection_operation');
  index('workflow_notifications', ['audience_type', 'audience_id', 'event_key'], true, 'uq_workflow_notification_event');
  index('workflow_notifications', ['audience_type', 'audience_id', 'sent_at', 'notification_id'], false, 'ix_workflow_inbox');
  const check = (table, name, expression) => {
    if (newTables[table] && !tables.has(table)) return;
    const current = schema.checks.find(row => row.TABLE_NAME === table && row.CONSTRAINT_NAME === name);
    if (current && normalizeCheck(current.CHECK_CLAUSE) !== normalizeCheck(expression)) throw new Error('Conflicting V2 CHECK: ' + name);
    if (current && current.ENFORCED !== 'YES') throw new Error('V2 CHECK must be enforced: ' + name);
    if (!current) add(name, 'ALTER TABLE ' + table + ' ADD CONSTRAINT ' + name + ' CHECK (' + expression + ')');
  };
  check('blood_requests', 'chk_workflow_version', 'workflow_version IN (1, 2)');
  check('blood_requests', 'chk_admission_v2', 'workflow_version = 1 OR (admission_hospital_id IS NOT NULL AND bank_id IS NULL AND organization_id IS NULL)');
  check('donor_responses', 'chk_collecting_bank_response', "collecting_bank_id IS NULL OR response = 'Accepted'");
  check('request_allocations', 'chk_collection_credit_source', 'collection_id IS NULL OR (donation_id IS NOT NULL AND inventory_id IS NULL)');
  check('donor_collections', 'chk_collection_positive', 'units_collected > 0');
  check('donor_collections', 'chk_collection_accounting', "(accounting_path = 'DirectRequest' AND inventory_id IS NULL) OR (accounting_path = 'Inventory' AND inventory_id IS NOT NULL)");
  check('workflow_notifications', 'chk_workflow_audience', 'audience_id > 0');
  return { version: 2, steps, historyBackfills: 0, warning: 'DDL commits implicitly. Existing request/donation/allocation rows are not rewritten. V2 remains disabled until explicitly activated.' };
}

async function assertIsolated(executor, options) {
  const [rows] = await executor.execute('SELECT DATABASE() AS database_name');
  const name = rows[0]?.database_name;
  if (options?.confirmIsolated !== true || typeof name !== 'string' || !/^lifesaver_v2_test_[a-z0-9_]+$/i.test(name)) {
    throw new Error('Apply is restricted to an explicitly confirmed isolated lifesaver_v2_test_* database.');
  }
  return name;
}

async function migrate(executor, options = {}) {
  const database = await assertIsolated(executor, options);
  const plan = await buildPlan(executor);
  for (const step of plan.steps) await executor.execute(step.sql);
  // Marker sirf complete schema ke baad set hoga.
  const remaining = await buildPlan(executor);
  if (remaining.steps.length) throw new Error('V2 schema verification did not complete; activation marker was not written.');
  await executor.execute('INSERT INTO workflow_schema_versions (version) VALUES (?) ON DUPLICATE KEY UPDATE version = VALUES(version)', [2]);
  return { version: 2, database, changes: plan.steps.map(step => step.label), historyBackfills: 0, activated: false };
}

module.exports = { inspectSchema, buildPlan, migrate, assertIsolated };
if (require.main === module) {
  const pool = require('../db');
  const mode = process.argv[2] || '--plan';
  Promise.resolve().then(async () => {
    if (process.argv.length > 3 || !['--plan', '--apply'].includes(mode)) throw new Error('Use --plan or --apply. Apply requires an isolated database.');
    const result = mode === '--apply' ? await migrate(pool, { confirmIsolated: process.env.LIFESAVER_ISOLATED_TEST_DB === 'true' }) : await buildPlan(pool);
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    console.error('City-wide migration stopped: ' + (error.code || error.message));
    process.exitCode = 1;
  }).finally(() => pool.end());
}
