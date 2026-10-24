const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const pool = require('../db');

const originalExecute = pool.execute;
const originalListen = express.application.listen;
const originalPort = process.env.PORT;
const populatedData = {
  "organizations": [],
  "donors": [
    {
      "donor_id": 1,
      "blood_group": "O+",
      "is_available": 1,
      "location": "Mumbai"
    },
    {
      "donor_id": 2,
      "blood_group": "O+",
      "is_available": 0,
      "location": " Mumbai "
    },
    {
      "donor_id": 3,
      "blood_group": "A+",
      "is_available": 1,
      "location": null
    },
    {
      "donor_id": 4,
      "blood_group": "A+",
      "is_available": 1,
      "location": "  "
    },
    {
      "donor_id": 5,
      "blood_group": "AB-",
      "is_available": 2,
      "location": "Delhi"
    }
  ],
  "recipients": [
    {
      "recipient_id": 1
    },
    {
      "recipient_id": 2
    }
  ],
  "blood_requests": [
    {
      "request_id": 1,
      "blood_group": "O+",
      "units_required": 2,
      "request_date": "2026-01-01 00:00:00",
      "status": "Pending",
      "urgency_level": "Normal"
    },
    {
      "request_id": 2,
      "blood_group": "A+",
      "units_required": 1,
      "request_date": "2026-01-03 00:00:00",
      "status": "Processing",
      "urgency_level": "Emergency"
    },
    {
      "request_id": 3,
      "blood_group": "O+",
      "units_required": 3,
      "request_date": "2026-01-02 00:00:00",
      "status": "Fulfilled",
      "urgency_level": "Emergency"
    },
    {
      "request_id": 4,
      "blood_group": "B+",
      "units_required": 4,
      "request_date": "2026-01-04 00:00:00",
      "status": "Cancelled",
      "urgency_level": "Normal"
    },
    {
      "request_id": 5,
      "blood_group": "O+",
      "units_required": 1,
      "request_date": null,
      "status": "Pending",
      "urgency_level": "Emergency"
    },
    {
      "request_id": 6,
      "blood_group": "O+",
      "units_required": 2,
      "request_date": "2026-01-03 00:00:00",
      "status": "Pending",
      "urgency_level": "Emergency"
    },
    {
      "request_id": 7,
      "blood_group": "O-",
      "units_required": 1,
      "request_date": "2026-01-04 00:00:00",
      "status": null,
      "urgency_level": "Normal"
    }
  ],
  "blood_inventory": [
    {
      "inventory_id": 1,
      "bank_id": 1,
      "blood_group": "O+",
      "units_available": 0,
      "updated_at": "2026-01-01 00:00:00"
    },
    {
      "inventory_id": 2,
      "bank_id": 2,
      "blood_group": "O+",
      "units_available": 5,
      "updated_at": "2026-01-01 00:00:00"
    },
    {
      "inventory_id": 3,
      "bank_id": 1,
      "blood_group": "A+",
      "units_available": 2,
      "updated_at": "2026-01-01 00:00:00"
    }
  ],
  "blood_banks": [
    {
      "bank_id": 1,
      "bank_name": "First bank"
    },
    {
      "bank_id": 2,
      "bank_name": "Second bank"
    },
    {
      "bank_id": 3,
      "bank_name": "Unrecorded bank"
    }
  ],
  "donations": [
    {
      "donation_id": 1,
      "blood_group": "O+",
      "units_donated": 2,
      "donation_date": "2026-01-01 00:00:00"
    },
    {
      "donation_id": 2,
      "blood_group": "A+",
      "units_donated": 1,
      "donation_date": "2026-01-02 00:00:00"
    },
    {
      "donation_id": 3,
      "blood_group": "O+",
      "units_donated": 3,
      "donation_date": "2026-02-01 00:00:00"
    },
    {
      "donation_id": 4,
      "blood_group": "A+",
      "units_donated": 4,
      "donation_date": null
    }
  ],
  "request_allocations": [
    {
      "allocation_id": 1,
      "request_id": 1,
      "donation_id": 1,
      "units_allocated": 1,
      "allocated_at": "2026-01-01 00:00:00"
    },
    {
      "allocation_id": 2,
      "request_id": 1,
      "donation_id": 3,
      "units_allocated": 2,
      "allocated_at": "2026-01-02 00:00:00"
    },
    {
      "allocation_id": 3,
      "request_id": 2,
      "donation_id": 2,
      "units_allocated": 1,
      "allocated_at": "2026-02-01 00:00:00"
    },
    {
      "allocation_id": 4,
      "request_id": 5,
      "donation_id": 4,
      "units_allocated": 2,
      "allocated_at": null
    }
  ]
};
const paths = ['/dashboard', '/reports/requests', '/reports/donors', '/reports/inventory',
  '/reports/donations', '/reports/allocations'];
