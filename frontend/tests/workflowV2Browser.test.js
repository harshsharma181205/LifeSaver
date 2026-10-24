import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authFixture, pause, startBrowser } from './helpers/recipientBrowser.js';
import { hospitalHelp } from '../src/services/workflowV2Api.js';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('V2 admission, city-wide Banks, designation, contributions and notifications in Chrome using memory-only APIs', {
  timeout: 180000, skip: !fs.existsSync(chromePath) && 'Set CHROME_PATH to run browser checks.',
}, async suite => {
  const browser = await startBrowser(chromePath);
  const hospital = { organization_id: 11, organization_type: 'Hospital', name: 'Admission Hospital', bank_id: 18,
    state: 'Maharashtra', city: 'Pune', address: 'Hospital address', phone: '02012345678', email: 'hospital@example.test' };
  const banks = [{ organization_id: 9, organization_type: 'Blood Bank', bank_id: 6, name: 'First Blood Bank', bank_name: 'First Blood Bank',
    state: 'Maharashtra', city: 'Pune', address: 'First collection address', phone: '02012345679', email: 'bank@example.test' },
    { organization_id: 10, organization_type: 'Blood Bank', bank_id: 7, name: 'Second Blood Bank', bank_name: 'Second Blood Bank',
      state: 'Maharashtra', city: 'Pune', address: 'Second collection address', phone: '02012345670', email: 'second@example.test' }];
  const state = { request: null, matching: false, acceptedBank: null, screening: null,
    inventory: { 6: 3, 7: 1 }, inventoryUnits: 0, donationUnits: 0, contributions: [], notificationRead: false, collection: null };
  function requestRow() {
    if (!state.request) return null;
    return { ...state.request, workflow_version: 2, bank_id: null, organization_id: null,
      admission_hospital_id: 11, admission_hospital_name: hospital.name,
      fulfilled_units: state.inventoryUnits + state.donationUnits,
      remaining_units: state.request.units_required - state.inventoryUnits - state.donationUnits,
      inventory_units: state.inventoryUnits, donation_units: state.donationUnits, history_available: true,
      contributions: state.contributions.map(row => ({ ...row })), accepted_donors: [],
      donor_matching_started_at: state.matching ? '2026-10-07T06:30:00.000Z' : null };
  }
  function profile(identity) {
    if (identity.user_type === 'recipient') return { user_id: identity.user_id, user_type: 'recipient', name: 'Recipient Patient' };
    if (identity.user_type === 'donor') return { user_id: 4, user_type: 'donor', name: 'Available Donor', blood_group: 'A+', state: 'Maharashtra', city: 'Pune', location: 'Pune', is_available: 1 };
    return { ...(identity.user_id === 11 ? hospital : banks.find(row => row.organization_id === identity.user_id)), user_id: identity.user_id, user_type: 'organization' };
  }
  function scoped(identity) {
    const row = requestRow(); if (!row) return [];
    const current = profile(identity);
    const donors = current.organization_type === 'Blood Bank' && current.bank_id === state.acceptedBank
      ? [{ donor_id: 4, name: 'Available Donor', blood_group: 'A+', phone: '9876543999', email: 'donor@example.test', collecting_bank_id: state.acceptedBank, ...(state.collection ?? {}), screening_result: state.screening, screened_at: state.screening ? '2026-10-07T06:30:00.000Z' : null }] : [];
    return [{ ...row, contributions: current.organization_type === 'Blood Bank' ? row.contributions.filter(item => item.bank_id === current.bank_id) : row.contributions, can_supply: current.organization_type === 'Blood Bank' && current.city === row.city, accepted_donors: donors }];
  }
  const calls = [];
  function install(enabled = true, config = {}) {
    browser.mock(async (request, url) => {
      calls.push({ method: request.method, path: url.pathname, body: request.postData ? JSON.parse(request.postData) : null });
      if (request.method === 'POST' && url.pathname === '/api/organizations') {
        const body = JSON.parse(request.postData);
        return { status: 201, body: { organization: { organization_id: 20 } } };
      }
      const header = request.headers.Authorization || request.headers.authorization;
      assert.match(header || '', /^Bearer /);
      const identity = JSON.parse(Buffer.from(header.slice(7).split('.')[1], 'base64url'));
      const current = profile(identity);
      const body = request.postData ? JSON.parse(request.postData) : {};
      if (url.pathname === '/api/auth/me') return { body: current };
      if (url.pathname === '/api/organizations/cities') { assert.equal(url.searchParams.get('organization_type'), enabled ? 'Hospital' : null); return { body: { cities: ['Pune'] } }; }
      if (url.pathname === '/api/organizations') { assert.equal(url.searchParams.get('organization_type'), enabled ? 'Hospital' : null); return { body: { organizations: [hospital] } }; }
      if (request.method === 'POST' && url.pathname === '/api/requests') {
        assert.deepEqual(Object.keys(body).sort(), ['admission_hospital_id', 'blood_group', 'city', 'state', 'units_required', 'urgency_level']);
        assert.equal(body.admission_hospital_id, 11);
        state.request = { ...body, request_id: 12, request_date: '2026-10-07T06:30:00.000Z', status: 'Pending' };
        return { status: 201, body: { request_id: 12 } };
      }
      if (request.method === 'GET' && url.pathname === '/api/requests') return { body: { requests: scoped(identity) } };
      if (request.method === 'GET' && url.pathname === '/api/requests/12') return { body: { request: requestRow() } };
      if (request.method === 'GET' && url.pathname === '/api/requests/provider-queue') {
        const row = requestRow();
        const queue = row && row.remaining_units > 0 && current.organization_type === 'Blood Bank' && current.city === row.city ? [{ ...row, position: 1, priority: row.urgency_level === 'Emergency' ? 0 : 1,
          waiting_seconds: 3600, long_waiting_normal: false, time_warning: null, selection_reason: 'Emergency priority 0. FCFS uses creation time; ID breaks ties.' }] : [];
        return { body: { bank_id: current.bank_id, organization_id: identity.user_id, algorithm: 'Non-preemptive Priority + FCFS',
          generated_at: new Date().toISOString(), long_wait_threshold_seconds: 86400, queue } };
      }
      if (request.method === 'GET' && /^\/api\/inventory\/(6|7)$/.test(url.pathname)) return { body: { bank_id: current.bank_id,
        inventory: [{ inventory_id: current.bank_id, bank_id: current.bank_id, blood_group: 'A+', units_available: state.inventory[current.bank_id], version: 0, updated_at: null }] } };
      if (request.method === 'GET' && url.pathname === '/api/notifications/me') return { body: { notifications: [{ notification_id: 1, request_id: 12,
        source: 'workflow', message: 'Your request has a workflow update', is_read: Number(state.notificationRead), sent_at: null }] } };
      if (request.method === 'PATCH' && url.pathname === '/api/notifications/me/1/read') {
        assert.deepEqual(body, { source: 'workflow' }); state.notificationRead = true; return { body: { notification_id: 1, is_read: 1 } };
      }
      if (url.pathname === '/api/notifications/donor/4') return { body: { user_id: 4, user_type: 'donor', notifications: [] } };
      if (request.method === 'GET' && url.pathname === '/api/donors/me/matching-requests') return { body: { requests: state.matching ? [{ ...requestRow(),
        donor_response: state.acceptedBank ? 'Accepted' : null, ...(state.collection ?? {}), screening_result: state.screening,
        collecting_bank_id: state.acceptedBank, collecting_bank_name: banks.find(bank => bank.bank_id === state.acceptedBank)?.name,
        eligible_collecting_banks: banks.map(bank => ({ ...bank })), recipient: state.acceptedBank ? { name: 'Recipient Patient' } : undefined }] : [] } };
      if (request.method === 'POST' && url.pathname === '/api/donors/me/requests/12/response') {
        assert.equal(body.collecting_bank_id, 7); assert.equal(body.response, 'Accepted'); state.acceptedBank = body.collecting_bank_id;
        state.request.status = 'Processing'; return { status: 201, body: { request_id: 12, response: 'Accepted', status: 'Processing' } };
      }
      if (request.method === 'POST' && url.pathname === '/api/allocations/match/12') {
        assert.equal(current.organization_type, 'Blood Bank'); assert.deepEqual(body, {}); state.matching = true; return { body: { request_id: 12, notified_count: 1 } };
      }
      if (request.method === 'POST' && url.pathname === '/api/allocations/process/12') {
        assert.equal(current.organization_type, 'Blood Bank'); assert.deepEqual(Object.keys(body), ['operation_key']);
        const allocated = Math.min(state.inventory[current.bank_id], requestRow().remaining_units);
        state.inventory[current.bank_id] -= allocated; state.inventoryUnits += allocated;
        if (allocated) state.contributions.push({ bank_id: current.bank_id, bank_name: current.name, source: 'Inventory', units_allocated: allocated, allocated_at: null });
        state.request.status = requestRow().remaining_units ? 'Processing' : 'Fulfilled';
        return { body: { ...requestRow(), actor_bank_id: current.bank_id, allocated_units: allocated } };
      }
      if (request.method === 'POST' && url.pathname === '/api/screenings/12') {
        assert.equal(current.bank_id, state.acceptedBank); assert.equal(body.donor_id, 4); state.screening = body.result;
        return { body: { request_id: 12, donor_id: 4, screening_result: state.screening } };
      }
      if (request.method === 'POST' && url.pathname === '/api/donations/12') {
        assert.equal(current.bank_id, state.acceptedBank); assert.equal(state.screening, 'Passed'); assert.equal(body.donor_id, 4);
        assert.equal(state.collection, null); state.collection = { collection_id: 90, units_collected: body.units_donated, accounting_path: body.accounting_path };
        if (body.accounting_path === 'Inventory') state.inventory[current.bank_id] += body.units_donated;
        else { assert.equal(body.accounting_path, 'DirectRequest'); state.donationUnits += body.units_donated;
          state.contributions.push({ bank_id: current.bank_id, bank_name: current.name, source: 'Donation', units_allocated: body.units_donated, allocated_at: null }); }
        state.request.status = requestRow().remaining_units ? 'Processing' : 'Fulfilled';
        return { status: 201, body: { ...requestRow(), actor_bank_id: current.bank_id, units_donated: body.units_donated } };
      }
      throw new Error('Unexpected V2 memory API: ' + request.method + ' ' + url.pathname);
    }, { enabled, ...config });
  }
  const text = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent || ""');
  const waitText = (selector, value) => browser.wait('(document.querySelector(' + JSON.stringify(selector) + ')?.textContent || "").includes(' + JSON.stringify(value) + ')');
  async function provider(id) {
    await browser.seed(authFixture('organization', id), '/organization/dashboard');
    await waitText('.bank-requests', 'Request #12');
    await browser.wait('Boolean(document.querySelector(".provider-queue"))');
  }
  try {
    await suite.test('disabled capability shows activation notice and original provider form', async () => {
      install(false); await browser.seed(authFixture('recipient', 16), '/recipient/requests/create');
      await waitText('.workflow-notice', 'not activated');
      assert.equal(await browser.evaluate('Boolean(document.querySelector("#request-pin"))'), false);
      assert.match(await text('label[for="request-organization"]'), /Hospital \/ Blood Bank/);
    });
    await suite.test('enabled form creates a Hospital admission request without unrelated fields', async () => {
      install(); await browser.seed(authFixture('recipient', 16), '/recipient/requests/create');
      await browser.wait('!document.querySelector(".workflow-notice")');
      assert.ok((await text('.create-request-page')).includes(hospitalHelp));
      assert.ok(!(await text('.create-request-guide')).includes('authorized hospital or blood bank'));
      await browser.input('#request-state', 'Maharashtra');
      await browser.wait('document.querySelector("#request-city").options.length === 2'); await browser.input('#request-city', 'Pune');
      await browser.wait('document.querySelector("#request-organization").options.length === 2');
      await browser.input('#request-organization', '11'); await browser.input('#request-blood-group', 'A+');
      await browser.input('#request-units', '5'); await browser.input('#request-urgency', 'Emergency');
      await browser.click('.create-request-form button[type="submit"]');
      await waitText('.create-request-success', 'shared with eligible Blood Banks'); assert.equal(state.request.admission_hospital_id, 11);
    });
    await suite.test('admission Hospital sees status and queue but no V2 stock, matching, screening or collection actions', async () => {
      const before = calls.length; await provider(11);
      assert.match(await text('.bank-request-card'), /Admission Hospital/);
      assert.match(await text('.bank-request-card'), /Admission\/status view only/);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-inventory,.bank-process,.bank-request-actions,.bank-donation-form"))'), false);
      assert.ok(!calls.slice(before).some(call => call.path.startsWith('/api/inventory/')));
      hospital.bank_id = null; await provider(11); await browser.wait('!document.querySelector(".provider-queue-start") || document.querySelector(".provider-queue-start").disabled');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-inventory"))'), false); hospital.bank_id = 18;
    });
    await suite.test('Bank review queue does not allocate; explicit matching leaves stock and quantities unchanged', async () => {
      await provider(9); await browser.click('.provider-queue-start'); await waitText('.provider-queue-active', '#12');
      assert.equal(state.inventory[6], 3); assert.equal(requestRow().fulfilled_units, 0);
      await browser.click('.bank-request-actions .bank-secondary'); await waitText('.bank-notice', 'eligible donors');
      assert.equal(state.inventory[6], 3); assert.equal(requestRow().fulfilled_units, 0);
    });
    await suite.test('own Bank stock creates a partial contribution and preserves global remaining demand', async () => {
      await browser.click('.bank-process'); await waitText('.bank-notice', '3/5 fulfilled');
      await waitText('.bank-request-card', 'First Blood Bank'); assert.equal(state.inventory[6], 0); assert.equal(requestRow().remaining_units, 2);
    });
    await suite.test('donor must explicitly choose a collecting Bank; all same-city banks are available', async () => {
      await browser.seed(authFixture('donor', 4), '/donor/dashboard'); await waitText('.donor-matches', 'Request #12');
      await browser.wait('Boolean(document.querySelector("#collecting-bank-12"))');
      assert.equal(await browser.evaluate('document.querySelector("#collecting-bank-12").options.length'), 3);
      assert.ok((await text('#collecting-bank-12')).includes('Second Blood Bank'));
      const before = calls.filter(call => call.path.endsWith('/response')).length;
      await browser.click('.donor-accept'); await waitText('.donor-action-error', 'Select an eligible');
      assert.equal(calls.filter(call => call.path.endsWith('/response')).length, before);
      await browser.input('#collecting-bank-12', '7'); await browser.click('.donor-accept');
      await waitText('.donor-matches', 'Designated collecting Blood Bank:'); await waitText('.donor-matches', 'Second Blood Bank');
      assert.equal(state.acceptedBank, 7); assert.equal(requestRow().fulfilled_units, 3);
      assert.ok((await text('.donor-accepted')).includes('designated collecting Blood Bank'));
      assert.ok(!(await text('.donor-accepted')).includes('Hospital / Blood Bank Medical Screening'));
      assert.ok((await text('.donor-action-success')).includes('designated collecting Blood Bank'));
      assert.ok(!(await text('.donor-action-success')).includes('hospital or blood bank'));
    });
    await suite.test('non-designated Bank has no donor contacts or screening controls', async () => {
      await provider(9); assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-donor-card"))'), false);
      assert.ok(!(await text('.bank-dashboard')).includes('9876543999'));
    });
    for (const status of ['Cancelled', 'Fulfilled']) await suite.test(status + ' request explains closed screening without falsely blaming Bank location', async () => {
      state.request.status=status; if(status==='Fulfilled')state.request.units_required=3;
      await provider(10); await waitText('.bank-donor-card','Not recorded (request closed)');
      assert.ok(!(await text('.bank-request-card')).includes('Current location is not eligible'));
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-donor-card .bank-request-actions,.bank-donation-form,.bank-process"))'),false);
      assert.match(await text('.workflow-v2-context'),/unavailable/);
      state.request.status='Processing';state.request.units_required=5;
    });
    await suite.test('relocated designated Bank can screen and record own-inventory collection without granting request supply', async () => {
      banks[1].city='Mumbai';
      await provider(10); await waitText('.bank-donor-card', '9876543999');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-process"))'),false);
      assert.match(await text('.bank-request-card'),/donors already assigned/);
      await browser.click('.bank-donor-card .bank-request-actions .bank-secondary'); await waitText('.bank-notice', 'screening passed');
      await browser.wait('Boolean(document.querySelector("#accounting-path-12-4"))');
      assert.equal(await browser.evaluate('document.querySelector("#accounting-path-12-4").value'), 'DirectRequest');
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      await browser.input('#accounting-path-12-4', 'Inventory'); await browser.input('.bank-donation-form input', '1');
      await browser.click('.bank-donation-form button'); await waitText('.bank-notice', 'did not fulfill request units');
      assert.equal(requestRow().remaining_units, 2); assert.equal(state.inventory[7], 2); assert.equal(state.donationUnits, 0);
      await waitText('.workflow-collected', 'Actual collection recorded');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-donation-form"))'), false);
      banks[1].city='Pune';
    });
    await suite.test('explicit later allocation combines two Banks contributions without inventing donated units', async () => {
      await provider(10); await browser.wait('document.querySelector(".bank-process")?.disabled === false'); await browser.click('.bank-process'); await waitText('.bank-notice', '5/5 fulfilled');
      assert.equal(requestRow().remaining_units, 0); assert.equal(state.inventory[7], 0); assert.equal(state.donationUnits, 0);
      await waitText('.bank-request-card', 'Second Blood Bank');
    });
    await suite.test('recipient sees admission Hospital and both Bank contribution totals', async () => {
      await browser.seed(authFixture('recipient', 16), '/recipient/requests/12'); await waitText('.request-fulfillment', '5 / 5 units fulfilled');
      const details = await text('.request-details-content'); assert.ok(details.includes(hospital.name)); assert.ok(details.includes('First Blood Bank')); assert.ok(details.includes('Second Blood Bank'));
      assert.ok(!details.includes('9876543999'));
    });
    await suite.test('moved Bank retains contributed history but has no current clinical controls', async () => {
      banks[1].city = 'Mumbai'; state.request.units_required = 6; state.request.status = 'Processing';
      await provider(10); await waitText('.workflow-contributions', 'Second Blood Bank');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-process,.bank-request-actions,.bank-donation-form"))'), false);
      banks[1].city = 'Pune'; state.request.units_required = 5; state.request.status = 'Fulfilled';
    });
    await suite.test('moved designated Bank retains collection-only response history and donor sees collection status', async () => {
      const saved = state.contributions; state.contributions = [{bank_id:6,bank_name:'First Blood Bank',source:'Inventory',units_allocated:5,allocated_at:null}]; banks[1].city = 'Mumbai';
      await provider(10); await waitText('.workflow-collected', 'Actual collection recorded');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-process,.bank-donation-form"))'), false);
      state.contributions = saved; banks[1].city = 'Pune';
      await browser.seed(authFixture('donor',4), '/donor/dashboard'); await waitText('.workflow-collected', 'Recorded collection:');
      assert.match(await text('.workflow-collected'), /not a direct request credit/);
    });
    await suite.test('recipient workflow notifications mark read via own-account route', async () => {
      await browser.seed(authFixture('recipient', 16), '/recipient/dashboard'); await waitText('.workflow-notifications', 'Your request has a workflow update');
      await browser.click('.workflow-notifications li button'); await browser.wait('!document.querySelector(".workflow-notifications li button")');
      assert.equal(state.notificationRead, true);
    });
    
    await suite.test('capability failure disables V2 and responsive form has no horizontal overflow', async () => {
      install(false, { status: 500 }); await browser.seed(authFixture('recipient', 16), '/recipient/requests/create');
      await waitText('.workflow-notice', 'Configuration could not be verified');
      assert.equal(await browser.evaluate('Boolean(document.querySelector("#request-pin"))'), false);
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    });
    await pause(100); assert.deepEqual(browser.browserErrors, []); assert.deepEqual(browser.failures, []);
  } finally { await browser.close(); }
});
