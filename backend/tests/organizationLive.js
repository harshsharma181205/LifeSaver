// Explicit live test only: temporary marked records are removed in finally.
process.env.DOTENV_QUIET = 'true';
const assert = require('node:assert/strict');
const express = require('express');
const cors = require('cors');
const { randomBytes, randomInt, randomUUID, createHash } = require('node:crypto');
const pool = require('../db');
const tag = 'Temp-LifeSaver-' + randomBytes(6).toString('hex');
const password = randomBytes(24).toString('hex');
const state = 'Uttar Pradesh', city = 'Ghaziabad';
const accounts = {};
for (const role of ['hospital','bank','donor','recipient','ngo','otherCity','unavailable','wrongGroup','secondDonor']) {
  accounts[role] = { name: tag + '-' + role, phone: '8' + randomInt(100000000,999999999), email: tag.toLowerCase() + '-' + role.toLowerCase() + '@example.invalid',
    password, state, city, address: 'Temporary automated test record; removed after verification.' };
}
accounts.hospital.organization_type = 'Hospital'; accounts.bank.organization_type = 'Blood Bank'; accounts.ngo.organization_type = 'NGO';
Object.assign(accounts.donor, { gender:'Other', blood_group:'A+', date_of_birth:'2000-01-01', is_available:true });
Object.assign(accounts.recipient, { gender:'Other', blood_group:'A+', age:25 });
let server, base, original, currentTest = 'setup', failure;
const passed = [];
async function snapshot() {
  const [tables] = await pool.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() ORDER BY TABLE_NAME');
  const result = {};
  for (const row of tables) {
    const [data] = await pool.query('SELECT * FROM `' + row.TABLE_NAME + '`');
    result[row.TABLE_NAME] = data.map(value => createHash('sha256').update(JSON.stringify(value)).digest('hex')).sort();
  }
  return result;
}
async function check(name, fn) { currentTest=name; await fn(); passed.push(name); console.log('PASS '+name); }
async function api(method, path, body, token) {
  const response = await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const data = await response.json();
  assert.ok(!/password_hash|"password"\s*:/.test(JSON.stringify(data)), 'API must never return credentials');
  return {status:response.status,data};
}
async function expect(method,path,body,token,status=200) {
  const result = await api(method,path,body,token);
  assert.equal(result.status,status,method+' '+path+' response status');
  return result.data;
}
async function readReport(method, query={}) {
  let result;
  const res={status(code){this.code=code;return this;},json(data){result=data;return this;}};
  await require('../controllers/adminController')[method]({query},res);
  assert.equal(res.code,200,method+' must execute its read-only report successfully');
  assert.ok(!/password_hash|"password"\s*:/.test(JSON.stringify(result)), 'Reports must never return credentials');
  return result;
}
async function login(role, identifier) {
  const response = await expect('POST','/api/auth/'+role+'/login',{identifier,password});
  assert.equal(typeof response.token,'string','Login token returned');
  return response.token;
}
function donorInput(account, overrides={}) { return {...accounts.donor,...account,...overrides}; }
async function createRequest(recipient, organization, required=3, group='A+') {
  return expect('POST','/api/requests',{recipient_id:recipient.id,organization_id:organization.organization_id,state,city,blood_group:group,units_required:required,urgency_level:'Emergency'},recipient.token,201);
}
async function stock(bank, amount, group='A+') {
  const inventory = await expect('GET','/api/inventory/'+bank.bank_id,undefined,bank.token);
  const row = inventory.inventory.find(r=>r.blood_group===group);
  return expect('PUT','/api/inventory/'+bank.bank_id+'/'+encodeURIComponent(group),{units_available:amount,expected_version:Number(row?.version||0)},bank.token);
}
async function match(id, token) { return expect('POST','/api/allocations/match/'+id,{},token); }
async function respond(id, donor, response='Accepted') { return expect('POST','/api/donors/me/requests/'+id+'/response',{response},donor.token,201); }
async function screen(id, donor, token, result='Passed') { return expect('POST','/api/screenings/'+id,{donor_id:donor.id,result},token); }
async function donate(id, donor, token, amount, key=randomUUID()) { return expect('POST','/api/donations/'+id,{donor_id:donor.id,units_donated:amount,operation_key:key},token); }
async function cleanup() {
  // Exact generated emails locate any registration whose response was interrupted.
  const emails = Object.values(accounts).map(a=>a.email);
  const placeholders = emails.map(()=>'?').join(',');
  const [donors] = await pool.query('SELECT donor_id FROM donors WHERE email IN ('+placeholders+')',emails);
  const [recipients] = await pool.query('SELECT recipient_id FROM recipients WHERE email IN ('+placeholders+')',emails);
  const [organizations] = await pool.query('SELECT organization_id FROM organizations WHERE email IN ('+placeholders+')',emails);
  const donorIds=donors.map(r=>r.donor_id), recipientIds=recipients.map(r=>r.recipient_id), orgIds=organizations.map(r=>r.organization_id);
  let connection;
  try {
    connection=await pool.getConnection(); await connection.beginTransaction();
    async function remove(table,column,ids){if(ids.length)await connection.execute('DELETE FROM '+table+' WHERE '+column+' IN ('+ids.map(()=>'?').join(',')+')',ids);}
    let requestIds=[];
    if(recipientIds.length){const [rows]=await connection.query('SELECT request_id FROM blood_requests WHERE recipient_id IN ('+recipientIds.map(()=>'?').join(',')+')',recipientIds);requestIds=rows.map(r=>r.request_id);}
    await remove('notifications','request_id',requestIds); await remove('notifications','donor_id',donorIds);await remove('notifications','recipient_id',recipientIds);
    await remove('request_allocations','request_id',requestIds);await remove('donations','donor_id',donorIds);await remove('donor_responses','request_id',requestIds);
    await remove('blood_requests','request_id',requestIds);
    if(orgIds.length){const [banks]=await connection.query('SELECT bank_id FROM blood_banks WHERE organization_id IN ('+orgIds.map(()=>'?').join(',')+')',orgIds);await remove('blood_inventory','bank_id',banks.map(r=>r.bank_id));}
    await remove('donors','donor_id',donorIds);await remove('recipients','recipient_id',recipientIds);await remove('blood_banks','organization_id',orgIds);await remove('organizations','organization_id',orgIds);
    await connection.commit();
  } catch(error){if(connection)await connection.rollback();throw error;}
  finally {if(connection)connection.release();}
}
(async()=>{
 try {
  original=await snapshot();
  const app=express();app.use(cors());app.use(express.json());
  app.get('/',(req,res)=>res.json({message:'LifeSaver backend is running'}));
  for(const [url,file] of [['donors','donor'],['recipients','recipient'],['auth','auth'],['organizations','organization'],['requests','request'],['inventory','inventory'],['blood-banks','bank'],['allocations','allocation'],['screenings','screening'],['donations','donation'],['notifications','notification'],['admin','admin']]) app.use('/api/'+url,require('../routes/'+file+'Routes'));
  app.use((error,req,res,next)=>res.status(error.type==='entity.too.large'?413:error.type==='entity.parse.failed'?400:500).json({message:'Request could not be processed.'}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));base='http://127.0.0.1:'+server.address().port;
  const {runLiveFrontend}=await import('./helpers/liveFrontend.mjs');
  let created;
  await check('Real Chrome registration, login, state/city request, acceptance, privacy, screening, donation 1 then inventory 2',async()=>{
    created=await runLiveFrontend(base,accounts);
  });
  const bank={...created.bank,token:await login('organization',accounts.bank.email)};
  const hospital={...created.hospital,token:await login('organization',accounts.hospital.phone)};
  const recipient={id:created.recipient.recipient_id,token:await login('recipient',accounts.recipient.email)};
  const donor={id:created.donor.donor_id,token:await login('donor',accounts.donor.phone)};
  const first=created.request_id;
  await check('Actual allocation sources are inventory 2 plus donation 1; no fake donation for stock',async()=>{
    const detail=await expect('GET','/api/requests/'+first,undefined,recipient.token);
    assert.equal(detail.request.status,'Fulfilled');assert.equal(detail.request.fulfilled_units,3);assert.equal(detail.request.inventory_units,2);assert.equal(detail.request.donation_units,1);
    const [rows]=await pool.query('SELECT COUNT(*) AS count,SUM(units_donated) AS units FROM donations WHERE donor_id=?',[donor.id]);assert.equal(rows[0].count,1);assert.equal(Number(rows[0].units),1);
  });
  await check('Fresh fulfillment after completion fails safely',async()=>{await expect('POST','/api/allocations/process/'+first,{operation_key:randomUUID()},bank.token,409);});
  await check('Donor and recipient legacy phone payload login remains compatible',async()=>{
    for(const [role,account]of[['donor',accounts.donor],['recipient',accounts.recipient]]) await expect('POST','/api/auth/'+role+'/login',{phone:account.phone,password},undefined);
  });
  await check('Legacy bank email login, token bank identity and me remain compatible',async()=>{
    const response=await expect('POST','/api/auth/blood-bank/login',{email:accounts.bank.email,password},undefined);
    assert.equal(response.user.user_type,'blood_bank');assert.equal(response.user.user_id,bank.bank_id);
    const me=await expect('GET','/api/auth/me',undefined,response.token);assert.equal(me.user_id,bank.bank_id);
  });
  await check('Hospital cannot use legacy bank login or edit Blood Bank inventory',async()=>{
    await expect('POST','/api/auth/blood-bank/login',{email:accounts.hospital.email,password},undefined,401);
    await expect('PUT','/api/inventory/'+hospital.bank_id+'/A%2B',{units_available:5,expected_version:0},hospital.token,403);
  });
  const ngoData=await expect('POST','/api/organizations',accounts.ngo,undefined,201);
  const ngo={...ngoData.organization,token:await login('organization',accounts.ngo.email)};
  await check('NGO has no provider record and no clinical or stock permission',async()=>{
    assert.equal(ngo.bank_id,null);await expect('POST','/api/allocations/match/'+first,{},ngo.token,403);
    const directory=await expect('GET','/api/organizations?state='+encodeURIComponent(state)+'&city='+city,undefined,recipient.token);
    assert.ok(directory.organizations.some(o=>o.organization_id===bank.organization_id));assert.ok(directory.organizations.some(o=>o.organization_id===hospital.organization_id));assert.ok(!directory.organizations.some(o=>o.organization_id===ngo.organization_id));
  });
  await check('Frontend selection has real database cities and empty provider result',async()=>{
    const result=await expect('GET','/api/organizations/cities?state='+encodeURIComponent(state),undefined,recipient.token);assert.ok(result.cities.includes(city));
    const empty=await expect('GET','/api/organizations?state='+encodeURIComponent(state)+'&city=UnregisteredTestCity',undefined,recipient.token);assert.equal(empty.organizations.length,0);
  });
  await check('Wrong provider location and arbitrary status rejected',async()=>{
    const body={recipient_id:recipient.id,organization_id:bank.organization_id,state,city:'Noida',blood_group:'A+',units_required:4};
    await expect('POST','/api/requests',body,recipient.token,400);
    await expect('POST','/api/requests',{...body,city,status:'Fulfilled'},recipient.token,400);
  });
  const extras={};
  for(const role of ['otherCity','unavailable','wrongGroup','secondDonor']){
    const result=await expect('POST','/api/donors',donorInput(accounts[role],role==='otherCity'?{city:'Noida'}:role==='unavailable'?{is_available:false}:role==='wrongGroup'?{blood_group:'O+'}:{}),undefined,201);
    extras[role]={id:result.donor_id,token:await login('donor',accounts[role].email)};
  }
  const failed=(await createRequest(recipient,bank,5)).request_id;await match(failed,bank.token);
  await check('Matching requires exact group, availability and same state/city',async()=>{
    assert.ok((await expect('GET','/api/donors/me/matching-requests',undefined,donor.token)).requests.some(r=>r.request_id===failed));
    for(const role of ['otherCity','unavailable','wrongGroup'])assert.ok(!(await expect('GET','/api/donors/me/matching-requests',undefined,extras[role].token)).requests.some(r=>r.request_id===failed));
    await expect('POST','/api/donors/me/requests/'+failed+'/response',{response:'Accepted'},extras.otherCity.token,409);
  });
  await respond(failed,donor);
  await check('Screening Failed never creates donations, stock or allocation units',async()=>{
    await screen(failed,donor,bank.token,'Failed');await expect('POST','/api/donations/'+failed,{donor_id:donor.id,units_donated:1,operation_key:randomUUID()},bank.token,409);
    const detail=(await expect('GET','/api/requests/'+failed,undefined,recipient.token)).request;assert.equal(detail.fulfilled_units,0);assert.equal(detail.status,'Processing');assert.ok(!detail.accepted_donors[0].phone);
    await expect('POST','/api/screenings/'+failed,{donor_id:donor.id,result:'Passed'},bank.token,409);
  });
  await check('Another local donor can accept an open Processing request after failed screening',async()=>{await respond(failed,extras.secondDonor);});
  const declined=(await createRequest(recipient,bank,4)).request_id;await match(declined,bank.token);
  await check('Decline leaves request open and duplicate/conflicting responses are safe',async()=>{
    await respond(declined,donor,'Declined');await expect('POST','/api/donors/me/requests/'+declined+'/response',{response:'Declined'},donor.token,200);
    await expect('POST','/api/donors/me/requests/'+declined+'/response',{response:'Accepted'},donor.token,409);
    assert.equal((await expect('GET','/api/requests/'+declined,undefined,recipient.token)).request.status,'Pending');
  });
  const partial=(await createRequest(recipient,bank,10)).request_id;
  await stock(bank,3);
  let inventoryKey=randomUUID();
  await check('Dynamic 10-unit request: inventory 3 remains Processing, requiring 7',async()=>{
    const response=await expect('POST','/api/allocations/process/'+partial,{operation_key:inventoryKey},bank.token);assert.equal(response.fulfilled_units,3);assert.equal(response.remaining_units,7);assert.equal(response.status,'Processing');
    const retry=await expect('POST','/api/allocations/process/'+partial,{operation_key:inventoryKey},bank.token);assert.equal(retry.fulfilled_units,3);
  });
  await respond(partial,donor);await screen(partial,donor,bank.token);
  const donationKey=randomUUID();
  await check('Dynamic donor 2 plus inventory 3 totals 5 of 10, with idempotent retry',async()=>{
    const response=await donate(partial,donor,bank.token,2,donationKey);assert.equal(response.fulfilled_units,5);assert.equal(response.remaining_units,5);assert.equal(response.status,'Processing');
    await donate(partial,donor,bank.token,2,donationKey);
    await expect('POST','/api/donations/'+partial,{donor_id:donor.id,units_donated:3,operation_key:donationKey},bank.token,409);
    await expect('POST','/api/donations/'+partial,{donor_id:donor.id,units_donated:6,operation_key:randomUUID()},bank.token,409);
    const reopened=(await expect('GET','/api/donors/me/matching-requests',undefined,donor.token)).requests.find(request=>request.request_id===partial);
    assert.ok(reopened,'Accepted partial request remains available on donor dashboard reload');
    assert.deepEqual([reopened.fulfilled_units,reopened.remaining_units,reopened.inventory_units,reopened.donation_units],[5,5,3,2]);
    assert.equal(reopened.history_available,true);assert.equal(reopened.recipient.phone,accounts.recipient.phone);
  });
  await check('Stale stock form cannot restore deducted inventory',async()=>{
    await expect('PUT','/api/inventory/'+bank.bank_id+'/A%2B',{units_available:3,expected_version:0},bank.token,409);
  });
  const concurrent=(await createRequest(recipient,bank,1)).request_id;await stock(bank,2);
  await check('Actual MySQL lock contention: two operations compete for one remaining unit',async()=>{
    const blocker=await pool.getConnection();let released=false;
    try{
      await blocker.beginTransaction();await blocker.execute('SELECT request_id FROM blood_requests WHERE request_id=? FOR UPDATE',[concurrent]);
      let settled=0;
      const one=api('POST','/api/allocations/process/'+concurrent,{operation_key:randomUUID()},bank.token).then(r=>{settled++;return r;});
      const two=api('POST','/api/allocations/process/'+concurrent,{operation_key:randomUUID()},bank.token).then(r=>{settled++;return r;});
      await new Promise(r=>setTimeout(r,200));assert.equal(settled,0,'Both operations wait for the actual MySQL row lock');
      await blocker.commit();released=true;
      const results=await Promise.all([one,two]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
      const detail=(await expect('GET','/api/requests/'+concurrent,undefined,recipient.token)).request;assert.equal(detail.fulfilled_units,1);assert.equal(detail.remaining_units,0);
      const [rows]=await pool.query('SELECT units_available FROM blood_inventory WHERE bank_id=? AND blood_group=?',[bank.bank_id,'A+']);assert.equal(rows[0].units_available,1);
    }finally{if(!released)await blocker.rollback();blocker.release();}
  });
  await check('Provider ownership and donor role prevent unauthorized fulfillment',async()=>{
    await expect('POST','/api/allocations/process/'+partial,{operation_key:randomUUID()},hospital.token,404);
    await expect('POST','/api/allocations/process/'+partial,{operation_key:randomUUID()},donor.token,403);
    await expect('GET','/api/requests/'+partial,undefined,hospital.token,404);
  });
  await check('Cancellation preserves actual contribution history and sends notifications',async()=>{
    await expect('PATCH','/api/requests/'+partial+'/cancel',{},recipient.token);
    const detail=(await expect('GET','/api/requests/'+partial,undefined,recipient.token)).request;assert.equal(detail.status,'Cancelled');assert.equal(detail.fulfilled_units,5);
    await expect('POST','/api/donations/'+partial,{donor_id:donor.id,units_donated:1,operation_key:randomUUID()},bank.token,409);
    const notifications=await expect('GET','/api/notifications/recipient/'+recipient.id,undefined,recipient.token);assert.ok(notifications.notifications.some(n=>n.message.includes('cancelled')));assert.ok(notifications.notifications.some(n=>n.message.includes('donated')));
    assert.ok(notifications.notifications.every(n=>n.channel==='InApp'));
  });
  await check('Hospital can manage its own medical request without inventory edits',async()=>{
    const request=(await createRequest(recipient,hospital,2)).request_id;await match(request,hospital.token);await respond(request,extras.secondDonor);await screen(request,extras.secondDonor,hospital.token);
    const result=await donate(request,extras.secondDonor,hospital.token,2);assert.equal(result.status,'Fulfilled');assert.equal(result.donation_units,2);assert.equal(result.inventory_units,0);
  });
  await check('Admin report SQL works; existing unsupported admin authentication stays safely denied',async()=>{
    await expect('GET','/api/admin/dashboard',undefined,bank.token,403);
    const dashboard=await readReport('getDashboard');assert.equal(typeof dashboard.total_organizations,'number');
    const allocations=await readReport('getAllocationReport');assert.equal(typeof allocations.summary.inventory_units,'number');assert.equal(typeof allocations.summary.donation_units,'number');
    const requests=await readReport('getRequestReport');assert.equal(typeof requests.summary.total_requests,'number');assert.ok(Array.isArray(requests.recent_requests));
    const donors=await readReport('getDonorReport');assert.equal(typeof donors.summary.total_donors,'number');assert.ok(Array.isArray(donors.by_blood_group));
    const donations=await readReport('getDonationReport');assert.equal(typeof donations.summary.total_units_donated,'number');assert.ok(Array.isArray(donations.by_month));
  });
  await check('Inventory report excludes Hospital companions and retains genuine Blood Bank stock',async()=>{
    const report=await readReport('getInventoryReport');
    assert.ok(!report.banks_without_inventory.some(row=>row.bank_id===hospital.bank_id),'Hospital companion must not be a Blood Bank without inventory');
    assert.ok(!report.bank_wise_stock.some(row=>row.bank_id===hospital.bank_id),'Hospital companion must not enter Blood Bank stock');
    assert.ok(!report.low_or_zero_stock.some(row=>row.bank_id===hospital.bank_id),'Hospital companion must not enter low-stock lists');
    assert.ok(report.bank_wise_stock.some(row=>row.bank_id===bank.bank_id&&row.blood_group==='A+'),'Registered Blood Bank actual stock must remain in its report');
    assert.ok(!report.banks_without_inventory.some(row=>row.bank_id===bank.bank_id),'A Blood Bank with recorded stock must not be listed as unrecorded');
    const [validStock]=await pool.query("SELECT i.inventory_id FROM blood_inventory i JOIN blood_banks b ON b.bank_id=i.bank_id LEFT JOIN organizations o ON o.organization_id=b.organization_id WHERE b.organization_id IS NULL OR o.organization_type='Blood Bank'");
    assert.deepEqual(report.bank_wise_stock.map(row=>row.inventory_id).sort((a,b)=>a-b),validStock.map(row=>row.inventory_id).sort((a,b)=>a-b),'All genuine Blood Bank inventory remains represented');
  });
  await check('Stock and allocation invariants hold in real MySQL',async()=>{
    const [rows]=await pool.query('SELECT COUNT(*) AS invalid FROM blood_inventory WHERE units_available<0');assert.equal(rows[0].invalid,0);
    const [bad]=await pool.query('SELECT COUNT(*) AS invalid FROM (SELECT r.request_id,r.units_required,COALESCE(SUM(a.units_allocated),0) AS fulfilled FROM blood_requests r LEFT JOIN request_allocations a ON a.request_id=r.request_id GROUP BY r.request_id,r.units_required HAVING fulfilled>r.units_required) violations');assert.equal(bad[0].invalid,0);
  });
 }catch(error){failure=error;console.error('FAIL '+currentTest+': '+(error instanceof assert.AssertionError?error.message:(error.code||error.name)));}
 finally{
  try{await cleanup();if(original)assert.deepEqual(await snapshot(),original,'Every pre-test record must be restored exactly');console.log('CLEANUP VERIFIED: all temporary records removed; every pre-test record unchanged.');}
  catch(error){failure=error;console.error('CLEANUP FAILED: '+(error.code||error.name));}
  if(server)await new Promise(resolve=>server.close(resolve));await pool.end();
 }
 console.log('Live checks completed: '+passed.length+'.');
 if(failure)process.exitCode=1;
})();