const queryCounts = [4, 5, 3, 4, 3, 3];
let server, baseUrl, data, queries, failIndex;

function safe(value) {
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      assert.ok(!['password', 'password_hash', 'phone', 'email', 'address', 'stack', 'sql', 'username'].includes(key));
      safe(item);
    }
  }
  assert.ok(!JSON.stringify(value).includes('Private database details'));
}

function numbersAsStrings(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? String(value) : value]));
}

function group(rows, key, metrics) {
  const groups = new Map();
  for (const row of rows) {
    const value = key(row);
    if (!groups.has(value)) groups.set(value, []);
    groups.get(value).push(row);
  }
  return [...groups].map(([value, items]) => ({ value, ...metrics(items) }));
}

function donorMetrics(rows) {
  return { total_donors: rows.length, available_donors: rows.filter(row => row.is_available === 1).length };
}

function unitMetrics(rows, countField, sumField, sourceField) {
  return { [countField]: rows.length, [sumField]: rows.reduce((total, row) => total + row[sourceField], 0) };
}

function groupedUnits(rows, column, countField, sumField, sourceField) {
  return group(rows, row => row[column], items => unitMetrics(items, countField, sumField, sourceField))
    .map(({ value, ...metrics }) => numbersAsStrings({ [column]: value, ...metrics }));
}

function monthUnits(rows, dateField, countField, sumField, sourceField) {
  return group(rows, row => row[dateField]?.slice(0, 7) ?? null,
    items => unitMetrics(items, countField, sumField, sourceField))
    .map(({ value, ...metrics }) => numbersAsStrings({ month: value, ...metrics }))
    .sort((a, b) => Number(a.month === null) - Number(b.month === null) || String(b.month).localeCompare(String(a.month)));
}

function requestMetrics(rows) {
  return { total_requests: rows.length,
    pending_requests: rows.filter(row => row.status === 'Pending').length,
    processing_requests: rows.filter(row => row.status === 'Processing').length,
    fulfilled_requests: rows.filter(row => row.status === 'Fulfilled').length,
    cancelled_requests: rows.filter(row => row.status === 'Cancelled').length };
}

function bloodBankRows() {
  return data.blood_banks.filter(bank => bank.organization_id == null ||
    data.organizations.some(row => row.organization_id === bank.organization_id && row.organization_type === 'Blood Bank'));
}

function inventoryRows() {
  const bankIds = new Set(bloodBankRows().map(bank => bank.bank_id));
  return data.blood_inventory.filter(row => bankIds.has(row.bank_id));
}

function assertBloodBankFilter(sql) {
  assert.ok(sql.includes('LEFT JOIN organizations AS o ON o.organization_id = b.organization_id'));
  assert.ok(sql.includes("(b.organization_id IS NULL OR o.organization_type = 'Blood Bank')"));
}

