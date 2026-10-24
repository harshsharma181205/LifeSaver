const assert=require('node:assert/strict');
const {test}=require('node:test');
const {migrate}=require('../migrations/bloodBankIntegration');
function fixture({existing=false,legacy=0,wrongType=null,foreignKey=false}={}) {
  const columns=existing?[
    ['blood_banks','password_hash','varchar(255)'],['blood_requests','bank_id','int'],
    ['blood_requests','donor_matching_started_at','timestamp'],
    ['donor_responses','request_id','int'],['donor_responses','donor_id','int'],
    ['donor_responses','response',"enum('Accepted','Declined')"],['donor_responses','responded_at','timestamp']
  ].map(([TABLE_NAME,COLUMN_NAME,COLUMN_TYPE])=>({TABLE_NAME,COLUMN_NAME,COLUMN_TYPE})):[];
  if(wrongType)columns.push({TABLE_NAME:'blood_banks',COLUMN_NAME:'password_hash',COLUMN_TYPE:wrongType});
  const queries=[];
  const pool={async execute(sql){
    queries.push(sql);assert.ok(!/^(INSERT|UPDATE|DELETE|DROP|TRUNCATE)/i.test(sql));
    if(sql.includes('INFORMATION_SCHEMA.COLUMNS'))return [columns];
    if(sql.includes('INFORMATION_SCHEMA.KEY_COLUMN_USAGE'))return [existing||foreignKey?[{REFERENCED_TABLE_NAME:foreignKey?'donors':'blood_banks',REFERENCED_COLUMN_NAME:foreignKey?'donor_id':'bank_id'}]:[]];
    if(sql.startsWith('SELECT COUNT'))return [[{total:legacy}]];
    if(sql.startsWith('ALTER TABLE')||sql.startsWith('CREATE TABLE'))return [{}];
    throw new Error('Unexpected SQL');
  }};
  return {pool,queries};
}
test('empty database requires bank assignment and minimal additions',async()=>{
  const {pool,queries}=fixture();const result=await migrate(pool);
  assert.equal(result.changes.length,5);assert.equal(result.legacyUnassignedRequests,0);
  assert.ok(queries.includes('ALTER TABLE blood_requests ADD COLUMN bank_id INT NOT NULL'));
  assert.ok(queries.some(sql=>sql.includes('PRIMARY KEY (request_id, donor_id)')));
});
test('legacy rows stay unassigned; migration never rewrites their data',async()=>{
  const {pool,queries}=fixture({legacy:1});const result=await migrate(pool);
  assert.equal(result.legacyUnassignedRequests,1);
  assert.ok(queries.includes('ALTER TABLE blood_requests ADD COLUMN bank_id INT NULL DEFAULT NULL'));
});
test('existing compatible schema is reused without ALTER or duplicate tables',async()=>{
  const {pool,queries}=fixture({existing:true,legacy:1});
  assert.deepEqual(await migrate(pool),{changes:[],legacyUnassignedRequests:1});
  assert.ok(!queries.some(sql=>/^(ALTER|CREATE)/.test(sql)));
});
test('incompatible credential column stops without touching database',async()=>{
  const {pool,queries}=fixture({wrongType:'text'});
  await assert.rejects(migrate(pool),/unexpected type/);
  assert.equal(queries.length,1);
});
test('conflicting existing foreign key stops before further changes',async()=>{
  const {pool,queries}=fixture({existing:true,foreignKey:true});
  await assert.rejects(migrate(pool),/relationship conflicts/);
  assert.ok(!queries.some(sql=>/^(ALTER|CREATE)/.test(sql)));
});
test('database error propagates instead of pretending success',async()=>{
  await assert.rejects(migrate({execute:async()=>{throw new Error('unavailable');}}),/unavailable/);
});
