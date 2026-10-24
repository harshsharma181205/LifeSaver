import { providerQueueFixture } from './helpers/providerQueueFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authFixture, startBrowser, pause } from './helpers/recipientBrowser.js';
const chromePath=process.env.CHROME_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';

test('registered provider, acceptance, screening, inventory and actual donation browser journey',{
  timeout:180000,skip:!fs.existsSync(chromePath)&&'Set CHROME_PATH to run browser checks.',
},async suite=>{
  const browser=await startBrowser(chromePath);
  const organization={organization_id:9,organization_type:'Blood Bank',name:'Registered Provider',bank_id:6,
    state:'Maharashtra',city:'Pune',address:'Registered address',phone:'02012345678',email:'provider@example.test'};
  const state={request:null,matching:false,accepted:false,screening:null,inventory:2,inventoryUnits:0,donationUnits:0,donations:0,keys:new Set()};
  function progress(){
    const fulfilled=state.inventoryUnits+state.donationUnits;
    return {...state.request,fulfilled_units:fulfilled,remaining_units:state.request.units_required-fulfilled,
      inventory_units:state.inventoryUnits,donation_units:state.donationUnits,history_available:true,
      organization_id:9,organization_name:organization.name,organization_type:'Blood Bank',state:'Maharashtra',city:'Pune',bank_id:6,
      bank_name:organization.name,bank_address:organization.address,bank_phone:organization.phone,bank_email:organization.email,
      donor_matching_started_at:state.matching?'2026-10-07T06:30:00.000Z':null,
      accepted_donors:state.accepted?[{donor_id:4,name:'Accepted Donor',blood_group:'A+',phone:'9876543999',email:'donor@example.test',screening_result:state.screening,screened_at:state.screening?'2026-10-07T06:30:00.000Z':null}]:[]};
  }
  function identity(request){const header=request.headers.Authorization||request.headers.authorization;assert.match(header||'',/^Bearer /);return JSON.parse(Buffer.from(header.slice(7).split('.')[1],'base64url'));}
  browser.mock(async(request,url)=>{
    const owner=identity(request);
    const body=request.postData?JSON.parse(request.postData):{};
    if(request.method==='GET'&&url.pathname==='/api/auth/me'){
      if(owner.user_type==='organization')return {body:{...organization,user_id:9,user_type:'organization'}};
      if(owner.user_type==='donor')return {body:{user_id:4,user_type:'donor',name:'Accepted Donor',blood_group:'A+',state:'Maharashtra',city:'Pune',location:'Pune',is_available:1}};
      return {body:{user_id:16,user_type:'recipient',name:'Recipient Patient'}};
    }
    if(request.method==='GET'&&url.pathname==='/api/organizations/cities')return {body:{cities:['Pune']}};
    if(request.method==='GET'&&url.pathname==='/api/organizations')return {body:{organizations:[organization]}};
    if(request.method==='POST'&&url.pathname==='/api/requests'){
      assert.equal(owner.user_type,'recipient');assert.equal(body.organization_id,9);assert.equal(body.city,'Pune');assert.equal(body.state,'Maharashtra');
      state.request={...body,request_id:12,request_date:'2026-10-07T06:30:00.000Z',status:'Pending'};
      return {status:201,body:{request_id:12}};
    }
    if(request.method==='GET'&&url.pathname==='/api/requests/provider-queue')return {body:providerQueueFixture(state.request?[progress()]:[],{bankId:6,organizationId:9})};
    if(request.method==='GET'&&url.pathname==='/api/requests')return {body:{requests:state.request?[progress()]:[]}};
    if(request.method==='GET'&&url.pathname==='/api/requests/12')return {body:{request:progress()}};
    if(request.method==='GET'&&url.pathname==='/api/inventory/6')return {body:{bank_id:6,inventory:[{inventory_id:7,bank_id:6,blood_group:'A+',units_available:state.inventory,updated_at:null,version:0}]}};
    if(request.method==='POST'&&url.pathname==='/api/allocations/match/12'){
      assert.equal(owner.user_type,'organization');assert.deepEqual(body,{});state.matching=true;return {body:{request_id:12,notified_count:1}};
    }
    if(request.method==='GET'&&url.pathname==='/api/donors/me/matching-requests'){
      return {body:{requests:state.matching?[{...progress(),donor_response:state.accepted?'Accepted':null,screening_result:state.screening,
        recipient:state.accepted?{name:'Recipient Patient',age:25,gender:'Other',phone:'9876543888',email:'patient@example.test'}:undefined}]:[]}};
    }
    if(request.method==='GET'&&url.pathname==='/api/notifications/donor/4')return {body:{user_id:4,user_type:'donor',notifications:[]}};
    if(request.method==='POST'&&url.pathname==='/api/donors/me/requests/12/response'){
      assert.equal(owner.user_type,'donor');assert.deepEqual(body,{response:'Accepted'});state.accepted=true;state.request.status='Processing';
      return {status:201,body:{request_id:12,response:'Accepted',status:'Processing'}};
    }
    if(request.method==='POST'&&url.pathname==='/api/screenings/12'){
      assert.equal(owner.user_type,'organization');assert.equal(body.donor_id,4);state.screening=body.result;
      return {body:{request_id:12,donor_id:4,screening_result:body.result}};
    }
    if(request.method==='POST'&&url.pathname==='/api/allocations/process/12'){
      assert.equal(owner.user_type,'organization');assert.match(body.operation_key,/^[a-f0-9-]{36}$/i);
      const allocated=Math.min(state.inventory,progress().remaining_units);state.inventory-=allocated;state.inventoryUnits+=allocated;state.keys.add(body.operation_key);
      state.request.status=progress().remaining_units===0?'Fulfilled':'Processing';
      return {body:{...progress(),source:'blood_bank',allocated_units:allocated}};
    }
    if(request.method==='POST'&&url.pathname==='/api/donations/12'){
      assert.equal(owner.user_type,'organization');assert.equal(state.screening,'Passed');assert.equal(body.donor_id,4);assert.equal(body.units_donated,1);
      assert.match(body.operation_key,/^[a-f0-9-]{36}$/i);assert.ok(!state.keys.has(body.operation_key));state.keys.add(body.operation_key);
      state.donationUnits+=body.units_donated;state.donations+=1;state.request.status=progress().remaining_units===0?'Fulfilled':'Processing';
      return {status:201,body:{...progress(),source:'donation',units_donated:body.units_donated}};
    }
    throw new Error('Unexpected lifecycle fixture '+request.method+' '+url.pathname);
  });
  const text=selector=>browser.evaluate('document.querySelector('+JSON.stringify(selector)+')?.textContent||""');
  const waitText=(selector,value)=>browser.wait('(document.querySelector('+JSON.stringify(selector)+')?.textContent||"").includes('+JSON.stringify(value)+')');
  async function providerDashboard(){await browser.seed(authFixture('organization',9),'/organization/dashboard');await waitText('.bank-requests','Request #12');}
  try{
    await suite.test('recipient selects database-backed state city and registered provider',async()=>{
      await browser.seed(authFixture('recipient',16),'/recipient/requests/create');await browser.wait('Boolean(document.querySelector("#request-state"))');
      await browser.input('#request-state','Maharashtra');await browser.wait('Array.from(document.querySelector("#request-city").options).some(option=>option.value==="Pune")');
      await browser.input('#request-city','Pune');await browser.wait('Array.from(document.querySelector("#request-organization").options).some(option=>option.value==="9")');
      await browser.input('#request-organization','9');await browser.input('#request-blood-group','A+');await browser.input('#request-units','3');await browser.click('.create-request-form button[type=submit]');
      await waitText('.create-request-success','created successfully');assert.equal(state.request.units_required,3);assert.equal(state.request.status,'Pending');
    });
    await suite.test('matching leaves request Pending and inventory unchanged',async()=>{
      await providerDashboard();await browser.click('.bank-request-actions .bank-secondary');await waitText('.bank-notice','eligible donors');
      assert.equal(state.request.status,'Pending');assert.equal(state.inventory,2);assert.equal(state.donations,0);
    });
    await suite.test('acceptance changes to Processing and reveals safe recipient coordination details',async()=>{
      await browser.seed(authFixture('donor',4),'/donor/dashboard');await waitText('.donor-matches','Request #12');
      assert.ok(!(await text('.donor-matches')).includes('9876543888'));await browser.click('.donor-accept');
      await waitText('.donor-accepted','Recipient Patient');await waitText('.donor-matches','Processing');assert.equal(state.request.status,'Processing');assert.equal(state.donations,0);assert.equal(state.inventory,2);
    });
    await suite.test('recipient sees accepted donor contacts while quantity remains zero',async()=>{
      await browser.seed(authFixture('recipient',16),'/recipient/requests/12');await waitText('.accepted-donor-list','9876543999');
      assert.ok((await text('.request-fulfillment')).includes('0 / 3 units fulfilled'));
    });
    await suite.test('authorized screening passed does not record donation or fulfill units',async()=>{
      await providerDashboard();await browser.click('.bank-donor-card .bank-request-actions .bank-secondary');await waitText('.bank-notice','screening passed');
      await waitText('.bank-donor-card','Screening: Passed');assert.equal(state.donations,0);assert.equal(progress().fulfilled_units,0);assert.equal(state.request.status,'Processing');
    });
    await suite.test('two inventory units produce partial Processing fulfillment',async()=>{
      await browser.click('.bank-process');await waitText('.bank-notice','2/3 fulfilled');await waitText('.bank-request-card','Inventory: 2 units');
      assert.equal(state.inventory,0);assert.equal(progress().remaining_units,1);assert.equal(state.donations,0);assert.equal(state.request.status,'Processing');
    });
    await suite.test('actual donation fills the remaining unit with a separate operation key',async()=>{
      await browser.wait('Boolean(document.querySelector(".bank-donation-form input"))');await browser.input('.bank-donation-form input','1');await browser.click('.bank-donation-form button');
      await waitText('.bank-notice','is Fulfilled');await waitText('.bank-request-card','Donation: 1 units');assert.equal(state.donations,1);assert.equal(state.inventory,0);assert.equal(state.keys.size,2);
    });
    await suite.test('recipient sees complete source totals and no cancellation action',async()=>{
      await browser.seed(authFixture('recipient',16),'/recipient/requests/12');await waitText('.request-fulfillment','3 / 3 units fulfilled');
      assert.ok((await text('.request-fulfillment')).includes('Inventory: 2 units'));assert.ok((await text('.request-fulfillment')).includes('Donation: 1 units'));
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".request-cancel"))'),false);
    });
    await pause(80);assert.deepEqual(browser.browserErrors,[]);assert.deepEqual(browser.failures,[]);
  }finally{await browser.close();}
});
