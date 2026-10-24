import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { lifecycleRequestFields, newOperationKey } from '../src/services/lifecycleFields.js';
import { fetchDonorMatches, updateDonorLocation } from '../src/services/donorDashboardApi.js';
import { fetchBankRequests, fetchBankInventory, updateBankInventory, recordDonorScreening,
  recordActualDonation, processBankRequest, findRequestDonors } from '../src/services/bloodBankDashboardApi.js';

const originalAdapter=axios.defaults.adapter;
const org={token:'memory-org',user:{user_id:9,user_type:'organization'}};
const provider={organization_id:9,organization_type:'Blood Bank',bank_id:6};
const donor={token:'memory-donor',user:{user_id:4,user_type:'donor'}};
const uuid='3d339475-0ffb-4b64-979d-e10aa93cb1f3';
const row={request_id:12,organization_id:9,bank_id:6,organization_name:'Registered Provider',state:'Maharashtra',city:'Pune',
  blood_group:'A+',units_required:13,urgency_level:'Normal',status:'Processing',request_date:null,donor_matching_started_at:null,
  fulfilled_units:7,remaining_units:6,inventory_units:7,donation_units:0,history_available:true,accepted_donors:[]};
let data,calls;
beforeEach(()=>{calls=[];data=null;axios.defaults.adapter=async config=>{calls.push(config);return {config,data,status:200,statusText:'OK',headers:{}};};});
after(()=>{axios.defaults.adapter=originalAdapter;});
test('partial quantities remain dynamic and come from allocation sources',()=>{
  const result=lifecycleRequestFields(row);assert.equal(result.fulfilled_units,7);assert.equal(result.remaining_units,6);
  assert.equal(result.inventory_units+result.donation_units,7);
});
for(const invalid of [{fulfilled_units:14},{remaining_units:7},{inventory_units:8},{donation_units:-1}])test('inconsistent fulfillment rejected '+JSON.stringify(invalid),()=>assert.throws(()=>lifecycleRequestFields({...row,...invalid}),/quantities/));
test('legacy fulfilled request preserves completed state without invented source history',()=>{
  const result=lifecycleRequestFields({...row,status:'Fulfilled',fulfilled_units:13,remaining_units:0,history_available:false,inventory_units:null,donation_units:null});
  assert.equal(result.fulfilled_units,13);assert.equal(result.inventory_units,null);assert.equal(result.donation_units,null);assert.equal(result.history_available,false);
});
test('secure operation keys are distinct UUID values',()=>{const left=newOperationKey();assert.match(left,/^[a-f0-9-]{36}$/i);assert.notEqual(left,newOperationKey());});
test('organization requests retain organization ownership and partial progress',async()=>{
  data={requests:[row]};const result=await fetchBankRequests(org,undefined,provider);assert.equal(result[0].remaining_units,6);
  data={requests:[{...row,organization_id:10}]};await assert.rejects(fetchBankRequests(org,undefined,provider),/Unexpected/);
});
test('hospital can retrieve clinical requests but cannot call stock APIs',async()=>{
  const hospital={...provider,organization_type:'Hospital'};data={requests:[row]};assert.equal((await fetchBankRequests(org,undefined,hospital)).length,1);
  const before=calls.length;await assert.rejects(fetchBankInventory(org,undefined,hospital));assert.equal(calls.length,before);
});
test('NGO cannot call clinical APIs',async()=>{await assert.rejects(fetchBankRequests(org,undefined,{...provider,organization_type:'NGO'}));assert.equal(calls.length,0);});
test('stock uses linked bank ID and expected version while preserving organization JWT',async()=>{
  data={bank_id:6,blood_group:'A+',units_available:22,version:8};await updateBankInventory(org,'A+',22,undefined,7,provider);
  assert.ok(calls[0].url.endsWith('/api/inventory/6/A%2B'));assert.equal(calls[0].headers.Authorization,'Bearer memory-org');
  assert.deepEqual(JSON.parse(calls[0].data),{units_available:22,expected_version:7});
});
test('inventory fulfillment sends caller operation key and returns partial source totals',async()=>{
  data={...row,source:'blood_bank',allocated_units:7};const result=await processBankRequest(org,12,undefined,uuid,provider);
  assert.deepEqual(JSON.parse(calls[0].data),{operation_key:uuid});assert.equal(result.remaining_units,6);assert.equal(result.status,'Processing');
});
test('matching invites without allocating stock',async()=>{
  data={request_id:12,notified_count:2};await findRequestDonors(org,12,undefined,provider);
  assert.ok(calls[0].url.endsWith('/api/allocations/match/12'));assert.deepEqual(JSON.parse(calls[0].data),{});
});
test('screening passed sends result independently of any donation units',async()=>{
  data={request_id:12,donor_id:4,screening_result:'Passed'};await recordDonorScreening(org,12,4,'Passed',undefined,provider);
  assert.deepEqual(JSON.parse(calls[0].data),{donor_id:4,result:'Passed'});
});
test('actual donation confirmation preserves dynamic units and retry UUID',async()=>{
  data={...row,fulfilled_units:12,remaining_units:1,donation_units:5,source:'donation',units_donated:5};
  const result=await recordActualDonation(org,12,4,5,uuid,undefined,provider);
  assert.deepEqual(JSON.parse(calls[0].data),{donor_id:4,units_donated:5,operation_key:uuid});assert.equal(result.fulfilled_units,12);assert.equal(result.remaining_units,1);
});
test('recipient contact is stripped before acceptance even if extra fields are returned',async()=>{
  data={requests:[{...row,donor_response:null,recipient:{name:'Patient',phone:'PRIVATE',password_hash:'SECRET'}}]};
  const result=await fetchDonorMatches(donor);assert.equal(result[0].recipient,null);assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('accepted Processing request retains safe coordination details only',async()=>{
  data={requests:[{...row,donor_response:'Accepted',recipient:{name:'Patient',age:24,gender:'Other',phone:'0123456789',email:'contact@example.test',address:'PRIVATE',password_hash:'SECRET'}}]};
  const result=await fetchDonorMatches(donor);assert.equal(result[0].recipient.name,'Patient');assert.equal(result[0].status,'Processing');
  assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('donor state and city setup uses self-owned endpoint',async()=>{
  data={state:'Maharashtra',city:'Pune'};assert.deepEqual(await updateDonorLocation(donor,'Maharashtra',' Pune '),data);
  assert.ok(calls[0].url.endsWith('/api/donors/me/location'));assert.deepEqual(JSON.parse(calls[0].data),{state:'Maharashtra',city:'Pune'});
});

test('historical bank-linked request remains accessible through its organization account',async()=>{
  data={requests:[{...row,organization_id:null}]};const result=await fetchBankRequests(org,undefined,provider);assert.equal(result.length,1);
  data={requests:[{...row,organization_id:null,bank_id:7}]};await assert.rejects(fetchBankRequests(org,undefined,provider),/Unexpected/);
});
test('legacy bank donation accepts the authenticated endpoint response without repeated actor ID',async()=>{
  const legacy={token:'legacy-bank',user:{user_id:6,user_type:'blood_bank'}};
  data={request_id:12,status:'Processing',fulfilled_units:12,remaining_units:1,inventory_units:7,donation_units:5,history_available:true,donation_id:18};
  const result=await recordActualDonation(legacy,12,4,5,uuid);assert.equal(result.fulfilled_units,12);assert.equal(result.remaining_units,1);
});

test('accepted cancelled request remains visible as response history',async()=>{
  data={requests:[{...row,status:'Cancelled',donor_response:'Accepted'}]};
  const result=await fetchDonorMatches(donor);assert.equal(result[0].status,'Cancelled');assert.equal(result[0].donor_response,'Accepted');
  data={requests:[{...row,status:'Cancelled',donor_response:null}]};await assert.rejects(fetchDonorMatches(donor),/Unexpected matching/);
});
