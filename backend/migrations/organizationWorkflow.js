// Explicit, repeatable migration for the organization and clinical workflow.
// MySQL DDL commits implicitly. A reviewed backup is required before --apply.
const requiredTables = ['blood_banks', 'donors', 'recipients', 'blood_requests', 'blood_inventory', 'donations', 'request_allocations', 'donor_responses'];

async function inspectSchema(pool) {
  const [tables] = await pool.execute('SELECT TABLE_NAME, ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  const [columns] = await pool.execute('SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()');
  const [indexes] = await pool.execute('SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE()');
  const [keys] = await pool.execute('SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IS NOT NULL');
  const [checks] = await pool.execute("SELECT tc.TABLE_NAME, tc.CONSTRAINT_NAME, cc.CHECK_CLAUSE FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.CONSTRAINT_SCHEMA = DATABASE() AND tc.CONSTRAINT_TYPE = 'CHECK'");
  return { tables, columns, indexes, keys, checks };
}

function fieldMap(schema) {
  return new Map(schema.columns.map(row => [row.TABLE_NAME + '.' + row.COLUMN_NAME, row]));
}

function hasUnique(schema, table, columns) {
  const indexes = new Map();
  for (const row of schema.indexes) {
    if (row.TABLE_NAME !== table || Number(row.NON_UNIQUE) !== 0) continue;
    if (!indexes.has(row.INDEX_NAME)) indexes.set(row.INDEX_NAME, []);
    indexes.get(row.INDEX_NAME).push(row);
  }
  return [...indexes.values()].some(rows => {
    const names = rows.sort((a, b) => a.SEQ_IN_INDEX - b.SEQ_IN_INDEX).map(row => row.COLUMN_NAME);
    return names.length === columns.length && names.every((name, index) => name === columns[index]);
  });
}

async function assertNoDuplicates(pool, table, column) {
  const [rows] = await pool.execute(
    'SELECT COUNT(*) AS total FROM ' + table + ' WHERE ' + column + ' IS NOT NULL GROUP BY ' + column + ' HAVING COUNT(*) > 1 LIMIT 1'
  );
  if (rows.length) throw new Error('Existing ' + table + ' ' + column + ' duplicates require manual review; no records were merged or deleted.');
}

async function buildPlan(pool) {
  const schema = await inspectSchema(pool);
  const fields = fieldMap(schema);
  const tables = new Set(schema.tables.map(row => row.TABLE_NAME));
  for (const table of requiredTables) {
    if (!tables.has(table)) throw new Error('Required integration table is missing: ' + table);
    if (!schema.tables.some(row => row.TABLE_NAME === table && row.ENGINE === 'InnoDB')) {
      throw new Error('Required integration table must use InnoDB: ' + table);
    }
  }
  for (const name of ['blood_banks.bank_id', 'blood_banks.password_hash', 'request_allocations.donation_id', 'blood_requests.bank_id', 'donor_responses.request_id']) {
    if (!fields.has(name)) throw new Error('Run the existing blood bank integration migration first; missing ' + name);
  }
  const organizationExists = tables.has('organizations');
  if (organizationExists && !schema.tables.some(row => row.TABLE_NAME === 'organizations' && row.ENGINE === 'InnoDB')) {
    throw new Error('organizations must use InnoDB.');
  }
  const mappingExists = fields.has('blood_banks.organization_id');
  if (mappingExists && !organizationExists) throw new Error('An organization mapping exists without its account table.');

  // Duplicates stop the migration before any DDL. Never delete or merge account records.
  for (const column of ['phone', 'email']) {
    await assertNoDuplicates(pool, 'recipients', column);
    if (organizationExists) {
      const where = mappingExists ? ' WHERE organization_id IS NULL' : '';
      const [rows] = await pool.execute(
        'SELECT COUNT(*) AS total FROM (SELECT ' + column + ' AS identifier FROM organizations UNION ALL SELECT ' + column + ' AS identifier FROM blood_banks' + where + ') AS account_identifiers WHERE identifier IS NOT NULL GROUP BY identifier HAVING COUNT(*) > 1 LIMIT 1'
      );
      if (rows.length) throw new Error('Existing organization/blood bank ' + column + ' duplicates require manual review.');
    } else {
      await assertNoDuplicates(pool, 'blood_banks', column);
    }
  }

  const steps = [];
  const addStep = (label, sql) => steps.push({ label, sql });
  if (!organizationExists) {
    addStep('organizations', "CREATE TABLE organizations (organization_id INT NOT NULL AUTO_INCREMENT, organization_type ENUM('Hospital','Blood Bank','NGO') NOT NULL, name VARCHAR(100) NOT NULL, state VARCHAR(100) NULL DEFAULT NULL, city VARCHAR(100) NULL DEFAULT NULL, address VARCHAR(255) NOT NULL, phone VARCHAR(15) NULL DEFAULT NULL, email VARCHAR(100) NULL DEFAULT NULL, password_hash VARCHAR(255) NULL DEFAULT NULL, created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (organization_id), UNIQUE KEY uq_organization_phone (phone), UNIQUE KEY uq_organization_email (email)) ENGINE=InnoDB");
  } else {
    const expected = { organization_id: 'int', organization_type: "enum('Hospital','Blood Bank','NGO')", name: 'varchar(100)', state: 'varchar(100)', city: 'varchar(100)', address: 'varchar(255)', phone: 'varchar(15)', email: 'varchar(100)', password_hash: 'varchar(255)', created_at: 'timestamp' };
    for (const [name, type] of Object.entries(expected)) {
      if (fields.get('organizations.' + name)?.COLUMN_TYPE !== type) throw new Error('Existing organizations schema conflicts at ' + name + '.');
    }
    if (!hasUnique(schema, 'organizations', ['phone'])) addStep('uq_organization_phone', 'ALTER TABLE organizations ADD UNIQUE KEY uq_organization_phone (phone)');
    if (!hasUnique(schema, 'organizations', ['email'])) addStep('uq_organization_email', 'ALTER TABLE organizations ADD UNIQUE KEY uq_organization_email (email)');
  }

  function addColumn(table, name, type, definition) {
    const current = fields.get(table + '.' + name);
    if (current && current.COLUMN_TYPE !== type) throw new Error('Existing workflow column has an unexpected type: ' + table + '.' + name);
    if (!current) addStep(table + '.' + name, 'ALTER TABLE ' + table + ' ADD COLUMN ' + name + ' ' + definition);
  }
  function addForeignKey(table, column, parent, parentColumn, name) {
    const existing = schema.keys.filter(row => row.TABLE_NAME === table && row.COLUMN_NAME === column);
    if (existing.length && !existing.some(row => row.REFERENCED_TABLE_NAME === parent && row.REFERENCED_COLUMN_NAME === parentColumn)) {
      throw new Error('Existing workflow foreign key conflicts: ' + table + '.' + column);
    }
    if (!existing.length) addStep(name, 'ALTER TABLE ' + table + ' ADD CONSTRAINT ' + name + ' FOREIGN KEY (' + column + ') REFERENCES ' + parent + '(' + parentColumn + ')');
  }

  addColumn('blood_banks', 'organization_id', 'int', 'INT NULL DEFAULT NULL');
  if (!hasUnique(schema, 'blood_banks', ['organization_id'])) addStep('uq_bank_organization', 'ALTER TABLE blood_banks ADD UNIQUE KEY uq_bank_organization (organization_id)');
  addForeignKey('blood_banks', 'organization_id', 'organizations', 'organization_id', 'fk_bank_organization');
  for (const table of ['donors', 'blood_requests']) {
    addColumn(table, 'state', 'varchar(100)', 'VARCHAR(100) NULL DEFAULT NULL');
    addColumn(table, 'city', 'varchar(100)', 'VARCHAR(100) NULL DEFAULT NULL');
  }
  addColumn('blood_requests', 'organization_id', 'int', 'INT NULL DEFAULT NULL');
  addForeignKey('blood_requests', 'organization_id', 'organizations', 'organization_id', 'fk_request_organization');
  addColumn('donor_responses', 'screening_result', "enum('Passed','Failed')", "ENUM('Passed','Failed') NULL DEFAULT NULL");
  addColumn('donor_responses', 'screened_at', 'timestamp', 'TIMESTAMP NULL DEFAULT NULL');
  addColumn('donor_responses', 'screened_by_organization_id', 'int', 'INT NULL DEFAULT NULL');
  addForeignKey('donor_responses', 'screened_by_organization_id', 'organizations', 'organization_id', 'fk_screening_organization');
  const screeningCheck = schema.checks.find(row => row.TABLE_NAME === 'donor_responses' && row.CONSTRAINT_NAME === 'chk_screening_consistency');
  const screeningExpression = "(screening_result IS NULL AND screened_at IS NULL AND screened_by_organization_id IS NULL) OR (response = 'Accepted' AND screening_result IS NOT NULL AND screened_at IS NOT NULL AND screened_by_organization_id IS NOT NULL)";
  const normalizeScreeningCheck = value => value.replace(/\\'/g, "'").replace(/_utf8mb[34](?=')/gi, '').replace(/[()\x60\s]/g, '').toLowerCase();
  if (screeningCheck && normalizeScreeningCheck(screeningCheck.CHECK_CLAUSE) !== normalizeScreeningCheck(screeningExpression)) {
    throw new Error('Existing screening metadata constraint conflicts with this workflow.');
  }
  if (!screeningCheck) {
    const result = fields.has('donor_responses.screening_result') ? 'screening_result' : 'NULL';
    const at = fields.has('donor_responses.screened_at') ? 'screened_at' : 'NULL';
    const by = fields.has('donor_responses.screened_by_organization_id') ? 'screened_by_organization_id' : 'NULL';
    const [invalid] = await pool.execute('SELECT COUNT(*) AS total FROM donor_responses WHERE NOT ((' + result + ' IS NULL AND ' + at + ' IS NULL AND ' + by + " IS NULL) OR (response = 'Accepted' AND " + result + ' IS NOT NULL AND ' + at + ' IS NOT NULL AND ' + by + ' IS NOT NULL))');
    if (Number(invalid[0].total) !== 0) throw new Error('Existing screening metadata is incomplete or belongs to a non-accepted response; manual review is required.');
    addStep('chk_screening_consistency', 'ALTER TABLE donor_responses ADD CONSTRAINT chk_screening_consistency CHECK (' + screeningExpression + ')');
  }
  addColumn('blood_inventory', 'version', 'bigint unsigned', 'BIGINT UNSIGNED NOT NULL DEFAULT 0');

  const donation = fields.get('request_allocations.donation_id');
  if (donation.COLUMN_TYPE !== 'int') throw new Error('Existing allocation donation_id has an unexpected type.');
  if (donation.IS_NULLABLE !== 'YES') addStep('request_allocations.donation_id nullable', 'ALTER TABLE request_allocations MODIFY COLUMN donation_id INT NULL DEFAULT NULL');
  addColumn('request_allocations', 'inventory_id', 'int', 'INT NULL DEFAULT NULL');
  addColumn('request_allocations', 'operation_key', 'varchar(64)', 'VARCHAR(64) NULL DEFAULT NULL');
  addForeignKey('request_allocations', 'inventory_id', 'blood_inventory', 'inventory_id', 'fk_allocation_inventory');
  if (!hasUnique(schema, 'request_allocations', ['request_id', 'operation_key'])) {
    if (fields.has('request_allocations.operation_key')) {
      const [duplicates] = await pool.execute('SELECT COUNT(*) AS total FROM request_allocations WHERE operation_key IS NOT NULL GROUP BY request_id, operation_key HAVING COUNT(*) > 1 LIMIT 1');
      if (duplicates.length) throw new Error('Existing allocation operation keys are duplicated; manual review is required.');
    }
    addStep('uq_request_operation', 'ALTER TABLE request_allocations ADD UNIQUE KEY uq_request_operation (request_id, operation_key)');
  }
  const sourceCheck = schema.checks.find(row => row.TABLE_NAME === 'request_allocations' && row.CONSTRAINT_NAME === 'chk_allocation_one_source');
  const normalizeCheck = value => value.replace(/[()`\s]/g, '').toLowerCase();
  const expectedCheck = 'donation_id IS NOT NULL AND inventory_id IS NULL OR donation_id IS NULL AND inventory_id IS NOT NULL';
  if (sourceCheck && normalizeCheck(sourceCheck.CHECK_CLAUSE) !== normalizeCheck(expectedCheck)) {
    throw new Error('Existing allocation source constraint conflicts with this workflow.');
  }
  if (!sourceCheck) {
    const inventoryPresent = fields.has('request_allocations.inventory_id');
    const invalid = inventoryPresent ? '(donation_id IS NULL AND inventory_id IS NULL) OR (donation_id IS NOT NULL AND inventory_id IS NOT NULL)' : 'donation_id IS NULL';
    const [rows] = await pool.execute('SELECT COUNT(*) AS total FROM request_allocations WHERE ' + invalid);
    if (Number(rows[0].total) !== 0) throw new Error('Existing allocation sources are invalid; manual review is required.');
    addStep('chk_allocation_one_source', 'ALTER TABLE request_allocations ADD CONSTRAINT chk_allocation_one_source CHECK ((donation_id IS NOT NULL AND inventory_id IS NULL) OR (donation_id IS NULL AND inventory_id IS NOT NULL))');
  }
  for (const column of ['phone', 'email']) {
    if (!hasUnique(schema, 'recipients', [column])) addStep('uq_recipient_' + column, 'ALTER TABLE recipients ADD UNIQUE KEY uq_recipient_' + column + ' (' + column + ')');
  }
  return { steps, organizationExists, mappingExists };
}

async function migrate(pool) {
  const plan = await buildPlan(pool);
  const changes = [];
  for (const step of plan.steps) {
    await pool.execute(step.sql);
    changes.push(step.label);
  }
  let connection;
  let migratedBanks = 0;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [banks] = await connection.execute('SELECT bank_id, bank_name, address, phone, email, password_hash, created_at FROM blood_banks WHERE organization_id IS NULL ORDER BY bank_id FOR UPDATE');
    for (const bank of banks) {
      // Copy only genuine account data. Unknown locations stay NULL; old bank columns are untouched.
      const [organization] = await connection.execute(
        "INSERT INTO organizations (organization_type, name, state, city, address, phone, email, password_hash, created_at) VALUES ('Blood Bank', ?, NULL, NULL, ?, ?, ?, ?, ?)",
        [bank.bank_name, bank.address, bank.phone, bank.email, bank.password_hash, bank.created_at]
      );
      await connection.execute('UPDATE blood_banks SET organization_id = ? WHERE bank_id = ? AND organization_id IS NULL', [organization.insertId, bank.bank_id]);
      migratedBanks++;
    }
    await connection.commit();
  } catch (error) {
    if (connection) {
      try { await connection.rollback(); }
      catch { connection.destroy(); connection = null; }
    }
    throw error;
  } finally {
    if (connection) connection.release();
  }
  const [legacyOrganizations] = await pool.execute('SELECT COUNT(*) AS total FROM organizations WHERE state IS NULL OR city IS NULL');
  const [legacyRequests] = await pool.execute('SELECT COUNT(*) AS total FROM blood_requests WHERE organization_id IS NULL OR state IS NULL OR city IS NULL');
  return { changes, migratedBanks, organizationsNeedingLocation: Number(legacyOrganizations[0].total),
    historicalRequestsWithoutLocationSnapshots: Number(legacyRequests[0].total) };
}

module.exports = { inspectSchema, buildPlan, migrate };
if (require.main === module) {
  const pool = require('../db');
  const mode = process.argv[2] || '--plan';
  Promise.resolve().then(async () => {
    if (process.env.DB_NAME !== 'blood_management') throw new Error('Expected DB_NAME=blood_management. Migration stopped.');
    if (!['--plan', '--apply'].includes(mode) || process.argv.length > 3) throw new Error('Usage: node migrations/organizationWorkflow.js [--plan|--apply]');
    const result = mode === '--apply' ? await migrate(pool) : await buildPlan(pool);
    console.log(JSON.stringify(result, null, 2));
  }).catch(error => {
    // Raw driver messages can contain identifiers, SQL, or secrets.
    console.error('Organization migration stopped: ' + (error.code || error.message));
    process.exitCode = 1;
  }).finally(() => pool.end());
}