function inventoryGroups() {
  return group(inventoryRows(), row => row.blood_group, items => ({
    total_units_available: items.reduce((sum, row) => sum + row.units_available, 0),
    bank_count: new Set(items.map(row => row.bank_id)).size,
  })).map(({ value, ...metrics }) => numbersAsStrings({ blood_group: value, ...metrics }));
}

async function get(path, status = 200) {
  const response = await fetch(baseUrl + '/api/admin' + path);
  assert.equal(response.status, status);
  const body = await response.json(); safe(body); return body;
}

async function requestWithBody(path, body, status) {
  return new Promise((resolve, reject) => {
    const request = http.request(baseUrl + '/api/admin' + path, {
      method: 'GET', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      let result = '';
      response.setEncoding('utf8'); response.on('data', chunk => { result += chunk; });
      response.on('end', () => {
        try { assert.equal(response.statusCode, status); const parsed = JSON.parse(result); safe(parsed); resolve(parsed); }
        catch (error) { reject(error); }
      });
    });
    request.on('error', reject); request.end(body);
  });
}

before(async () => {
  // Fixtures aur SQL results memory mein rahenge; database mein koi donor/donation/allocation insert nahi hoga.
  pool.execute = async (sql, values = []) => {
    queries.push({ sql, values });
    assert.ok(sql.startsWith('SELECT '));
    assert.ok(!/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b|\b(password|password_hash|phone|email|address|username)\b|SELECT\s+\*/i.test(sql));
    if (queries.length === failIndex) {
      const error = new Error('Private database details'); error.code = 'ER_ACCESS_DENIED_ERROR'; throw error;
    }

    if (sql.includes('(SELECT COUNT(*) FROM recipients)')) {
      assert.ok(sql.includes("WHERE (b.organization_id IS NULL OR o.organization_type = 'Blood Bank')"));
      const bankCount = bloodBankRows().length;
      return [[numbersAsStrings({ total_recipients: data.recipients.length, total_blood_banks: bankCount, total_organizations: data.organizations.length })]];
    }
    if (sql.includes('FROM donors')) {
      assert.deepEqual(values, [1]);
      if (sql.includes('GROUP BY blood_group')) {
        return [group(data.donors, row => row.blood_group, donorMetrics)
          .map(({ value, ...metrics }) => numbersAsStrings({ blood_group: value, ...metrics }))];
      }
      if (sql.includes('GROUP BY normalized_location')) {
        assert.ok(sql.includes("NULLIF(TRIM(location), '') AS normalized_location"));
        assert.ok(sql.includes('ORDER BY normalized_location IS NULL ASC'));
        return [group(data.donors, row => row.location?.trim() || null, donorMetrics)
          .map(({ value, ...metrics }) => numbersAsStrings({ location: value, ...metrics }))];
      }
      assert.ok(sql.includes('SUM(is_available = ?)'));
      return [[numbersAsStrings(donorMetrics(data.donors))]];
    }
    if (sql.includes('FROM blood_requests')) {
      if (sql.includes('AS recent_requests')) {
        assert.deepEqual(values, [values[0], 'Emergency']);
        assert.ok(sql.includes('request_date DESC, request_id DESC LIMIT ?'));
        assert.ok(sql.endsWith('request_date IS NULL ASC, request_date ASC, request_id ASC'));
        const selected = [...data.blood_requests].sort((a, b) =>
          Number(a.request_date === null) - Number(b.request_date === null) ||
          String(b.request_date).localeCompare(String(a.request_date)) || b.request_id - a.request_id).slice(0, values[0]);
        selected.sort((a, b) => Number(a.urgency_level !== 'Emergency') - Number(b.urgency_level !== 'Emergency') ||
          Number(a.request_date === null) - Number(b.request_date === null) ||
          String(a.request_date).localeCompare(String(b.request_date)) || a.request_id - b.request_id);
        return [selected.map(row => ({ ...row }))];
      }
      if (sql.includes('GROUP BY')) {
        const column = sql.includes('GROUP BY status') ? 'status' :
          sql.includes('GROUP BY urgency_level') ? 'urgency_level' : 'blood_group';
        if (column === 'status') assert.deepEqual(values, ['Pending', 'Processing', 'Fulfilled', 'Cancelled']);
        if (column === 'urgency_level') assert.deepEqual(values, ['Emergency']);
        return [groupedUnits(data.blood_requests, column, 'total_requests', 'total_units_required', 'units_required')];
      }
      assert.deepEqual(values, ['Pending', 'Processing', 'Fulfilled', 'Cancelled']);
      return [[numbersAsStrings(requestMetrics(data.blood_requests))]];
    }
    if (sql.includes('LEFT JOIN blood_inventory')) {
      assertBloodBankFilter(sql);
      assert.ok(sql.includes('WHERE i.inventory_id IS NULL AND '));
      return [bloodBankRows().filter(bank => !data.blood_inventory.some(row => row.bank_id === bank.bank_id))
        .map(bank => ({ bank_id: bank.bank_id, bank_name: bank.bank_name }))];
    }
    if (sql.includes('FROM blood_inventory')) {
      assertBloodBankFilter(sql);
      assert.ok(sql.includes('ON b.bank_id = i.bank_id'));
      const rows = inventoryRows();
      if (sql.includes('GROUP BY i.blood_group')) return [inventoryGroups()];
      if (sql.startsWith('SELECT i.inventory_id')) {
        return [rows.map(row => ({ ...row,
          bank_name: data.blood_banks.find(bank => bank.bank_id === row.bank_id).bank_name }))
          .sort((a, b) => a.bank_id - b.bank_id || a.blood_group.localeCompare(b.blood_group))];
      }
      return [[numbersAsStrings({ inventory_records: rows.length,
        total_units_available: rows.reduce((sum, row) => sum + row.units_available, 0),
        banks_with_inventory: new Set(rows.map(row => row.bank_id)).size })]];
    }
    if (sql.includes('FROM donations')) {
      assert.ok(sql.includes('units_donated'));
      if (sql.includes('GROUP BY blood_group')) {
        return [groupedUnits(data.donations, 'blood_group', 'total_donations', 'total_units_donated', 'units_donated')];
      }
      if (sql.includes('GROUP BY month')) {
        assert.ok(sql.includes("DATE_FORMAT(donation_date, '%Y-%m')"));
        return [monthUnits(data.donations, 'donation_date', 'total_donations', 'total_units_donated', 'units_donated')];
      }
      return [[numbersAsStrings(unitMetrics(data.donations, 'total_donations', 'total_units_donated', 'units_donated'))]];
    }
    if (sql.includes('FROM request_allocations')) {
      assert.ok(sql.includes('units_allocated'));
      if (sql.includes('GROUP BY request_id')) {
        assert.ok(sql.includes('MIN(allocated_at) AS first_allocation_at, MAX(allocated_at) AS last_allocation_at'));
        return [group(data.request_allocations, row => row.request_id, items => {
          const dates = items.map(row => row.allocated_at).filter(Boolean).sort();
          return { ...unitMetrics(items, 'total_allocations', 'total_units_allocated', 'units_allocated'),
            first_allocation_at: dates[0] ?? null, last_allocation_at: dates.at(-1) ?? null };
        }).map(({ value, ...metrics }) => ({ request_id: value,
          ...numbersAsStrings(metrics) }))];
      }
      if (sql.includes('GROUP BY month')) {
        assert.ok(sql.includes("DATE_FORMAT(allocated_at, '%Y-%m')"));
        return [monthUnits(data.request_allocations, 'allocated_at', 'total_allocations', 'total_units_allocated', 'units_allocated')];
      }
      return [[numbersAsStrings({ ...unitMetrics(data.request_allocations, 'total_allocations', 'total_units_allocated', 'units_allocated'),
        inventory_units: data.request_allocations.filter(row => row.inventory_id != null).reduce((sum, row) => sum + row.units_allocated, 0),
        donation_units: data.request_allocations.filter(row => row.donation_id != null).reduce((sum, row) => sum + row.units_allocated, 0) })]];
    }
    throw new Error('Unexpected report query');
  };
  // Reports ka SQL trusted controller harness mein test hoga; live routes alag security suite mein hain.
  const app = express();
  app.use(express.json());
  const controller = require('../controllers/adminController');
  const routes = {dashboard:'getDashboard', 'reports/requests':'getRequestReport',
    'reports/donors':'getDonorReport', 'reports/inventory':'getInventoryReport',
    'reports/donations':'getDonationReport', 'reports/allocations':'getAllocationReport'};
  for (const [url, handler] of Object.entries(routes)) app.get('/api/admin/'+url, controller[handler]);
  app.use('/api/admin', (req,res)=>res.status(404).json({message:'Admin report endpoint not found.'}));
  app.use((error,req,res,next)=>{
    if(error.type==='entity.too.large')return res.status(413).json({message:'Request body is too large.'});
    if(error.type==='entity.parse.failed')return res.status(400).json({message:'Invalid JSON request body.'});
    res.status(500).json({message:'Internal server error.'});
  });
  server=app.listen(0);
  if(!server.listening)await new Promise(resolve=>server.once('listening',resolve));
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

beforeEach(() => {
  data = Object.fromEntries(Object.keys(populatedData).map(table => [table, []]));
  queries = []; failIndex = -1;
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  pool.execute = originalExecute;
  express.application.listen = originalListen;
  if (originalPort === undefined) delete process.env.PORT; else process.env.PORT = originalPort;
  await pool.end();
});

for (const [index, path] of paths.entries()) {
  test('empty report returns valid zeros/arrays: ' + path, async () => {
    const body = await get(path);
    assert.equal(queries.length, queryCounts[index]);
    const summary = body.summary ?? body;
    for (const [key, value] of Object.entries(summary)) {
      if (typeof value !== 'object') assert.equal(value, 0, 'nonzero empty summary: ' + key);
    }
    for (const value of Object.values(body)) if (Array.isArray(value)) assert.deepEqual(value, []);
  });
  test('report is read-only and safe with populated memory fixtures: ' + path, async () => {
    data = structuredClone(populatedData);
    const before = JSON.stringify(data);
    await get(path);
    assert.equal(JSON.stringify(data), before);
    assert.equal(queries.length, queryCounts[index]);
  });
  test('unsupported query and SQL injection rejected: ' + path, async () => {
    await get(path + '?order=DROP%20TABLE%20donors', 400);
    assert.equal(queries.length, 0);
  });
  for (let stage = 1; stage <= queryCounts[index]; stage++) {
    test('safe 500 at query ' + stage + ': ' + path, async () => {
      failIndex = stage;
      const body = await get(path, 500);
      assert.deepEqual(Object.keys(body), ['message']);
      assert.equal(queries.length, stage);
    });
  }
}

test('dashboard counts donors, all statuses, banks and stock accurately', async () => {
  data = structuredClone(populatedData);
  const body = await get('/dashboard');
  assert.equal(body.total_donors, 5); assert.equal(body.available_donors, 3);
  assert.equal(body.total_recipients, 2); assert.equal(body.total_blood_banks, 3);
  assert.equal(body.total_requests, 7); assert.equal(body.pending_requests, 3);
  assert.equal(body.processing_requests, 1); assert.equal(body.fulfilled_requests, 1);
  assert.equal(body.cancelled_requests, 1);
  const group = body.inventory_by_blood_group.find(row => row.blood_group === 'O+');
  assert.deepEqual(group, { blood_group: 'O+', total_units_available: 5, bank_count: 2 });
});

test('request counts/units include nullable legacy status', async () => {
  data = structuredClone(populatedData);
  const body = await get('/reports/requests');
  assert.equal(body.by_status.find(row => row.status === 'Pending').total_requests, 3);
  assert.equal(body.by_status.find(row => row.status === null).total_requests, 1);
  assert.equal(body.by_urgency.find(row => row.urgency_level === 'Emergency').total_units_required, 7);
  assert.equal(body.by_blood_group.find(row => row.blood_group === 'O+').total_units_required, 8);
});

test('recent requests preserve Emergency-first, oldest-first, NULL-last and ID ties', async () => {
  data = structuredClone(populatedData);
  const body = await get('/reports/requests');
  assert.deepEqual(body.recent_requests.map(row => row.request_id), [3, 2, 6, 5, 1, 4, 7]);
  assert.equal(body.recent_limit, 20);
});

test('latest selection happens before priority ordering', async () => {
  data = structuredClone(populatedData);
  assert.deepEqual((await get('/reports/requests?limit=3')).recent_requests.map(row => row.request_id), [6, 4, 7]);
});

test('recent rows exclude recipient/admin identifiers and private data in SQL', async () => {
  await get('/reports/requests');
  assert.ok(!queries.at(-1).sql.includes('recipient_id'));
  assert.ok(!queries.at(-1).sql.includes('approved_by'));
});

test('donor group/location totals normalize missing and blank location', async () => {
  data = structuredClone(populatedData);
  const body = await get('/reports/donors');
  assert.deepEqual(body.summary, { total_donors: 5, available_donors: 3 });
  assert.deepEqual(body.by_location.find(row => row.location === null),
    { location: null, total_donors: 2, available_donors: 2 });
  assert.deepEqual(body.by_location.find(row => row.location === 'Mumbai'),
    { location: 'Mumbai', total_donors: 2, available_donors: 1 });
});

test('inventory default reports zero stock without treating unrecorded bank as zero', async () => {
  data = structuredClone(populatedData);
  const body = await get('/reports/inventory');
  assert.deepEqual(body.summary, { inventory_records: 3, total_units_available: 7, banks_with_inventory: 2 });
  assert.equal(body.low_stock_threshold, 0);
  assert.deepEqual(body.low_or_zero_stock.map(row => row.inventory_id), [1]);
  assert.deepEqual(body.banks_without_inventory, [{ bank_id: 3, bank_name: 'Unrecorded bank' }]);
});

test('explicit stock threshold is inclusive and returned to client', async () => {
  data = structuredClone(populatedData);
  const body = await get('/reports/inventory?low_stock_threshold=2');
  assert.equal(body.low_stock_threshold, 2);
  assert.deepEqual(body.low_or_zero_stock.map(row => row.inventory_id).sort((a, b) => a - b), [1, 3]);
});

test('aggregate sums can exceed individual MySQL INT column limits', async () => {
  data = structuredClone(populatedData);
  data.blood_inventory[0].units_available = 2147483647;
  data.blood_inventory[1].units_available = 2147483647;
  assert.equal((await get('/reports/inventory')).summary.total_units_available, 4294967296);
});

test('donation units and month groups use actual schema fields with nullable dates', async () => {
  data = structuredClone(populatedData);
  const body = await get('/reports/donations');
  assert.deepEqual(body.summary, { total_donations: 4, total_units_donated: 10 });
  assert.deepEqual(body.by_month, [
    { month: '2026-02', total_donations: 1, total_units_donated: 3 },
    { month: '2026-01', total_donations: 2, total_units_donated: 3 },
    { month: null, total_donations: 1, total_units_donated: 4 },
  ]);
});

test('allocation report counts only allocation rows and includes date ranges', async () => {
  data = structuredClone(populatedData);
  const body = await get('/reports/allocations');
  assert.deepEqual(body.summary, { total_allocations: 4, total_units_allocated: 6, inventory_units: 0, donation_units: 6 });
  const row = body.by_request.find(item => item.request_id === 1);
  assert.equal(row.total_allocations, 2); assert.equal(row.total_units_allocated, 3);
  assert.equal(row.first_allocation_at, '2026-01-01 00:00:00');
  assert.equal(row.last_allocation_at, '2026-01-02 00:00:00');
  assert.equal(body.by_month.at(-1).month, null);
});

for (const limit of ['', '0', '-1', '1.5', '101', '1e3', 'null', '+1', ' 1 ', '1 OR 1=1']) {
  test('invalid request limit rejected: ' + limit, async () => {
    await get('/reports/requests?limit=' + encodeURIComponent(limit), 400); assert.equal(queries.length, 0);
  });
}
for (const limit of [1, 20, 100]) {
  test('request limit boundary ' + limit, async () => {
    assert.equal((await get('/reports/requests?limit=' + limit)).recent_limit, limit);
    assert.deepEqual(queries.at(-1).values, [limit, 'Emergency']);
  });
}
for (const threshold of ['', '-1', '1.5', '2147483648', '1e3', 'null', '+1', '1 OR 1=1']) {
  test('invalid stock threshold rejected: ' + threshold, async () => {
    await get('/reports/inventory?low_stock_threshold=' + encodeURIComponent(threshold), 400);
    assert.equal(queries.length, 0);
  });
}
for (const threshold of [0, 2, 2147483647]) {
  test('stock threshold boundary ' + threshold, async () => {
    assert.equal((await get('/reports/inventory?low_stock_threshold=' + threshold)).low_stock_threshold, threshold);
  });
}
for (const path of ['/reports/requests?limit=1&limit=2', '/reports/requests?limit[]=1',
  '/reports/inventory?low_stock_threshold=0&low_stock_threshold=2', '/reports/inventory?low_stock_threshold[]=2']) {
  test('duplicate/array query options rejected: ' + path, async () => {
    await get(path, 400); assert.equal(queries.length, 0);
  });
}
for (const path of ['/unknown', '/reports/unknown', '/reports/requests/1', '/reports/' + encodeURIComponent('1 OR 1=1')]) {
  test('unknown admin route returns safe JSON 404: ' + path, async () => {
    assert.deepEqual(await get(path, 404), { message: 'Admin report endpoint not found.' });
    assert.equal(queries.length, 0);
  });
}
for (const method of ['POST', 'PUT', 'DELETE']) {
  test('unsupported admin method returns JSON 404: ' + method, async () => {
    const response = await fetch(baseUrl + '/api/admin/dashboard', { method });
    assert.equal(response.status, 404); safe(await response.json()); assert.equal(queries.length, 0);
  });
}
test('malformed GET JSON is handled by existing middleware', async () => {
  await requestWithBody('/dashboard', '{', 400); assert.equal(queries.length, 0);
});
test('oversized GET body is handled by existing middleware', async () => {
  await requestWithBody('/dashboard', JSON.stringify({ input: 'x'.repeat(110000) }), 413);
  assert.equal(queries.length, 0);
});

test('dashboard counts all organizations but excludes operational Hospital rows from blood bank totals', async () => {
  data = structuredClone(populatedData);
  data.organizations = [{ organization_id: 11, organization_type: 'Hospital' },
    { organization_id: 12, organization_type: 'Blood Bank' }, { organization_id: 13, organization_type: 'NGO' }];
  data.blood_banks[0].organization_id = 11; data.blood_banks[1].organization_id = 12;
  const result = await get('/dashboard');
  assert.equal(result.total_organizations, 3);
  assert.equal(result.total_blood_banks, 2);
  assert.ok(queries.some(query => query.sql.includes("o.organization_type = 'Blood Bank'")));
});

test('inventory reports exclude Hospital and NGO companions across all stock sections', async () => {
  data = structuredClone(populatedData);
  data.organizations = [{ organization_id: 11, organization_type: 'Hospital' },
    { organization_id: 12, organization_type: 'Blood Bank' }, { organization_id: 13, organization_type: 'NGO' }];
  data.blood_banks[1].organization_id = 12;
  data.blood_banks.push(
    { bank_id: 4, bank_name: 'Hospital with stock', organization_id: 11 },
    { bank_id: 5, bank_name: 'Hospital without stock', organization_id: 11 },
    { bank_id: 6, bank_name: 'NGO with stock', organization_id: 13 },
    { bank_id: 7, bank_name: 'NGO without stock', organization_id: 13 },
    { bank_id: 8, bank_name: 'Registered Blood Bank without stock', organization_id: 12 }
  );
  data.blood_inventory.push(
    { inventory_id: 4, bank_id: 4, blood_group: 'AB-', units_available: 99, updated_at: null },
    { inventory_id: 5, bank_id: 6, blood_group: 'O+', units_available: 0, updated_at: null }
  );
  const before = structuredClone(data);
  const result = await get('/reports/inventory');
  assert.deepEqual(result.summary, { inventory_records: 3, total_units_available: 7, banks_with_inventory: 2 });
  assert.deepEqual(result.by_blood_group, [
    { blood_group: 'O+', total_units_available: 5, bank_count: 2 },
    { blood_group: 'A+', total_units_available: 2, bank_count: 1 },
  ]);
  assert.deepEqual(result.bank_wise_stock.map(row => row.inventory_id), [3, 1, 2]);
  assert.deepEqual(result.low_or_zero_stock.map(row => row.inventory_id), [1]);
  assert.deepEqual(result.banks_without_inventory, [
    { bank_id: 3, bank_name: 'Unrecorded bank' },
    { bank_id: 8, bank_name: 'Registered Blood Bank without stock' },
  ]);
  assert.deepEqual(data, before);

  const dashboard = await get('/dashboard');
  assert.equal(dashboard.total_blood_banks, 4);
  assert.deepEqual(dashboard.inventory_by_blood_group, result.by_blood_group);
  assert.deepEqual(data, before);
});

test('only companion inventory produces empty Blood Bank summaries and groups', async () => {
  data.organizations = [{ organization_id: 11, organization_type: 'Hospital' },
    { organization_id: 13, organization_type: 'NGO' }];
  data.blood_banks = [{ bank_id: 4, bank_name: 'Hospital', organization_id: 11 },
    { bank_id: 6, bank_name: 'NGO', organization_id: 13 }];
  data.blood_inventory = [{ inventory_id: 4, bank_id: 4, blood_group: 'AB-', units_available: 99 },
    { inventory_id: 5, bank_id: 6, blood_group: 'O+', units_available: 0 }];
  const result = await get('/reports/inventory');
  assert.deepEqual(result.summary, { inventory_records: 0, total_units_available: 0, banks_with_inventory: 0 });
  for (const key of ['by_blood_group', 'bank_wise_stock', 'low_or_zero_stock', 'banks_without_inventory']) {
    assert.deepEqual(result[key], []);
  }
  const dashboard = await get('/dashboard');
  assert.equal(dashboard.total_blood_banks, 0);
  assert.deepEqual(dashboard.inventory_by_blood_group, []);
});
test('allocation report separates inventory from donations without creating historical allocations', async () => {
  data = structuredClone(populatedData);
  data.request_allocations.push({ allocation_id: 5, request_id: 1, donation_id: null,
    inventory_id: 2, units_allocated: 4, allocated_at: '2026-02-02 00:00:00' });
  const before = structuredClone(data);
  const result = await get('/reports/allocations');
  assert.deepEqual(result.summary, { total_allocations: 5, total_units_allocated: 10, inventory_units: 4, donation_units: 6 });
  assert.deepEqual(data, before);
  assert.equal(data.request_allocations.some(row => row.request_id === 3), false);
});
