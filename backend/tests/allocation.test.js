const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const pool = require('../db');
const original = { execute:pool.execute, connection:pool.getConnection, listen:express.application.listen,
  port:process.env.PORT, secret:process.env.JWT_SECRET, expiry:process.env.JWT_EXPIRES_IN };
const secret = randomBytes(32).toString('hex');
let server, base, data, events, failAt, failCode, stockConflict, statusConflict, rollbackFails, tail;
const request = { request_id:27, recipient_id:16, bank_id:1, blood_group:'A+', units_required:3,
  urgency_level:'Emergency', status:'Pending', donor_matching_started_at:null, organization_id:11, state:'Uttar Pradesh', city:'Ghaziabad' };
const donor = { donor_id:16, name:'Memory donor', blood_group:'A+', is_available:1, location:'Fixture area', state:'Uttar Pradesh', city:'Ghaziabad', phone:'never-expose', email:'never-expose' };
function token(id=1, role='blood_bank', expiresIn='1h') {
  return jwt.sign({user_id:id,user_type:role},secret,{algorithm:'HS256',expiresIn});
}
function fail(stage) {
  if(failAt===stage){events.push({failed_stage:stage});const error=new Error('Private SQL details');error.code=failCode;throw error;}
}
function inventory(units, bank=1, group='A+', id=bank) {
  data.stock.push({inventory_id:id,bank_id:bank,blood_group:group,units_available:units,version:0});
}
async function lock() {
  const previous=tail;let unlock;tail=new Promise(resolve=>{unlock=resolve;});
  await previous;return unlock;
}
function safe(value) {
  if(value&&typeof value==='object')for(const [key,item]of Object.entries(value)){
    assert.ok(!['password','password_hash','phone','email','stack','sql'].includes(key));
    safe(item);
  }
  assert.ok(!JSON.stringify(value).includes('Private SQL'));
  assert.ok(!JSON.stringify(value).includes('never-expose'));
}
async function processRequest(expected=200, options={}) {
  const response=await fetch(base+'/api/allocations/'+(options.action||'process')+'/'+encodeURIComponent(options.id??27)+(options.query||''),{
    method:'POST',headers:{'Content-Type':'application/json',...(options.token===null?{}:{Authorization:'Bearer '+(options.token||token())})},
    body:options.raw?options.body:JSON.stringify(options.body),
  });
  const body=await response.json();safe(body);assert.equal(response.status,expected, 'Last transaction steps: ' + JSON.stringify(events.slice(-6)));return body;
}
before(async () => {
  process.env.JWT_SECRET = secret; process.env.JWT_EXPIRES_IN = '1h';
  // This harness models serialized transactions and rollback entirely in memory; no MySQL connection occurs.
  pool.getConnection = async () => {
    events.push('connection'); fail('connection');
    let active = false, snapshot, unlock;
    function restore() {
      if (snapshot) data = snapshot;
      snapshot = undefined; active = false; unlock?.(); unlock = null;
    }
    return {
      async beginTransaction() { events.push('begin'); fail('begin'); unlock = await lock(); snapshot = structuredClone(data); active = true; },
      async execute(sql, values) {
        assert.equal(active, true); assert.ok(Array.isArray(values)); events.push({ sql, values });
        if (sql.startsWith('SELECT request_id, recipient_id')) {
          fail('request'); assert.ok(sql.endsWith('AND bank_id = ? FOR UPDATE'));
          return [data.requests.filter(row => row.request_id === values[0] && row.bank_id === values[1]).map(row => ({ ...row }))];
        }
        if (sql.startsWith('SELECT allocation_id')) {
          fail('allocations'); assert.ok(sql.endsWith('FOR UPDATE'));
          return [data.allocations.filter(row => row.request_id === values[0]).map(row => ({ ...row }))];
        }
        if (sql.startsWith('SELECT a.allocation_id')) {
          fail('operation_lookup'); assert.ok(sql.endsWith('FOR UPDATE'));
          return [data.allocations.filter(row => row.request_id === values[0] && row.operation_key === values[1]).map(row => ({ ...row }))];
        }
        if (sql.startsWith('SELECT inventory_id')) {
          fail('inventory'); assert.ok(sql.endsWith('FROM blood_inventory WHERE bank_id = ? AND blood_group = ? FOR UPDATE')); assert.equal(values.length, 2);
          return [data.stock.filter(row => row.bank_id === values[0] && row.blood_group === values[1]).map(row => ({ ...row }))];
        }
        if (sql.startsWith('UPDATE blood_inventory')) {
          fail('stock_update');
          const row = data.stock.find(row => row.inventory_id === values[1]);
          if (sql.includes('units_available - ?')) {
            assert.deepEqual(values, [values[0], values[1], values[0]]);
            if (stockConflict || !row || row.units_available < values[0]) return [{ affectedRows: 0 }];
            row.units_available -= values[0];
          } else {
            assert.equal(sql, 'UPDATE blood_inventory SET units_available = ?, version = version + 1 WHERE inventory_id = ?');
            assert.ok(row); row.units_available = values[0];
          }
          row.version++; assert.ok(row.units_available >= 0); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO request_allocations')) {
          fail('allocation_insert');
          assert.equal(sql, 'INSERT INTO request_allocations (request_id, donation_id, inventory_id, units_allocated, operation_key) VALUES (?, NULL, ?, ?, ?)');
          const [requestId, inventoryId, units, key] = values;
          assert.ok(data.stock.some(row => row.inventory_id === inventoryId));
          assert.ok(Number.isInteger(units) && units > 0);
          if (data.allocations.some(row => row.request_id === requestId && row.operation_key === key)) {
            const error = new Error('duplicate operation'); error.code = 'ER_DUP_ENTRY'; throw error;
          }
          const allocationId = data.allocations.length + 1;
          data.allocations.push({ allocation_id: allocationId, request_id: requestId, inventory_id: inventoryId,
            donation_id: null, units_allocated: units, operation_key: key });
          return [{ insertId: allocationId, affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE blood_requests SET status')) {
          fail('status_update');
          if (statusConflict) { const error = new Error('Concurrent status change'); error.code = 'ER_LOCK_DEADLOCK'; throw error; }
          assert.equal(values.length, 2);
          const row = data.requests.find(row => row.request_id === values[1]);
          assert.ok(row); row.status = values[0]; return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('UPDATE blood_requests SET donor_matching')) {
          fail('marker'); assert.equal(values.length, 1);
          const row = data.requests.find(row => row.request_id === values[0]);
          assert.ok(row); row.donor_matching_started_at ||= '2026-10-07T06:30:00.000Z'; return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('SELECT donor_id, name')) {
          fail('donors'); assert.deepEqual(values, ['A+', 1, 'Uttar Pradesh', 'Ghaziabad']);
          return [data.donors.filter(row => row.blood_group === values[0] && row.is_available === values[1]
            && row.state === values[2] && row.city.toLowerCase() === values[3].toLowerCase())];
        }
        if (sql.startsWith('SELECT donor_id, response')) { fail('responses'); return [data.responses.filter(row => row.request_id === values[0])]; }
        if (sql.startsWith('SELECT notification_id')) {
          fail('notification_lookup'); return [data.notes.filter(row => row.donor_id === values[0] && row.request_id === values[1]
            && row.channel === values[2] && row.message === values[3])];
        }
        if (sql.startsWith('SELECT donor_id, phone')) { fail('notification_user'); return [data.donors.filter(row => row.donor_id === values[0])]; }
        if (sql.startsWith('SELECT recipient_id, phone')) { fail('recipient_notification_user'); return [data.recipients.filter(row => row.recipient_id === values[0])]; }
        if (sql.startsWith('SELECT request_id FROM')) { fail('notification_request'); return [data.requests.filter(row => row.request_id === values[0])]; }
        if (sql.startsWith('INSERT INTO notifications')) {
          fail('notification_insert');
          assert.notEqual(values[0] == null, values[1] == null); assert.equal(values[3], 'InApp');
          assert.ok(data.requests.some(row => row.request_id === values[2]));
          const id = data.notes.length + 1;
          data.notes.push({ notification_id: id, donor_id: values[0], recipient_id: values[1], request_id: values[2], channel: values[3], message: values[4] });
          return [{ insertId: id }];
        }
        throw new Error('Unexpected SQL or fake donation write: ' + sql);
      },
      async commit() { events.push('commit'); fail('commit'); snapshot = undefined; active = false; unlock?.(); unlock = null; },
      async rollback() { events.push('rollback'); if (rollbackFails) throw new Error('Private rollback failure'); restore(); },
      release() { events.push('release'); assert.equal(active, false); },
      destroy() { events.push('destroy'); restore(); },
    };
  };
  pool.execute = async (sql, values) => {
    events.push({ sql, values });
    if (sql.includes('FROM blood_banks b LEFT JOIN organizations')) {
      fail('provider'); return [data.providers.filter(row => row.bank_id === values[0])];
    }
    if (sql.includes('FROM organizations o LEFT JOIN blood_banks')) {
      fail('provider'); return [data.providers.filter(row => row.organization_id === values[0])];
    }
    throw new Error('Processing mutations must use the transaction connection');
  };
  express.application.listen = function (...args) { server = original.listen.apply(this, args); return server; };
  process.env.PORT = '0'; try { require('../index'); } finally { express.application.listen = original.listen; }
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
});
beforeEach(()=>{
  process.env.JWT_SECRET=secret;process.env.JWT_EXPIRES_IN='1h';
  data={requests:[{...request}],stock:[],donors:[],allocations:[],responses:[],notes:[],recipients:[{recipient_id:16,phone:'never-expose'}],
    providers:[{organization_id:11,bank_id:1,organization_type:'Blood Bank',state:'Uttar Pradesh',city:'Ghaziabad'},
      {organization_id:12,bank_id:2,organization_type:'Hospital',state:'Uttar Pradesh',city:'Ghaziabad'},
      {organization_id:13,bank_id:null,organization_type:'NGO',state:'Uttar Pradesh',city:'Ghaziabad'}]};
  events=[];failAt=null;failCode='ER_ACCESS_DENIED_ERROR';stockConflict=false;statusConflict=false;rollbackFails=false;tail=Promise.resolve();
});
after(async()=>{
  if(server)await new Promise(resolve=>server.close(resolve));
  pool.execute=original.execute;pool.getConnection=original.connection;express.application.listen=original.listen;
  for(const [key,value]of [['PORT',original.port],['JWT_SECRET',original.secret],['JWT_EXPIRES_IN',original.expiry]]){
    if(value===undefined)delete process.env[key];else process.env[key]=value;
  }
  await pool.end();
});
for (const id of ['0','-1','1.5','2147483648','1e3','abc','null','+1',' 1 ','1 OR 1=1']) {
  test('invalid processing ID is rejected before SQL: ' + id, async () => { await processRequest(400, { id }); assert.deepEqual(events, []); });
}
for (const body of [null, [], 123, 'text', {bank_id:2}, {status:'Fulfilled'}, {recipient_id:16}, {donation_id:1}]) {
  test('body cannot control bank/status/ownership: ' + JSON.stringify(body), async () => { await processRequest(400, { body }); assert.deepEqual(events, []); });
}
for (const [label, makeToken, status] of [
  ['missing', () => null, 401], ['invalid', () => 'invalid-token', 401],
  ['expired', () => token(1,'blood_bank','-1s'), 401],
  ['wrong secret', () => jwt.sign({user_id:1,user_type:'blood_bank'},randomBytes(32),{expiresIn:'1h'}), 401],
  ['donor', () => token(1,'donor'), 403], ['recipient', () => token(1,'recipient'), 403],
]) test(label + ' authentication is rejected before database access', async () => {
  await processRequest(status, { token: makeToken() }); assert.deepEqual(events, []);
});
test('empty JSON body remains a compatible inventory operation', async () => { inventory(3); await processRequest(200, { body: {} }); });
test('malformed JSON and huge bodies fail without processing', async () => {
  await processRequest(400, { body: '{', raw: true });
  await processRequest(413, { body: { value: 'x'.repeat(110000) } }); assert.deepEqual(events, []);
});
test('missing and another-bank request have identical safe404', async () => {
  const absent = await processRequest(404, { id:999 }); data.requests[0].bank_id = 2;
  assert.deepEqual(await processRequest(404), absent); assert.equal(data.stock.length,0); assert.equal(data.notes.length,0);
});
test('legacy unassigned request cannot be silently assigned or processed', async () => {
  data.requests[0].bank_id = null; await processRequest(404); assert.equal(data.requests[0].bank_id,null);
});
for (const status of ['Fulfilled','Cancelled']) test(status + ' request cannot be consumed twice', async () => {
  data.requests[0].status = status; inventory(5); await processRequest(409);
  assert.equal(data.stock[0].units_available,5); assert.equal(data.allocations.length,0);
});
test('Processing request remains open and uses remaining units from authoritative allocation rows', async () => {
  data.requests[0].status = 'Processing';
  data.allocations = [{ allocation_id:1, request_id:27, donation_id:42, inventory_id:null, units_allocated:1 }];
  inventory(5); const result = await processRequest();
  assert.equal(result.status,'Fulfilled'); assert.equal(result.fulfilled_units,3); assert.equal(result.remaining_units,0);
  assert.equal(result.inventory_units,2); assert.equal(result.donation_units,1); assert.equal(data.stock[0].units_available,3);
});
for (const [field,value] of [['units_required',0],['units_required',-1],['units_required',1.5],
  ['units_required','3'],['units_required',2147483648],['recipient_id',0],['blood_group','Unknown'],['urgency_level',null],['status',null]]) {
  test('corrupt stored request field is rejected without mutations: ' + field + ' ' + value, async () => {
    data.requests[0][field] = value; await processRequest(409);
    assert.ok(!events.some(event => event.sql?.startsWith('UPDATE') || event.sql?.startsWith('INSERT')));
  });
}
test('inconsistent allocation source history blocks inventory consumption', async () => {
  data.allocations = [{ request_id:27, allocation_id:1, units_allocated:1, donation_id:1, inventory_id:1 }];
  inventory(5); await processRequest(409); assert.equal(data.stock[0].units_available,5);
});
test('recorded allocation units exceeding the requirement reject further fulfillment', async () => {
  data.allocations = [{ request_id:27, allocation_id:1, units_allocated:4, donation_id:1, inventory_id:null }];
  inventory(5); await processRequest(409); assert.equal(data.stock[0].units_available,5);
});
for (const [field,value] of [['units_available',-1],['units_available',1.5],['units_available','3'],['inventory_id',0]]) {
  test('corrupt inventory causes safe409 without allocations: ' + field, async () => {
    inventory(5); data.stock[0][field] = value; await processRequest(409);
    assert.equal(data.notes.length,0); assert.equal(data.allocations.length,0);
  });
}
for (const units of [0,2,3,5]) test('example 3-unit request tracks actual partial inventory progress with stock ' + units, async () => {
  inventory(units); data.donors = [{...donor}]; const result = await processRequest();
  const used = Math.min(units,3);
  assert.equal(data.stock[0].units_available,units-used);
  assert.equal(result.fulfilled_units,used); assert.equal(result.remaining_units,3-used);
  assert.equal(data.requests[0].status,used===3?'Fulfilled':used?'Processing':'Pending');
  assert.equal(result.source,used?'blood_bank':'individual_donors');
  assert.equal(data.allocations.length,used?1:0);
  assert.equal(data.notes.filter(row => row.donor_id != null).length,used===3?0:1);
  assert.equal(data.notes.filter(row => row.recipient_id != null).length,used?1:0);
  if (used===3) assert.equal(data.requests[0].donor_matching_started_at,null);
  else { assert.ok(data.requests[0].donor_matching_started_at); assert.equal(result.notified_count,1); }
});
for (const required of [1,7,17]) test('required quantities remain dynamic: ' + required, async () => {
  data.requests[0].units_required = required; inventory(required + 2);
  const result = await processRequest();
  assert.equal(result.allocated_units,required); assert.equal(result.fulfilled_units,required);
  assert.equal(result.remaining_units,0); assert.equal(data.stock[0].units_available,2);
});
test('stock from another bank or blood group is never used', async () => {
  inventory(2); inventory(100,2); inventory(100,1,'O+',3); data.donors = [{...donor}];
  const result = await processRequest(200, {query:'?bank_id=2'});
  assert.equal(result.source,'blood_bank'); assert.equal(result.allocated_units,2);
  assert.deepEqual(data.stock.map(row => row.units_available),[0,100,100]); assert.equal(result.remaining_units,1);
});
test('missing inventory means zero fulfillment and local donor matching', async () => {
  data.donors = [{...donor}]; const result = await processRequest();
  assert.equal(data.stock.length,0); assert.equal(data.notes.length,1); assert.equal(result.fulfilled_units,0);
});
test('only same-state same-city exact-group available donors receive useful invitations', async () => {
  inventory(2); data.donors = [{...donor}, {...donor,donor_id:17,blood_group:'O+'},
    {...donor,donor_id:18,is_available:0}, {...donor,donor_id:19,city:'Lucknow'}, {...donor,donor_id:20,state:'Maharashtra'}];
  const result = await processRequest();
  assert.deepEqual(result.donors.map(row => row.donor_id),[16]);
  const notes = data.notes.filter(row => row.donor_id != null);
  assert.deepEqual(notes.map(row => row.donor_id),[16]); assert.match(notes[0].message,/#27 requires A\+/);
  assert.deepEqual(Object.keys(result.donors[0]).sort(),['donor_id','name','blood_group','location','is_available','donor_response'].sort());
});
test('no donor candidate still records a genuine fallback attempt after partial inventory use', async () => {
  inventory(2); const result = await processRequest();
  assert.deepEqual(result.donors,[]); assert.equal(result.notified_count,0);
  assert.ok(data.requests[0].donor_matching_started_at); assert.equal(result.remaining_units,1);
});
test('repeat matching does not duplicate invitations or inventory allocations', async () => {
  inventory(2); data.donors = [{...donor}]; await processRequest();
  const marker = data.requests[0].donor_matching_started_at; const repeated = await processRequest();
  assert.equal(repeated.notified_count,0); assert.equal(data.notes.length,2);
  assert.equal(data.requests[0].donor_matching_started_at,marker); assert.equal(data.allocations.length,1);
});
test('declined and failed-screening donors are excluded and accepted donors are not invited again', async () => {
  inventory(2); data.donors = [{...donor}, {...donor,donor_id:17}, {...donor,donor_id:18}];
  data.responses = [{request_id:27,donor_id:16,response:'Declined'},
    {request_id:27,donor_id:17,response:'Accepted'}, {request_id:27,donor_id:18,response:'Accepted',screening_result:'Failed'}];
  const result = await processRequest();
  assert.deepEqual(result.donors.map(row => row.donor_id),[17]); assert.equal(result.donors[0].donor_response,'Accepted');
  assert.equal(data.notes.filter(row => row.donor_id != null).length,0); assert.equal(data.stock[0].units_available,0);
});
test('same request processed concurrently consumes inventory exactly once', async () => {
  inventory(5);
  const replies = await Promise.all([fetch(base+'/api/allocations/process/27',{method:'POST',headers:{Authorization:'Bearer '+token()}}),
    fetch(base+'/api/allocations/process/27',{method:'POST',headers:{Authorization:'Bearer '+token()}})]);
  assert.deepEqual(replies.map(row => row.status).sort(),[200,409]); assert.equal(data.stock[0].units_available,2);
  assert.equal(data.allocations.length,1); assert.equal(data.notes.length,1);
});
test('two requests sharing stock allocate available units without negative inventory or over-fulfillment', async () => {
  inventory(5); data.requests.push({...request,request_id:28});
  const [first,second] = await Promise.all([processRequest(),processRequest(200,{id:28})]);
  assert.equal(first.source,'blood_bank'); assert.equal(second.source,'blood_bank');
  assert.deepEqual([first.fulfilled_units,second.fulfilled_units].sort(),[2,3]);
  assert.equal(data.stock[0].units_available,0); assert.equal(data.requests.filter(row => row.status==='Fulfilled').length,1);
});
test('revision-protected inventory edit cannot restore stock consumed concurrently', async () => {
  inventory(5);
  const results = await Promise.all([processRequest(),
    fetch(base+'/api/inventory/1/A%2B',{method:'PUT',headers:{Authorization:'Bearer '+token(),'Content-Type':'application/json'},
      body:JSON.stringify({units_available:8,expected_version:0})})]);
  assert.ok([200,409].includes(results[1].status)); assert.ok([2,5].includes(data.stock[0].units_available));
  assert.equal(data.requests[0].status,'Fulfilled'); assert.equal(data.allocations.length,1);
});
for (const stage of ['provider','connection','begin','request','allocations','operation_lookup','inventory','allocation_insert','marker','donors','responses',
  'notification_lookup','notification_user','recipient_notification_user','notification_request','notification_insert','commit']) {
  test('failure at ' + stage + ' rolls back progress, stock, allocations and notifications', async () => {
    inventory(2); data.donors = [{...donor}]; const before = structuredClone(data); failAt = stage;
    await processRequest(500); assert.deepEqual(data,before); assert.ok(events.some(event => event.failed_stage === stage));
  });
}
for (const stage of ['stock_update','status_update','commit']) test('direct fulfillment failure at ' + stage + ' rolls back deductions and allocations', async () => {
  inventory(5); const before = structuredClone(data); failAt = stage; await processRequest(500); assert.deepEqual(data,before); assert.ok(events.some(event => event.failed_stage === stage));
});
for (const kind of ['stock','status']) test(kind + ' concurrent database guard conflict returns409 and rolls back', async () => {
  inventory(5); const before = structuredClone(data); if(kind==='stock')stockConflict=true;else statusConflict=true;
  await processRequest(409); assert.deepEqual(data,before);
});
for (const code of ['ER_LOCK_DEADLOCK','ER_LOCK_WAIT_TIMEOUT']) test(code + ' becomes safe retryable409', async () => {
  inventory(5); failAt='inventory'; failCode=code; await processRequest(409); assert.equal(data.stock[0].units_available,5);
});
test('failed rollback destroys poisoned connection instead of releasing it', async () => {
  inventory(5); failAt='status_update'; rollbackFails=true; const before=structuredClone(data);
  await processRequest(500); assert.deepEqual(data,before); assert.ok(events.includes('destroy')); assert.ok(!events.includes('release'));
});
test('inventory consumption creates a genuine inventory-source allocation and no fake donation', async () => {
  inventory(5); await processRequest();
  assert.ok(!events.some(event => /INSERT INTO donations/.test(event.sql||'')));
  assert.equal(data.allocations.length,1); assert.equal(data.allocations[0].inventory_id,1);
  assert.equal(data.allocations[0].donation_id,null); assert.equal(data.allocations[0].units_allocated,3);
});
test('idempotent inventory retry returns the recorded result and never deducts twice', async () => {
  const operationKey='c7e8e5a8-4f6b-4b79-8b42-4573a7087d59';
  inventory(5); const first=await processRequest(200,{body:{operation_key:operationKey}});
  const second=await processRequest(200,{body:{operation_key:operationKey}});
  assert.equal(second.allocated_units,first.allocated_units); assert.equal(data.allocations.length,1);
  assert.equal(data.stock[0].units_available,2); assert.equal(data.notes.length,1);
});
test('operation key reused from donation cannot create an inventory-source allocation', async () => {
  const operationKey='c7e8e5a8-4f6b-4b79-8b42-4573a7087d59';
  data.requests[0].status='Processing'; data.allocations=[{allocation_id:1,request_id:27,donation_id:42,inventory_id:null,units_allocated:1,operation_key:operationKey}];
  inventory(5); await processRequest(409,{body:{operation_key:operationKey}}); assert.equal(data.stock[0].units_available,5);
});
test('match-only operation starts local invitations without deducting available inventory', async () => {
  inventory(5); data.donors=[{...donor}]; const result=await processRequest(200,{action:'match'});
  assert.equal(result.allocated_units,0); assert.equal(data.stock[0].units_available,5);
  assert.equal(data.allocations.length,0); assert.ok(data.requests[0].donor_matching_started_at);
});
test('historical fulfilled request remains intact without fabricated allocation history', async () => {
  data.requests[0].status='Fulfilled'; inventory(5); const before=structuredClone(data);
  await processRequest(409); assert.deepEqual(data,before); assert.equal(data.allocations.length,0);
});
test('NGO cannot enter a clinical transaction', async () => {
  await processRequest(403,{token:token(13,'organization')}); assert.ok(!events.includes('begin'));
});
test('Hospital can match local donors while its compatibility bank stock is not used', async () => {
  data.requests[0].bank_id=2; data.requests[0].organization_id=12; inventory(5,2); data.donors=[{...donor}];
  const result=await processRequest(200,{token:token(12,'organization')});
  assert.equal(result.allocated_units,0); assert.equal(data.stock[0].units_available,5);
  assert.equal(result.organization_id,12); assert.equal(result.notified_count,1);
});
for(const operationKey of ['', 'not-a-uuid', 1, null]) test('invalid operation key is rejected before DB: '+operationKey, async()=>{
  await processRequest(400,{body:{operation_key:operationKey}}); assert.deepEqual(events,[]);
});
