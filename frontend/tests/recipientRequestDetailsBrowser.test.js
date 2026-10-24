import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { authFixture, pause, startBrowser, storageKey } from './helpers/recipientBrowser.js';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('recipient request tracking in a real browser with memory-only APIs', {
  timeout: 180000, skip: !fs.existsSync(chromePath) && 'Set CHROME_PATH to run browser checks.',
}, async (suite) => {
  const browser = await startBrowser(chromePath);
  const row = { request_id: 27, recipient_id: 16, blood_group: 'O+', units_required: 1,
    urgency_level: 'Normal', status: 'Pending', request_date: '2026-10-06T06:30:00.000Z', bank_id: 3, donor_matching_started_at: null, bank_name: 'Central Blood Bank', bank_address: 'Pune Main Road', bank_phone: '02012345678', bank_email: 'central@example.test' };
  let state;
  function reset(overrides = {}) {
    state = { rows: [row, { ...row, request_id: 28, blood_group: 'AB-', status: 'Processing' },
      { ...row, request_id: 42, recipient_id: 17 }], detailStatus: 200, delay: 0, ...overrides };
  }
  const fields = (record) => {
    const { request_id, blood_group, units_required, urgency_level, status, request_date, bank_id, donor_matching_started_at, bank_name, bank_address, bank_phone, bank_email } = record;
    return { request_id, blood_group, units_required, urgency_level, status, request_date, bank_id, donor_matching_started_at, bank_name, bank_address, bank_phone, bank_email,
      fulfilled_units: record.fulfilled_units, remaining_units: record.remaining_units,
      inventory_units: record.inventory_units, donation_units: record.donation_units, history_available: record.history_available };
  };
  browser.mock(async (request, url) => {
    const authorization = request.headers.Authorization || request.headers.authorization;
    assert.ok(authorization?.startsWith('Bearer '));
    const identity = JSON.parse(Buffer.from(authorization.split('.')[1], 'base64url').toString('utf8'));
    if (request.method === 'PATCH' && state.allowCancellation && /^\/api\/requests\/\d+\/cancel$/.test(url.pathname)) {
      assert.deepEqual(JSON.parse(request.postData), {});
      const id = Number(url.pathname.split('/').at(-2));
      const record = state.rows.find(item => item.request_id === id && item.recipient_id === identity.user_id);
      assert.ok(record, 'Cancellation only addresses the signed-in recipient request');
      record.status = 'Cancelled';
      return { body: { request_id: id, status: 'Cancelled', message: 'Blood request cancelled.' } };
    }
    assert.equal(request.method, 'GET', 'Tracking only reads unless cancellation is explicitly tested');
    const snapshot = { ...state, rows: state.rows.map(record => ({ ...record })) };
    if (url.pathname === '/api/requests') {
      return { body: { requests: snapshot.rows.filter(record => record.recipient_id === identity.user_id) } };
    }
    if (url.pathname === '/api/auth/me') {
      return { body: { user_id: identity.user_id, user_type: 'recipient', name: 'Gaurav' } };
    }
    if (/^\/api\/requests\/\d+$/.test(url.pathname)) {
      assert.equal(url.search, '', 'No client ownership query is sent');
      if (snapshot.delay) await pause(snapshot.delay);
      if (snapshot.networkError) return { networkError: true };
      const id = Number(url.pathname.split('/').at(-1));
      const record = snapshot.rows.find(item => item.request_id === id && item.recipient_id === identity.user_id);
      if (snapshot.detailStatus !== 200) {
        return { status: snapshot.detailStatus, body: { message: 'Private SQL details', request: fields(row) } };
      }
      return record ? { body: { request: snapshot.malformed ? { ...fields(record), request_id: 999 } : fields(record) } }
        : { status: 404, body: { message: 'Blood request not found.' } };
    }
    throw new Error('Unexpected API path');
  });
  const text = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent');
  const waitText = (selector, value) => browser.wait('document.querySelector(' + JSON.stringify(selector) + ')?.textContent.includes(' + JSON.stringify(value) + ')');
  async function open(id = 27, overrides = {}, session = authFixture()) {
    reset(overrides);
    await browser.seed(session, '/recipient/requests/' + id);
    await browser.wait('Boolean(document.querySelector(".request-details-page"))');
  }
  async function storageSession() {
    return JSON.parse(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'));
  }

  try {
    await suite.test('anonymous and wrong-role users cannot access details', async () => {
      reset();
      for (const session of [null, authFixture('donor'), authFixture('blood_bank')]) {
        const before = browser.apiCalls.length;
        await browser.seed(session, '/recipient/requests/27');
        await browser.wait('location.pathname === "/login"');
        assert.equal(browser.apiCalls.length, before);
      }
    });
    await suite.test('own request shows real request and selected bank fields and survives direct reload', async () => {
      await open();
      await waitText('.request-details-header h1', 'Blood Request #27');
      for (const value of ['Blood Group', 'O+', 'Units Required', '1', 'Normal', 'Pending', '6 Oct 2026']) {
        assert.ok((await text('.request-details-content')).includes(value));
      }
      await browser.navigate('/recipient/requests/27');
      await waitText('.request-details-header h1', 'Blood Request #27');
    });
    await suite.test('fulfilled request shows safe selected bank contacts without donor information', async () => {
      await open(27, { rows: [{ ...row, status: 'Fulfilled', donor_matching_started_at: null }] });
      await waitText('.request-details-badge', 'Fulfilled');
      const content = await text('.request-details-content');
      for (const value of ['Central Blood Bank', 'Pune Main Road', '02012345678', 'central@example.test']) assert.ok(content.includes(value));
      assert.ok(!content.includes('Matching donors are being contacted.'));
      assert.ok(!content.includes('password_hash'));
      assert.ok(!content.includes('Donor Details'));
    });
    await suite.test('legacy NULL bank remains unassigned without invented bank contacts', async () => {
      await open(27, { rows: [{ ...row, bank_id: null, bank_name: null, bank_address: null,
        bank_phone: null, bank_email: null, donor_matching_started_at: null }] });
      await waitText('.request-details-content', 'Not assigned');
      const content = await text('.request-details-content');
      for (const value of ['Central Blood Bank', 'Pune Main Road', '02012345678', 'central@example.test', 'Matching donors are being contacted.']) assert.ok(!content.includes(value));
      await browser.click('.request-details-back');
      await waitText('.recipient-request-list', 'Not assigned');
      assert.ok(!(await text('.recipient-request-list')).includes('Central Blood Bank'));
    });
    await suite.test('matching explanation requires actual Pending matching marker in details and list', async () => {
      const message = 'Matching donors are being contacted through your selected provider.';
      for (const record of [row, { ...row, donor_matching_started_at: row.request_date },
        { ...row, status: 'Processing', donor_matching_started_at: row.request_date },
        { ...row, status: 'Cancelled', donor_matching_started_at: row.request_date },
        { ...row, status: 'Fulfilled', donor_matching_started_at: row.request_date }]) {
        const matching = ['Pending', 'Processing'].includes(record.status) && Boolean(record.donor_matching_started_at);
        await open(27, { rows: [record] });
        await waitText('.request-details-header h1', 'Blood Request #27');
        assert.equal((await text('.request-details-content')).includes(message), matching);
        await browser.click('.request-details-back');
        await waitText('.recipient-request-list', 'Request #27');
        assert.equal((await text('.recipient-request-list')).includes(message), matching);
      }
    });
    await suite.test('dashboard View Details opens the selected request and Back refreshes history', async () => {
      reset();
      await browser.seed(authFixture());
      await waitText('.recipient-request-list', 'Request #28');
      const callsBefore = browser.apiCalls.length;
      await browser.click('.recipient-view-details[href="/recipient/requests/28"]');
      await waitText('.request-details-header h1', 'Blood Request #28');
      assert.ok((await text('.request-details-content')).includes('AB-'));
      const detailCalls = browser.apiCalls.slice(callsBefore).filter(call => call.url.endsWith('/api/requests/28'));
      assert.ok(detailCalls.length > 0);
      await browser.click('.request-details-back');
      await waitText('.recipient-request-list', 'Request #27');
      assert.equal(await browser.evaluate('location.pathname'), '/recipient/dashboard');
      assert.equal(await browser.evaluate('document.querySelector(".recipient-create-button").getAttribute("href")'), '/recipient/requests/create');
    });
    await suite.test('View Details and Back work with keyboard Enter', async () => {
      await browser.evaluate('document.querySelector(".recipient-view-details").focus()');
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await waitText('.request-details-header h1', 'Blood Request #27');
      await browser.evaluate('document.querySelector(".request-details-back").focus()');
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await browser.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await waitText('.recipient-request-list', 'Request #27');
    });
    for (const [index, status] of ['Pending', 'Processing', 'Fulfilled'].entries()) {
      await suite.test(status + ' badge and progress are correct and accessible', async () => {
        await open(27, { rows: [{ ...row, status }] });
        await waitText('.request-details-badge', status);
        assert.equal(await browser.evaluate('document.querySelector(".request-details-badge").classList.contains(' + JSON.stringify('request-details-status-' + status.toLowerCase()) + ')'), true);
        assert.equal(await browser.evaluate('document.querySelectorAll(".request-details-step").length'), 3);
        assert.equal((await text('.request-details-step[aria-current="step"] h3')).trim(), status);
        assert.equal(await browser.evaluate('document.querySelectorAll(".request-details-step-completed").length'), index);
        assert.equal(await browser.evaluate('document.querySelectorAll(".request-details-step-upcoming").length'), 2 - index);
      });
    }
    await suite.test('Cancelled explicitly shows cancellation without false progress', async () => {
      await open(27, { rows: [{ ...row, status: 'Cancelled' }] });
      await waitText('.request-details-badge', 'Cancelled');
      await waitText('.request-details-cancelled', 'This request was cancelled.');
      assert.equal(await browser.evaluate('document.querySelector(".request-details-progress")'), null);
    });
    await suite.test('recipient can cancel a partially fulfilled Processing request while retaining source totals', async () => {
      await open(27, { allowCancellation: true, rows: [{ ...row, status: 'Processing', units_required: 10,
        fulfilled_units: 5, remaining_units: 5, inventory_units: 3, donation_units: 2, history_available: true }] });
      await waitText('.request-fulfillment', '5 / 10 units fulfilled');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".request-cancel"))'), true,
        'An open request remains cancellable after partial fulfillment');
      const before = browser.apiCalls.length;
      await browser.click('.request-cancel');
      await waitText('.request-details-badge', 'Cancelled');
      await waitText('.request-fulfillment', '5 / 10 units fulfilled');
      const content = await text('.request-fulfillment');
      assert.ok(content.includes('Inventory: 3 units'));
      assert.ok(content.includes('Donation: 2 units'));
      assert.equal(browser.apiCalls.slice(before).filter(call => call.method === 'PATCH').length, 1);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".request-cancel"))'), false);
    });
    await suite.test('null status/date display unavailable without inventing progress', async () => {
      await open(27, { rows: [{ ...row, status: null, request_date: null }] });
      await waitText('.request-details-badge', 'Status unavailable');
      await waitText('.request-details-date', 'Date unavailable');
      assert.equal(await browser.evaluate('document.querySelector(".request-details-progress")'), null);
      await browser.click('.request-details-back');
      await waitText('.recipient-request-list', 'Request #27');
      await waitText('.recipient-request-status', 'Status unavailable');
      await browser.click('.recipient-view-details');
      await waitText('.request-details-badge', 'Status unavailable');
    });
    await suite.test('loading remains visible until the backend responds', async () => {
      await open(27, { delay: 700 });
      await waitText('.request-details-content', 'Loading your blood request');
      assert.equal(await browser.evaluate('document.querySelector(".request-details-summary")'), null);
      await waitText('.request-details-header h1', 'Blood Request #27');
    });
    await suite.test('invalid IDs show a safe error without any details API call', async () => {
      for (const id of ['abc', '0', '-1', '1.5', '2147483648']) {
        const before = browser.apiCalls.length;
        await open(id);
        await waitText('.request-details-error', 'This request link is invalid');
        assert.equal(browser.apiCalls.length, before);
        assert.equal(await browser.evaluate('document.querySelector(".request-details-back").getAttribute("href")'), '/recipient/dashboard');
      }
    });
    await suite.test('foreign and missing requests display the same safe unavailable message', async () => {
      await open(42);
      await waitText('.request-details-error', 'not found');
      const foreign = await text('.request-details-error');
      assert.equal(await browser.evaluate('document.querySelector(".request-details-summary")'), null);
      await open(999);
      await waitText('.request-details-error', 'not found');
      assert.equal(await text('.request-details-error'), foreign);
    });
    await suite.test('forbidden response exposes no request details and keeps Back navigation', async () => {
      await open(27, { detailStatus: 403 });
      await waitText('.request-details-error', 'do not have permission');
      assert.ok(!(await text('.request-details-content')).includes('Private SQL'));
      assert.equal(await browser.evaluate('document.querySelector(".request-details-summary")'), null);
      await browser.click('.request-details-back');
      await waitText('.recipient-request-list', 'Request #27');
    });
    for (const failure of [500, 'network']) {
      await suite.test('backend ' + failure + ' failure is safe and Retry works', async () => {
        await open(27, failure === 'network' ? { networkError: true } : { detailStatus: failure });
        await browser.wait('Boolean(document.querySelector(".request-details-error"))');
        assert.ok(!(await text('.request-details-content')).includes('Private SQL'));
        state.detailStatus = 200; state.networkError = false;
        await browser.click('.request-details-retry');
        await waitText('.request-details-header h1', 'Blood Request #27');
      });
    }
    await suite.test('malformed backend response does not show another request', async () => {
      await open(27, { malformed: true });
      await waitText('.request-details-error', 'Unable to load');
      assert.equal(await browser.evaluate('document.querySelector(".request-details-summary")'), null);
    });
    await suite.test('detail 401 logs out and redirect survives reload', async () => {
      reset({ detailStatus: 401 });
      await browser.seed(authFixture(), '/recipient/requests/27');
      await browser.wait('location.pathname === "/login"');
      assert.equal(await storageSession(), null);
      await browser.navigate('/recipient/requests/27');
      await browser.wait('location.pathname === "/login"');
    });
    await suite.test('expired JWT cannot enter the details page', async () => {
      reset();
      const before = browser.apiCalls.length;
      await browser.seed(authFixture('recipient', 16, Math.floor(Date.now() / 1000) - 1), '/recipient/requests/27');
      await browser.wait('location.pathname === "/login"');
      assert.equal(await storageSession(), null);
      assert.equal(browser.apiCalls.length, before);
    });
    await suite.test('JWT expiring during a pending detail load clears auth', async () => {
      reset({ delay: 3500 });
      await browser.seed(authFixture('recipient', 16, Math.floor(Date.now() / 1000) + 2), '/recipient/requests/27');
      await waitText('.request-details-content', 'Loading your blood request');
      await browser.wait('location.pathname === "/login"');
      assert.equal(await storageSession(), null);
    });
    for (const oldStatus of [200, 401]) {
      await suite.test('late previous request ' + oldStatus + ' cannot replace the new URL or log out', async () => {
        await open(27, { delay: 700, detailStatus: oldStatus });
        await waitText('.request-details-content', 'Loading your blood request');
        reset();
        await browser.evaluate('window.history.pushState({}, "", "/recipient/requests/28");window.dispatchEvent(new PopStateEvent("popstate"));');
        await waitText('.request-details-header h1', 'Blood Request #28');
        await pause(900);
        assert.equal(await browser.evaluate('location.pathname'), '/recipient/requests/28');
        assert.equal((await text('.request-details-header h1')).trim(), 'Blood Request #28');
        assert.ok(await storageSession());
      });
    }
    for (const oldStatus of [200, 401]) {
      await suite.test('late account A ' + oldStatus + ' cannot affect account B', async () => {
        await open(27, { delay: 700, detailStatus: oldStatus });
        await waitText('.request-details-content', 'Loading your blood request');
        reset({ rows: [{ ...row, recipient_id: 17, blood_group: 'B-' }] });
        const next = JSON.stringify(authFixture('recipient', 17));
        await browser.evaluate('localStorage.setItem(' + JSON.stringify(storageKey) + ',' + JSON.stringify(next) + ');window.dispatchEvent(new StorageEvent("storage",{key:' + JSON.stringify(storageKey) + ',newValue:' + JSON.stringify(next) + '}));');
        await waitText('.request-details-fields', 'B-');
        await pause(900);
        assert.equal(await browser.evaluate('location.pathname'), '/recipient/requests/27');
        assert.equal((await storageSession()).user.user_id, 17);
        assert.ok((await text('.request-details-fields')).includes('B-'));
      });
    }
    await suite.test('desktop and narrow mobile layouts have no overflow', async () => {
      await open(2147483647, { rows: [{ ...row, request_id: 2147483647, blood_group: 'AB-', urgency_level: 'Emergency', status: 'Processing', bank_name: 'Bank' + 'x'.repeat(75), bank_address: 'Address' + 'x'.repeat(100), bank_email: 'bank' + 'x'.repeat(80) + '@example.test' }] });
      await waitText('.request-details-header h1', '2147483647');
      const cache = path.resolve(import.meta.dirname, '../node_modules/.cache');
      for (const [label, width] of [['desktop', 1440], ['mobile', 390], ['narrow', 320]]) {
        await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 700 });
        await pause(100);
        assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
        assert.equal(await browser.evaluate('document.querySelector(".request-details-back").getBoundingClientRect().height >= 44'), true);
        const screenshot = await browser.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(path.join(cache, 'recipient-request-details-' + label + '.png'), Buffer.from(screenshot.data, 'base64'));
      }
    });
    await suite.test('no uncaught browser exceptions or fixture errors', async () => {
      await pause(200);
      assert.deepEqual(browser.browserErrors, []);
      assert.deepEqual(browser.failures, []);
    });
  } finally { await browser.close(); }
});
