// Schema inspect karke sirf missing integration fields add honge.
async function migrate(pool) {
  const [columns] = await pool.execute(
    'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE()'
  );
  const fields = new Map(columns.map((row) => [row.TABLE_NAME + '.' + row.COLUMN_NAME, row.COLUMN_TYPE]));
  const changes = [];
  if (!fields.has('blood_banks.password_hash')) {
    await pool.execute('ALTER TABLE blood_banks ADD COLUMN password_hash VARCHAR(255) NULL DEFAULT NULL');
    changes.push('blood_banks.password_hash');
  } else if (fields.get('blood_banks.password_hash') !== 'varchar(255)') {
    throw new Error('Existing bank credential column has an unexpected type.');
  }
  if (!fields.has('blood_requests.bank_id')) {
    const [rows] = await pool.execute('SELECT COUNT(*) AS total FROM blood_requests');
    // Purane unassigned requests preserve honge; new API requests mein bank required hai.
    const nullable = rows[0].total > 0 ? 'NULL DEFAULT NULL' : 'NOT NULL';
    await pool.execute('ALTER TABLE blood_requests ADD COLUMN bank_id INT ' + nullable);
    changes.push('blood_requests.bank_id');
  } else if (fields.get('blood_requests.bank_id') !== 'int') {
    throw new Error('Existing request bank column has an unexpected type.');
  }
  const [keys] = await pool.execute(
    "SELECT REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'blood_requests' AND COLUMN_NAME = 'bank_id' AND REFERENCED_TABLE_NAME IS NOT NULL"
  );
  if (keys.length === 0) {
    await pool.execute('ALTER TABLE blood_requests ADD CONSTRAINT fk_request_bank FOREIGN KEY (bank_id) REFERENCES blood_banks(bank_id)');
    changes.push('fk_request_bank');
  } else if (!keys.some((row) => row.REFERENCED_TABLE_NAME === 'blood_banks' && row.REFERENCED_COLUMN_NAME === 'bank_id')) {
    throw new Error('Existing request bank relationship conflicts with this workflow.');
  }
  if (!fields.has('blood_requests.donor_matching_started_at')) {
    await pool.execute('ALTER TABLE blood_requests ADD COLUMN donor_matching_started_at TIMESTAMP NULL DEFAULT NULL');
    changes.push('blood_requests.donor_matching_started_at');
  } else if (fields.get('blood_requests.donor_matching_started_at') !== 'timestamp') {
    throw new Error('Existing matching marker has an unexpected type.');
  }
  if (!fields.has('donor_responses.request_id')) {
    await pool.execute(
      "CREATE TABLE donor_responses (request_id INT NOT NULL, donor_id INT NOT NULL, response ENUM('Accepted','Declined') NOT NULL, responded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (request_id, donor_id), CONSTRAINT fk_response_request FOREIGN KEY (request_id) REFERENCES blood_requests(request_id), CONSTRAINT fk_response_donor FOREIGN KEY (donor_id) REFERENCES donors(donor_id)) ENGINE=InnoDB"
    );
    changes.push('donor_responses');
  } else {
    for (const [name, type] of [['request_id', 'int'], ['donor_id', 'int'], ['response', "enum('Accepted','Declined')"], ['responded_at', 'timestamp']]) {
      if (fields.get('donor_responses.' + name) !== type) throw new Error('Existing donor response schema conflicts with this workflow.');
    }
  }
  const [legacy] = await pool.execute('SELECT COUNT(*) AS total FROM blood_requests WHERE bank_id IS NULL');
  return { changes, legacyUnassignedRequests: legacy[0].total };
}
module.exports = { migrate };
if (require.main === module) {
  const pool = require('../db');
  migrate(pool).then((result) => console.log(JSON.stringify(result))).catch((error) => {
    // Credentials aur raw SQL error output mein nahi jayega.
    console.error('Migration stopped: ' + (error.code || error.message));
    process.exitCode = 1;
  }).finally(() => pool.end());
}
