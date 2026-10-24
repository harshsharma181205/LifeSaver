import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { authFixture, pause, startBrowser, storageKey } from './helpers/recipientBrowser.js';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('recipient experience in a real browser with memory-only API fixtures', {
  timeout: 180000, skip: !fs.existsSync(chromePath) && 'Set CHROME_PATH to run browser checks.',
}, async (suite) => {
  const browser = await startBrowser(chromePath);
  const row = {
    request_id: 27, recipient_id: 16, blood_group: 'O+', units_required: 1,
    urgency_level: 'Normal', status: 'Pending', request_date: '2026-10-06T06:30:00.000Z', bank_id: 3, donor_matching_started_at: null, bank_name: 'Central Blood Bank', bank_address: 'Pune Main Road', bank_phone: '02012345678', bank_email: 'central@example.test',
  };
  let state;
  function reset(overrides = {}) {
    state = { rows: [], historyStatus: 200, profileStatus: 200, name: 'Gaurav',
      delay: 0, profileDelay: 0, loginDelay: 0, banksStatus: 200, banksDelay: 0, banks: [{ bank_id: 3, bank_name: 'Central Blood Bank', address: 'Pune Main Road', phone: '02012345678', email: 'central@example.test' }, { bank_id: 7, bank_name: 'Northside Blood Bank', address: 'Pune North Road', phone: '02076543210', email: 'northside@example.test' }], ...overrides };
  }
  function requestIdentity(request) {
    const value = request.headers.Authorization || request.headers.authorization;
    if (!value) throw new Error('Authenticated API request missing Bearer header');
    const payload = value.replace(/^Bearer /, '').split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  }
  browser.mock(async (request, url) => {
    const snapshot = { ...state, rows: [...state.rows] };
    if (request.method === 'GET' && url.pathname === '/api/organizations/cities') {
      assert.equal(url.searchParams.get('state'), 'Maharashtra');
      return { body: { cities: snapshot.banks.length ? ['Pune'] : [] } };
    }
    if (request.method === 'GET' && url.pathname === '/api/organizations') {
      assert.equal(url.searchParams.get('state'), 'Maharashtra'); assert.equal(url.searchParams.get('city'), 'Pune');
      if (snapshot.banksDelay) await pause(snapshot.banksDelay);
      return { status: snapshot.banksStatus, body: snapshot.banksStatus === 200
        ? { organizations: snapshot.banks.map(bank => ({ ...bank, organization_id: bank.bank_id,
          organization_type: 'Blood Bank', name: bank.bank_name, state: 'Maharashtra', city: 'Pune' })) }
        : { message: 'Private catalog SQL details' } };
    }
    if (request.method === 'GET' && url.pathname === '/api/requests') {
      const identity = requestIdentity(request);
      assert.equal(url.search, '', 'Frontend must not send ownership query input');
      if (snapshot.delay) await pause(snapshot.delay);
      if (snapshot.historyNetwork) return { networkError: true };
      return { status: snapshot.historyStatus, body: snapshot.historyStatus === 200
        ? { requests: snapshot.rows.filter(item => item.recipient_id === identity.user_id).map(({ recipient_id, ...safe }) => safe) }
        : { message: 'Private SQL details must never appear in UI' } };
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      const identity = requestIdentity(request);
      if (snapshot.profileDelay) await pause(snapshot.profileDelay);
      if (snapshot.profileNetwork) return { networkError: true };
      return { status: snapshot.profileStatus, body: snapshot.profileStatus === 200
        ? { user_id: snapshot.profileId ?? identity.user_id, user_type: identity.user_type, name: identity.user_type === 'donor' ? 'Donor account' : snapshot.name,
          ...(identity.user_type === 'donor' ? { blood_group: 'A+', location: 'Pune', is_available: 1 } : {}) }
        : { message: 'Private profile error' } };
    }
    if (request.method === 'GET' && url.pathname === '/api/donors/me/matching-requests') {
      assert.equal(requestIdentity(request).user_type, 'donor');
      return { body: { requests: [] } };
    }
    if (request.method === 'GET' && url.pathname === '/api/notifications/donor/16') {
      const identity = requestIdentity(request);
      assert.equal(identity.user_type, 'donor');
      return { body: { user_id: identity.user_id, user_type: 'donor', notifications: [] } };
    }
    if (request.method === 'POST' && /^\/api\/auth\/(donor|recipient)\/login$/.test(url.pathname)) {
      if (snapshot.loginDelay) await pause(snapshot.loginDelay);
      const role = url.pathname.includes('/recipient/') ? 'recipient' : 'donor';
      const account = { name: role === 'recipient' ? 'Gaurav' : 'Donor account', [role + '_id']: 16 };
      return { body: { message: 'Login successful.', token: authFixture(role).token, [role]: account } };
    }
    if (request.method === 'POST' && url.pathname === '/api/requests') {
      const identity = requestIdentity(request);
      const body = JSON.parse(request.postData);
      assert.deepEqual(Object.keys(body).sort(), ['recipient_id', 'organization_id', 'state', 'city', 'blood_group', 'units_required', 'urgency_level'].sort());
      assert.equal(body.recipient_id, identity.user_id);
      assert.equal(body.organization_id, 7, 'Selected second catalog bank must be posted');
      const bank = state.banks.find(item => item.bank_id === body.organization_id);
      assert.ok(bank, 'Submitted bank must exist in current catalog');
      assert.equal(body.state, 'Maharashtra'); assert.equal(body.city, 'Pune');
      state.rows.push({ ...row, ...body, bank_id: bank.bank_id, organization_name: bank.bank_name, bank_name: bank.bank_name, bank_address: bank.address,
        bank_phone: bank.phone, bank_email: bank.email });
      return { status: 201, body: { message: 'Blood request created successfully.', request_id: 27 } };
    }
    throw new Error('Unexpected API path or method');
  });
  const text = (selector) => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent');
  const waitText = (selector, value) => browser.wait('document.querySelector(' + JSON.stringify(selector) + ')?.textContent.includes(' + JSON.stringify(value) + ')');
  async function dashboard(overrides = {}, session = authFixture()) {
    reset(overrides);
    await browser.seed(session);
    await browser.wait('Boolean(document.querySelector(".recipient-dashboard"))');
  }
  async function fillLogin(role) {
    await browser.input('#login-type', role);
    await browser.input('#login-phone', '9876543210');
    await browser.input('#login-password', 'Browser-only-password');
    await browser.click('.login-submit');
  }
  const requestPosts = () => browser.apiCalls.filter(call => call.method === 'POST' && new URL(call.url).pathname === '/api/requests');
  async function openCreate(overrides = {}) {
    reset(overrides);
    await browser.seed(authFixture(), '/recipient/requests/create');
    await browser.wait('Boolean(document.querySelector("#request-organization"))');
    await browser.input('#request-state', 'Maharashtra');
    if (state.banks.length) {
      await browser.wait('Array.from(document.querySelector("#request-city").options).some(option=>option.value==="Pune")');
      await browser.input('#request-city', 'Pune');
    }
    await browser.input('#request-blood-group', 'O+');
    await browser.input('#request-units', '1');
    await browser.input('#request-urgency', 'Normal');
  }
  try {
    await suite.test('anonymous and wrong-role dashboard access redirects to login', async () => {
      reset();
      for (const session of [null, authFixture('donor'), authFixture('blood_bank')]) {
        await browser.seed(session);
        await browser.wait('location.pathname === "/login"');
      }
    });
    await suite.test('loading is distinct from successful empty history', async () => {
      await dashboard({ delay: 700 });
      await waitText('.recipient-history', 'Loading your blood requests');
      assert.ok(!(await text('.recipient-history')).includes("haven't created"));
      await waitText('.recipient-history', "You haven't created any blood requests yet.");
      assert.equal(await browser.evaluate('document.querySelector(".recipient-empty-action").getAttribute("href")'), '/recipient/requests/create');
      await waitText('#recipient-welcome-title', 'Gaurav!');
    });
    await suite.test('real history fields, date and profile name survive reload', async () => {
      await dashboard({ rows: [row, { ...row, request_id: 28, blood_group: 'AB-', status: 'Fulfilled', urgency_level: 'Emergency' }] });
      await waitText('.recipient-request-list', 'Request #27');
      await waitText('#recipient-welcome-title', 'Gaurav!');
      const content = await text('.recipient-request-list');
      for (const value of ['O+', 'Units required', 'Normal', 'Pending', '6 Oct 2026', 'Fulfilled', 'Emergency', 'Central Blood Bank']) assert.ok(content.includes(value));
      assert.ok(!(await text('#recipient-welcome-title')).includes('Recipient #'));
      await browser.navigate('/recipient/dashboard');
      await waitText('.recipient-request-list', 'Request #27');
      const saved = JSON.parse(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'));
      assert.deepEqual(Object.keys(saved).sort(), ['token', 'user']);
      assert.deepEqual(Object.keys(saved.user).sort(), ['user_id', 'user_type']);
    });
    for (const failure of [403, 404, 500, 'network']) {
      await suite.test('history ' + failure + ' error is safe and Retry fetches again', async () => {
        await dashboard(failure === 'network' ? { historyNetwork: true } : { historyStatus: failure });
        await browser.wait('Boolean(document.querySelector(".recipient-history-error"))');
        const content = await text('.recipient-history');
        assert.ok(!content.includes('Private SQL'));
        assert.ok(!content.includes("haven't created"));
        state.historyStatus = 200; state.historyNetwork = false; state.rows = [row];
        await browser.click('.recipient-retry-button');
        await waitText('.recipient-request-list', 'Request #27');
      });
    }
    for (const profile of [{ profileStatus: 404 }, { profileStatus: 500 }, { profileNetwork: true },
      { name: '' }, { name: null }, { profileId: 99 }]) {
      await suite.test('profile fallback keeps history working: ' + JSON.stringify(profile), async () => {
        await dashboard({ rows: [row], ...profile });
        await waitText('.recipient-request-list', 'Request #27');
        await pause(150);
        assert.equal((await text('#recipient-welcome-title')).trim(), 'Welcome back!');
      });
    }
    for (const endpoint of ['history', 'profile']) {
      await suite.test(endpoint + ' 401 clears auth and redirects to login', async () => {
        reset({ [endpoint + 'Status']: 401 });
        await browser.seed(authFixture());
        await browser.wait('location.pathname === "/login"');
        assert.equal(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'), null);
        await browser.navigate('/recipient/dashboard');
        await browser.wait('location.pathname === "/login"');
      });
    }
    await suite.test('expired stored JWT redirects to login', async () => {
      reset();
      await browser.seed(authFixture('recipient', 16, Math.floor(Date.now() / 1000) - 1));
      await browser.wait('location.pathname === "/login"');
      assert.equal(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'), null);
    });
    await suite.test('recipient login persists minimal session then redirects automatically', async () => {
      reset({ rows: [row] });
      await browser.seed(null, '/login');
      await browser.wait('Boolean(document.querySelector("#login-type"))');
      await fillLogin('recipient');
      await browser.wait('location.pathname === "/recipient/dashboard"');
      await waitText('.recipient-request-list', 'Request #27');
      await waitText('#recipient-welcome-title', 'Gaurav!');
      assert.equal(JSON.parse(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')')).user.user_type, 'recipient');
    });
    await suite.test('donor login redirects to its donor dashboard', async () => {
      reset();
      await browser.seed(null, '/login');
      await browser.wait('Boolean(document.querySelector("#login-type"))');
      await fillLogin('donor');
      await waitText('#donor-welcome-title', 'Donor account!');
      assert.equal(await browser.evaluate('location.pathname'), '/donor/dashboard');
      assert.equal(await browser.evaluate('Boolean(document.querySelector("#login-password"))'), false);
    });
    await suite.test('leaving Login cancels pending login and prevents late redirect', async () => {
      reset({ loginDelay: 600 });
      await browser.seed(null, '/login');
      await browser.wait('Boolean(document.querySelector("#login-type"))');
      await fillLogin('recipient');
      await waitText('.login-submit', 'Logging in...');
      await browser.click('.login-home-link');
      await browser.wait('location.pathname === "/"');
      await pause(800);
      assert.equal(await browser.evaluate('location.pathname'), '/');
      assert.equal(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'), null);
    });
    await suite.test('zero real bank catalog prevents request submission', async () => {
      await openCreate({ banks: [] });
      await waitText('.create-request-page', 'No registered organizations found');
      assert.equal(await browser.evaluate('document.querySelector("#request-organization").disabled'), true);
      assert.equal(await browser.evaluate('document.querySelector(".create-request-form button[type=submit]").disabled'), true);
      const before = requestPosts().length;
      await browser.click('.create-request-form button[type=submit]');
      await pause(100);
      assert.equal(requestPosts().length, before);
      assert.equal(await browser.evaluate('document.querySelector("#request-organization").options.length'), 1);
    });
    await suite.test('catalog supplies options and valid bank selection is required', async () => {
      await openCreate();
      await browser.wait('Array.from(document.querySelector("#request-organization").options).some(option => option.value === "3")');
      assert.equal(await browser.evaluate('document.querySelector("#request-organization").required'), true);
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelector("#request-organization").options).map(option=>option.value)'), ['', '3', '7']);
      assert.ok((await text('#request-organization')).includes('Central Blood Bank'));
      const before = requestPosts().length;
      const blocked = await browser.evaluate('document.querySelector(".create-request-form button[type=submit]").disabled');
      await browser.click('.create-request-form button[type=submit]');
      await pause(100);
      assert.ok(blocked || await browser.evaluate('!document.querySelector("#request-organization").checkValidity()'));
      assert.equal(requestPosts().length, before);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".create-request-success"))'), false);
    });
    await suite.test('catalog loading and failure prevent posts without exposing SQL errors', async () => {
      await openCreate({ banksDelay: 600 });
      assert.equal(await browser.evaluate('document.querySelector(".create-request-form button[type=submit]").disabled'), true);
      const before = requestPosts().length;
      await browser.click('.create-request-form button[type=submit]');
      assert.equal(requestPosts().length, before);
      await browser.wait('Array.from(document.querySelector("#request-organization").options).some(option => option.value === "3")');
      await openCreate({ banksStatus: 500 });
      await browser.wait('document.querySelector(".create-request-page").textContent.includes("Unable") || document.querySelector(".create-request-page").textContent.includes("could not")');
      assert.ok(!(await text('.create-request-page')).includes('Private catalog SQL'));
      assert.equal(await browser.evaluate('document.querySelector(".create-request-form button[type=submit]").disabled'), true);
      assert.equal(requestPosts().length, before);
    });
    await suite.test('create success Return link fetches latest server history; logout/login retains it', async () => {
      await dashboard();
      await waitText('.recipient-history', "You haven't created any blood requests yet.");
      await browser.click('.recipient-create-button');
      await browser.wait('location.pathname === "/recipient/requests/create"');
      await browser.wait('Boolean(document.querySelector("#request-blood-group"))');
      await browser.input('#request-state', 'Maharashtra');
      await browser.wait('Array.from(document.querySelector("#request-city").options).some(option=>option.value==="Pune")');
      await browser.input('#request-city', 'Pune');
      await browser.wait('Array.from(document.querySelector("#request-organization").options).some(option => option.value === "7")');
      await browser.input('#request-organization', '7');
      await browser.input('#request-blood-group', 'O+');
      await browser.input('#request-units', '1');
      await browser.input('#request-urgency', 'Normal');
      await browser.click('.create-request-form button[type="submit"]');
      await waitText('.create-request-success', '27');
      const before = browser.apiCalls.filter(call => call.method === 'GET' && new URL(call.url).pathname === '/api/requests').length;
      await browser.click('.create-request-success a');
      await waitText('.recipient-request-list', 'Request #27');
      assert.ok(browser.apiCalls.filter(call => call.method === 'GET' && new URL(call.url).pathname === '/api/requests').length > before);
      await browser.click('.recipient-logout');
      await browser.wait('location.pathname === "/login"');
      await fillLogin('recipient');
      await waitText('.recipient-request-list', 'Request #27');
    });
    for (const previousStatus of [200, 401]) {
      await suite.test('late account A ' + previousStatus + ' cannot replace/log out account B', async () => {
        await dashboard({ rows: [row], delay: 800, profileDelay: 800, historyStatus: previousStatus });
        await waitText('.recipient-history', 'Loading your blood requests');
        reset({ name: 'Second recipient', rows: [{ ...row, recipient_id: 17, request_id: 44 }] });
        const nextSession = JSON.stringify(authFixture('recipient', 17));
        await browser.evaluate('localStorage.setItem(' + JSON.stringify(storageKey) + ',' + JSON.stringify(nextSession) + ');window.dispatchEvent(new StorageEvent("storage",{key:' + JSON.stringify(storageKey) + ',newValue:' + JSON.stringify(nextSession) + '}));');
        await waitText('.recipient-request-list', 'Request #44');
        await waitText('#recipient-welcome-title', 'Second recipient!');
        await pause(950);
        assert.equal(await browser.evaluate('location.pathname'), '/recipient/dashboard');
        assert.ok(!(await text('.recipient-request-list')).includes('Request #27'));
        assert.ok(!(await text('#recipient-welcome-title')).includes('Gaurav'));
      });
    }
    await suite.test('desktop and mobile layouts stay readable without overflow', async () => {
      await dashboard({ rows: [row], name: 'A very long recipient name that should wrap inside the account card and welcome message' });
      await waitText('.recipient-request-list', 'Request #27');
      await waitText('#recipient-welcome-title', 'A very long');
      const cache = path.resolve(import.meta.dirname, '../node_modules/.cache');
      for (const [label, width] of [['desktop', 1440], ['mobile', 390]]) {
        await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: label === 'mobile' });
        await pause(100);
        assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
        const screenshot = await browser.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(cache, 'recipient-dashboard-' + label + '.png'), Buffer.from(screenshot.data, 'base64'));
      }
    });
    await suite.test('no uncaught browser errors or unexpected API fixture failures', async () => {
      await pause(100);
      assert.deepEqual(browser.browserErrors, []);
      assert.deepEqual(browser.failures, []);
    });
  } finally { await browser.close(); }
});
