import { providerQueueFixture } from './helpers/providerQueueFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authFixture, pause, startBrowser, storageKey } from './helpers/recipientBrowser.js';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('blood bank dashboard in Chrome with memory-only API fixtures', {
  timeout: 180000, skip: !fs.existsSync(chromePath) && 'Set CHROME_PATH to run browser checks.',
}, async suite => {
  const browser = await startBrowser(chromePath);
  const profile = { bank_name: 'Central Blood Bank', address: 'Pune Main Road', phone: '02012345678', email: 'central@example.test' };
  const stock = { inventory_id: 4, bank_id: 3, blood_group: 'A+', units_available: 5, updated_at: '2026-10-07T06:30:00.000Z' };
  const requestRow = { request_id: 27, bank_id: 3, blood_group: 'A+', units_required: 3,
    urgency_level: 'Emergency', status: 'Pending', request_date: '2026-10-07T06:30:00.000Z',
    donor_matching_started_at: null, bank_name: profile.bank_name, bank_address: profile.address,
    bank_phone: profile.phone, bank_email: profile.email };
  let state;
  function reset(overrides = {}) {
    state = { owner: 3, profile: { ...profile }, inventory: [{ ...stock }], requests: [{ ...requestRow }],
      profileStatus: 200, inventoryStatus: 200, requestsStatus: 200, loginStatus: 200, updateStatus: 200, processStatus: 200,
      loadDelay: 0, updateDelay: 0, processDelay: 0, loginDelay: 0, ...overrides };
  }
  function identity(request) {
    const header = request.headers.Authorization || request.headers.authorization;
    assert.ok(header?.startsWith('Bearer '));
    return JSON.parse(Buffer.from(header.slice(7).split('.')[1], 'base64url').toString());
  }
  browser.mock(async (request, url) => {
    const snapshot = { ...state, inventory: state.inventory.map(row => ({ ...row })), requests: state.requests.map(row => ({ ...row })) };
    if (request.method === 'POST' && url.pathname.startsWith('/api/auth/')) {
      const role = url.pathname.includes('organization') ? 'organization' : url.pathname.includes('recipient') ? 'recipient' : 'donor';
      assert.equal(url.pathname, '/api/auth/' + role + '/login');
      const payload = JSON.parse(request.postData);
      assert.deepEqual(Object.keys(payload).sort(), ['identifier', 'password']);
      if (role === 'organization') assert.equal(payload.identifier, 'central@example.test');
      if (snapshot.loginDelay) await pause(snapshot.loginDelay);
      if (snapshot.loginStatus === 'network') return { networkError: true };
      const session = authFixture(role === 'organization' ? (snapshot.loginResponseRole || role) : role, role === 'organization' ? 3 : 16);
      return { status: snapshot.loginStatus, body: snapshot.loginStatus === 200
        ? role === 'organization' ? { token: session.token, user: { user_id: 3, user_type: snapshot.loginResponseRole || role,
            organization_id: 3, organization_type: 'Blood Bank', name: profile.bank_name,
            state: 'Maharashtra', city: 'Pune', bank_id: 3, ...profile, password_hash: 'Private' } }
          : { token: session.token, [role]: { [role + '_id']: 16, name: 'Existing account' } }
        : { message: 'Private login SQL must never show' } };
    }
    const owner = identity(request);
    if (url.pathname === '/api/auth/me') {
      if (snapshot.loadDelay) await pause(snapshot.loadDelay);
      if (owner.user_type === 'organization') return { status: snapshot.profileStatus, body: snapshot.profileStatus === 200
        ? { user_id: owner.user_id, user_type: 'organization', organization_id: owner.user_id,
            organization_type: 'Blood Bank', name: snapshot.profile.bank_name,
            state: 'Maharashtra', city: 'Pune', bank_id: 3, ...snapshot.profile, password_hash: 'Private' }
        : { message: 'Private profile SQL' } };
      if (owner.user_type !== 'blood_bank') return { body: { user_id: owner.user_id, user_type: owner.user_type, name: 'Existing account', blood_group: 'A+', location: 'Pune', is_available: 1 } };
      return { status: snapshot.profileStatus, body: snapshot.profileStatus === 200
        ? { user_id: snapshot.owner, user_type: 'blood_bank', ...snapshot.profile, password_hash: 'Private' } : { message: 'Private profile SQL' } };
    }
    if (url.pathname === '/api/donors/me/matching-requests') return { body: { requests: [] } };
    if (url.pathname === '/api/notifications/donor/16') return { body: { user_id: 16, user_type: 'donor', notifications: [] } };
    if (url.pathname === '/api/requests/provider-queue') {
      return { body: providerQueueFixture(snapshot.requests, { bankId: snapshot.owner,
        organizationId: owner.user_type === 'organization' ? owner.user_id : null }) };
    }
    if (url.pathname === '/api/requests') {
      assert.equal(url.search, '');
      if (snapshot.loadDelay) await pause(snapshot.loadDelay);
      return { status: snapshot.requestsStatus, body: snapshot.requestsStatus === 200
        ? { requests: ['blood_bank', 'organization'].includes(owner.user_type) ? snapshot.requests : [] } : { message: 'Private request SQL' } };
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/inventory/')) {
      assert.ok(['blood_bank', 'organization'].includes(owner.user_type));
      assert.equal(url.pathname, '/api/inventory/' + (owner.user_type === 'organization' ? 3 : owner.user_id));
      if (snapshot.loadDelay) await pause(snapshot.loadDelay);
      return { status: snapshot.inventoryStatus, body: snapshot.inventoryStatus === 200
        ? { bank_id: snapshot.owner, inventory: snapshot.inventory } : { message: 'Private inventory SQL' } };
    }
    if (request.method === 'PUT') {
      assert.equal(owner.user_type, 'blood_bank');
      const parts = url.pathname.split('/');
      assert.equal(Number(parts[3]), owner.user_id);
      const group = decodeURIComponent(parts[4]);
      const body = JSON.parse(request.postData);
      assert.deepEqual(Object.keys(body), ['units_available', 'expected_version']); assert.equal(body.expected_version, 0);
      assert.ok(Number.isInteger(body.units_available) && body.units_available >= 0);
      if (snapshot.updateDelay) await pause(snapshot.updateDelay);
      if (snapshot.updateStatus === 'network') return { networkError: true };
      if (snapshot.updateStatus !== 200) return { status: snapshot.updateStatus, body: { message: 'Private update SQL' } };
      if (state.owner === owner.user_id) {
        state.inventory = state.inventory.filter(row => row.blood_group !== group);
        state.inventory.push({ inventory_id: 8, bank_id: owner.user_id, blood_group: group, units_available: body.units_available, updated_at: '2026-10-07T06:31:00.000Z' });
      }
      return { body: { message: 'Updated', bank_id: owner.user_id, blood_group: group, units_available: body.units_available } };
    }
    if (request.method === 'POST' && url.pathname.startsWith('/api/allocations/process/')) {
      assert.equal(owner.user_type, 'blood_bank');
      assert.match(JSON.parse(request.postData).operation_key, /^[a-f0-9-]{36}$/i);
      const id = Number(url.pathname.split('/').at(-1));
      const row = snapshot.requests.find(row => row.request_id === id);
      assert.equal(row.bank_id, owner.user_id);
      if (snapshot.processDelay) await pause(snapshot.processDelay);
      if (snapshot.processStatus === 'network') return { networkError: true };
      if (snapshot.processStatus !== 200) return { status: snapshot.processStatus, body: { message: 'Private process SQL' } };
      const available = snapshot.inventory.find(item => item.blood_group === row.blood_group);
      const previous = row.fulfilled_units ?? 0;
      const allocated = Math.min(available?.units_available ?? 0, row.units_required - previous);
      const fulfilled = previous + allocated;
      const remaining = row.units_required - fulfilled;
      const status = remaining === 0 ? 'Fulfilled' : fulfilled > 0 ? 'Processing' : 'Pending';
      if (state.owner === owner.user_id) {
        if (available) state.inventory.find(item => item.blood_group === row.blood_group).units_available -= allocated;
        Object.assign(state.requests.find(item => item.request_id === id), { status, fulfilled_units: fulfilled,
          remaining_units: remaining, inventory_units: fulfilled, donation_units: 0, history_available: true });
      }
      return { body: { request_id: id, bank_id: owner.user_id, source: 'blood_bank', status, allocated_units: allocated,
        fulfilled_units: fulfilled, remaining_units: remaining, inventory_units: fulfilled, donation_units: 0 } };
    }
    throw new Error('Unexpected fixture request: ' + request.method + ' ' + url.pathname);
  });
  const text = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent || ""');
  const waitText = (selector, value) => browser.wait('(document.querySelector(' + JSON.stringify(selector) + ')?.textContent || "").includes(' + JSON.stringify(value) + ')');
  const saved = () => browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')');
  async function dashboard(overrides = {}, session = authFixture('blood_bank', 3)) {
    reset(overrides); await browser.seed(session, '/blood-bank/dashboard');
    await browser.wait('Boolean(document.querySelector(".bank-dashboard"))');
  }
  async function settled() {
    await waitText('.bank-profile', state.profile.bank_name);
    await browser.wait('document.querySelectorAll(".bank-stock-card").length === 8');
    await waitText('.bank-requests', state.requests.length ? 'Request #' + state.requests[0].request_id : 'No blood requests');
  }
  const mutations = method => browser.apiCalls.filter(call => call.method === method).length;
  async function waitMutation(method, before) {
    for (let i = 0; i < 200 && mutations(method) === before; i += 1) await pause(10);
    assert.ok(mutations(method) > before);
  }
  async function login(role) {
    await browser.input('#login-type', role);
    await browser.input(role === 'organization' ? '#login-identifier' : '#login-phone', role === 'organization' ? ' central@example.test ' : '9876543210');
    await browser.input('#login-password', 'Memory-password');
    await browser.click('.login-submit');
  }
  try {
    await suite.test('unauthenticated, donor and recipient roles cannot access bank dashboard', async () => {
      reset();
      for (const session of [null, authFixture('donor'), authFixture('recipient'), authFixture('blood_bank', 3, 1)]) {
        const before = browser.apiCalls.length;
        await browser.seed(session, '/blood-bank/dashboard');
        await browser.wait('location.pathname === "/login"');
        assert.equal(browser.apiCalls.length, before);
      }
      for (const route of ['/donor/dashboard', '/recipient/dashboard', '/recipient/requests/create', '/recipient/requests/27']) {
        const before = browser.apiCalls.length;
        await browser.seed(authFixture('blood_bank', 3), route);
        await browser.wait('location.pathname === "/login"');
        assert.equal(browser.apiCalls.length, before);
      }
    });
    await suite.test('all three login endpoints redirect correctly and keep only minimal identity', async () => {
      for (const role of ['donor', 'recipient', 'organization']) {
        reset(); await browser.seed(null, '/login');
        await browser.wait('Boolean(document.querySelector("#login-type"))');
        await login(role);
        const route = '/' + role + '/dashboard';
        await browser.wait('location.pathname === ' + JSON.stringify(route));
        const auth = JSON.parse(await saved());
        assert.equal(auth.user.user_type, role);
        assert.deepEqual(Object.keys(auth.user).sort(), ['user_id', 'user_type']);
        assert.ok(!JSON.stringify(auth).includes('password'));
        await browser.wait('Boolean(document.querySelector(' + JSON.stringify('.site-navigation a[href="' + route + '"]') + '))');
      }
    });
    await suite.test('Organization Blood Bank login validates missing and malformed identifier without calling backend', async () => {
      reset(); await browser.seed(null, '/login');
      await browser.wait('Boolean(document.querySelector("#login-type"))');
      await browser.input('#login-type', 'organization');
      const before = browser.apiCalls.length;
      await browser.click('.login-submit'); await waitText('.login-error', 'phone number or email');
      await browser.input('#login-identifier', 'invalid');
      await browser.input('#login-password', 'Memory-password');
      await browser.click('.login-submit'); await waitText('.login-error', 'valid email');
      assert.equal(browser.apiCalls.length, before);
    });
    for (const status of [400, 401, 500, 'network']) await suite.test('Organization Blood Bank login safe error ' + status, async () => {
      reset({ loginStatus: status }); await browser.seed(null, '/login');
      await browser.wait('Boolean(document.querySelector("#login-type"))'); await login('organization');
      await browser.wait('Boolean(document.querySelector(".login-error"))');
      assert.ok(!(await text('.login-error')).includes('Private'));
      assert.equal(await browser.evaluate('location.pathname'), '/login');
      assert.equal(await saved(), null);
    });
    await suite.test('Organization login rejects self-consistent unexpected role and preserves current bank session', async () => {
      reset({ loginResponseRole: 'donor' });
      const existing = authFixture('blood_bank', 7);
      await browser.seed(existing, '/login');
      await browser.wait('Boolean(document.querySelector("#login-type"))'); await login('organization');
      await waitText('.login-error', 'unexpected login response');
      assert.deepEqual(JSON.parse(await saved()), existing);
      assert.equal(await browser.evaluate('location.pathname'), '/login');
    });
    await suite.test('Organization Blood Bank login prevents duplicate submissions and clears password', async () => {
      reset({ loginDelay: 500 }); await browser.seed(null, '/login');
      await browser.wait('Boolean(document.querySelector("#login-type"))');
      const before = mutations('POST'); await login('organization');
      await waitText('.login-submit', 'Logging in...');
      assert.equal(await browser.evaluate('document.querySelector("#login-identifier").disabled'), true);
      await browser.click('.login-submit');
      await browser.wait('location.pathname === "/organization/dashboard"');
      assert.equal(mutations('POST') - before, 1);
    });
    await suite.test('eight blood groups show actual stock or zero without creating rows', async () => {
      const beforePut = mutations('PUT'), beforePost = mutations('POST');
      await dashboard(); await settled();
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".bank-stock-heading h3")).map(n=>n.textContent)'), ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-']);
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".bank-stock-units strong")).map(n=>n.textContent)'), ['5', '0', '0', '0', '0', '0', '0', '0']);
      assert.equal(mutations('PUT'), beforePut); assert.equal(mutations('POST'), beforePost);
      assert.ok((await text('.bank-profile')).includes(profile.email));
      assert.ok(!(await text('.bank-dashboard')).includes('Private'));
      assert.equal(await text('.bank-stats > div:first-child strong'), '5');
    });
    await suite.test('explicit stock save waits for response and prevents duplicate PUT', async () => {
      await dashboard({ updateDelay: 500 }); await settled();
      const before = mutations('PUT');
      await browser.click('.bank-edit-stock'); await browser.input('.bank-units-input', '15');
      await browser.click('.bank-stock-actions .bank-primary');
      await browser.wait('document.querySelector(".bank-stock-actions .bank-primary")?.disabled === true');
      assert.equal(await text('.bank-stock-units strong'), '5');
      await browser.click('.bank-stock-actions .bank-primary');
      await waitText('.bank-notice', 'updated to 15');
      await browser.wait('document.querySelector(".bank-stock-units strong")?.textContent === "15"');
      assert.equal(mutations('PUT') - before, 1);
    });
    await suite.test('negative stock is rejected and failed save retains real count', async () => {
      await dashboard({ updateStatus: 500 }); await settled();
      await browser.click('.bank-edit-stock'); await browser.input('.bank-units-input', '-1');
      const before = mutations('PUT'); await browser.click('.bank-stock-actions .bank-primary');
      await waitText('.bank-action-error', 'whole number'); assert.equal(mutations('PUT'), before);
      await browser.input('.bank-units-input', '15'); await browser.click('.bank-stock-actions .bank-primary');
      await waitText('.bank-action-error', 'server could not');
      assert.equal(await text('.bank-stock-units strong'), '5');
      assert.ok(!(await text('.bank-dashboard')).includes('Private'));
    });
    for (const available of [5, 3, 2, 0]) await suite.test('processing request3 with stock' + available, async () => {
      await dashboard({ inventory: available ? [{ ...stock, units_available: available }] : [], processDelay: 350 });
      await settled(); const before = mutations('POST'), beforeLoads = mutations('GET');
      await browser.click('.bank-process');
      await browser.wait('document.querySelector(".bank-process")?.disabled === true');
      await browser.click('.bank-process');
      await waitText('.bank-notice', 'inventory units allocated');
      // Zero stock can look unchanged before the post-action refresh starts.
      for (let i = 0; i < 200 && mutations('GET') - beforeLoads < 3; i += 1) await pause(10);
      assert.ok(mutations('GET') - beforeLoads >= 3);
      await browser.wait('document.querySelectorAll(".bank-stock-card").length === 8 && document.querySelector(".bank-stock-units strong")?.textContent === ' + JSON.stringify(String(Math.max(0, available - 3))) + ' && document.querySelector(".bank-requests")?.textContent.includes(' + JSON.stringify(available >= 3 ? 'Fulfilled' : available > 0 ? 'Processing' : 'Pending') + ')');
      assert.equal(mutations('POST') - before, 1);
      assert.equal(await text('.bank-stock-units strong'), String(Math.max(0, available - 3)));
      assert.ok((await text('.bank-requests')).includes(available >= 3 ? 'Fulfilled' : available > 0 ? 'Processing' : 'Pending'));
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-matching"))'), false);
    });
    await suite.test('requests retain bank priority and status filters use real request history', async () => {
      await dashboard({ requests: [{ ...requestRow, request_id: 29, urgency_level: 'Normal', status: 'Fulfilled' },
        requestRow, { ...requestRow, request_id: 26, request_date: '2026-10-06T06:30:00.000Z' }] }); await settled();
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".bank-request-card h3")).map(n=>n.textContent)'), ['Request #26', 'Request #27', 'Request #29']);
      await browser.input('#bank-request-filter', 'Fulfilled');
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".bank-request-card h3")).map(n=>n.textContent)'), ['Request #29']);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-process"))'), false);
      await browser.input('#bank-request-filter', 'Cancelled'); await waitText('.bank-empty', 'No requests match');
      assert.equal(await text('.bank-stats > div:nth-child(2) strong'), '2');
      assert.equal(await text('.bank-stats > div:nth-child(4) strong'), '1');
    });
    for (const section of ['profile', 'inventory', 'requests']) await suite.test(section + ' failures are safe and retryable', async () => {
      await dashboard({ [section + 'Status']: 500 });
      await browser.wait('Boolean(document.querySelector(' + JSON.stringify('.bank-' + section + ' .bank-error button') + '))');
      assert.ok(!(await text('.bank-dashboard')).includes('Private'));
      state[section + 'Status'] = 200;
      await browser.click('.bank-' + section + ' .bank-error button'); await settled();
    });
    for (const action of ['load', 'update', 'process']) await suite.test(action + ' 401 clears auth and redirects', async () => {
      if (action === 'load') {
        reset({ inventoryStatus: 401 });
        await browser.seed(authFixture('blood_bank', 3), '/blood-bank/dashboard');
      }
      else {
        await dashboard({ [action + 'Status']: 401 }); await settled();
        if (action === 'process') await browser.click('.bank-process');
        else { await browser.click('.bank-edit-stock'); await browser.input('.bank-units-input', '15'); await browser.click('.bank-stock-actions .bank-primary'); }
      }
      await browser.wait('location.pathname === "/login"'); assert.equal(await saved(), null);
    });
    await suite.test('section links scroll and logout remains usable', async () => {
      await dashboard(); await settled();
      await browser.click('.bank-toolbar a[href="#bank-requests"]');
      await browser.wait('location.hash === "#bank-requests" && scrollY > 0');
      await browser.click('.bank-logout'); await browser.wait('location.pathname === "/login"');
      assert.equal(await saved(), null);
    });
    for (const status of [200, 401]) await suite.test('late login ' + status + ' cannot overwrite newer bank identity', async () => {
      reset({ loginStatus: status, loginDelay: 850 }); await browser.seed(null, '/login');
      await browser.wait('Boolean(document.querySelector("#login-type"))');
      const before = mutations('POST'); await login('organization'); await waitMutation('POST', before);
      const next = JSON.stringify(authFixture('blood_bank', 7));
      await browser.evaluate('localStorage.setItem(' + JSON.stringify(storageKey) + ',' + JSON.stringify(next) + ');window.dispatchEvent(new StorageEvent("storage",{key:' + JSON.stringify(storageKey) + '}));');
      await browser.wait('document.querySelector(".login-submit")?.disabled === false');
      await pause(1100);
      assert.equal(JSON.parse(await saved()).user.user_id, 7);
      assert.equal(await browser.evaluate('location.pathname'), '/login');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".login-error"))'), false);
    });
    async function switchBank() {
      reset({ owner: 7, profile: { ...profile, bank_name: 'Northern Blood Bank' },
        inventory: [{ ...stock, bank_id: 7, blood_group: 'B+', units_available: 2 }],
        requests: [{ ...requestRow, request_id: 37, bank_id: 7, blood_group: 'B+', units_required: 1 }] });
      const next = JSON.stringify(authFixture('blood_bank', 7));
      await browser.evaluate('localStorage.setItem(' + JSON.stringify(storageKey) + ',' + JSON.stringify(next) + ');window.dispatchEvent(new StorageEvent("storage",{key:' + JSON.stringify(storageKey) + '}));');
    }
    async function assertSecondBank() {
      await waitText('.bank-welcome h1', 'Northern Blood Bank');
      await waitText('.bank-requests', 'Request #37');
      await browser.wait('document.querySelectorAll(".bank-stock-card").length === 8');
      assert.equal(await text('.bank-stats > div:first-child strong'), '2');
      assert.equal(await browser.evaluate('location.pathname'), '/blood-bank/dashboard');
      assert.equal(JSON.parse(await saved()).user.user_id, 7);
      assert.ok(!(await text('.bank-requests')).includes('Request #27'));
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-notice"))'), false);
    }
    for (const action of ['load', 'update', 'process']) for (const status of [200, 401]) {
      await suite.test('late bankA ' + action + ' ' + status + ' cannot affect bankB', async () => {
        if (action === 'load') {
          const before = mutations('GET');
          await dashboard({ loadDelay: 850, profileStatus: status, inventoryStatus: status, requestsStatus: status });
          for (let i = 0; i < 200 && mutations('GET') - before < 3; i += 1) await pause(10);
          assert.ok(mutations('GET') - before >= 3);
        } else {
          await dashboard({ [action + 'Status']: status, [action + 'Delay']: 850 }); await settled();
          const method = action === 'update' ? 'PUT' : 'POST';
          const before = mutations(method);
          if (action === 'process') await browser.click('.bank-process');
          else { await browser.click('.bank-edit-stock'); await browser.input('.bank-units-input', '15'); await browser.click('.bank-stock-actions .bank-primary'); }
          await waitMutation(method, before);
        }
        await switchBank(); await assertSecondBank();
        await pause(1100); await assertSecondBank();
      });
    }
    for (const status of [409, 500, 'network']) await suite.test('failed processing ' + status + ' retains pending request and stock', async () => {
      await dashboard({ processStatus: status }); await settled(); await browser.click('.bank-process');
      await browser.wait('Boolean(document.querySelector(".bank-action-error"))');
      assert.equal(await text('.bank-stock-units strong'), '5');
      assert.ok((await text('.bank-request-card')).includes('Pending'));
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-matching"))'), false);
      assert.equal(await browser.evaluate('document.querySelector(".bank-process").disabled'), false);
      assert.ok(!(await text('.bank-dashboard')).includes('Private'));
    });
    for (const width of [320, 390, 1440]) await suite.test('responsive layout ' + width, async () => {
      await dashboard({ profile: { ...profile, bank_name: 'Bank' + 'x'.repeat(65), email: 'contact' + 'x'.repeat(80) + '@example.test', address: 'Street' + 'x'.repeat(100) }, requests: [{ ...requestRow, units_required: 2147483647 }] }); await settled();
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
      await pause(100);
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      const screenshot = await browser.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      fs.writeFileSync(new URL('../node_modules/.cache/blood-bank-dashboard-' + width + '.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
    });
    await suite.test('no browser exceptions or fixture failures', async () => {
      await pause(100); assert.deepEqual(browser.browserErrors, []); assert.deepEqual(browser.failures, []);
    });
  } finally { await browser.close(); }
});
