import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authFixture, pause, startBrowser, storageKey } from './helpers/recipientBrowser.js';
import { providerQueueFixture } from './helpers/providerQueueFixture.js';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('provider review scheduling in Chrome with memory-only APIs', {
  timeout: 180000, skip: !fs.existsSync(chromePath) && 'Set CHROME_PATH to run browser checks.',
}, async suite => {
  const browser = await startBrowser(chromePath);
  const profile = { user_id: 9, user_type: 'organization', organization_id: 9,
    organization_type: 'Blood Bank', bank_id: 3, name: 'Scheduling fixture provider',
    bank_name: 'Scheduling fixture provider', state: 'Maharashtra', city: 'Pune',
    address: 'Fixture address', phone: '02012345678', email: 'queue@example.test' };
  let state;
  function row(id, urgency = 'Normal', ageHours = 2) {
    return { request_id: id, bank_id: 3, blood_group: 'A+', units_required: 5,
      fulfilled_units: 1, remaining_units: 4, inventory_units: 1, donation_units: 0,
      history_available: true, urgency_level: urgency, status: 'Processing',
      request_date: new Date(Date.now() - ageHours * 3600000).toISOString(),
      bank_name: profile.name, bank_address: profile.address, bank_phone: profile.phone,
      bank_email: profile.email, state: profile.state, city: profile.city, accepted_donors: [] };
  }
  function reset(overrides = {}) {
    state = { profile: { ...profile }, requests: [row(31)], queueRows: null,
      queueStatus: 200, queueDelay: 0, profileDelay: 0, profileReplies: 0, ...overrides };
  }
  // Har external call intercept hoti hai; asli backend/MySQL use nahi honge.
  browser.mock(async (request, url) => {
    const header = request.headers.Authorization || request.headers.authorization;
    assert.match(header || '', /^Bearer /);
    const identity = JSON.parse(Buffer.from(header.slice(7).split('.')[1], 'base64url'));
    assert.equal(request.method, 'GET', 'Review controls must never issue a clinical mutation');
    if (url.pathname === '/api/auth/me') {
      const current = state;
      if (current.profileDelay) await pause(current.profileDelay);
      current.profileReplies++;
      return { body: { ...current.profile, user_id: identity.user_id, user_type: identity.user_type } };
    }
    if (url.pathname === '/api/requests') return { body: { requests: state.requests.map(item => ({ ...item })) } };
    if (url.pathname === '/api/inventory/3') return { body: { bank_id: 3,
      inventory: [{ inventory_id: 4, bank_id: 3, blood_group: 'A+', units_available: 7, version: 0, updated_at: null }] } };
    if (url.pathname === '/api/requests/provider-queue') {
      const snapshot = { status: state.queueStatus, delay: state.queueDelay,
        rows: (state.queueRows ?? state.requests).map(item => ({ ...item })) };
      if (snapshot.delay) await pause(snapshot.delay);
      if (snapshot.status === 'network') return { networkError: true };
      if (snapshot.status !== 200) return { status: snapshot.status, body: { message: 'Private SQL/password details' } };
      return { body: providerQueueFixture(snapshot.rows, { bankId: 3,
        organizationId: identity.user_type === 'organization' ? identity.user_id : null }) };
    }
    throw new Error('Unexpected queue fixture: ' + request.method + ' ' + url.pathname);
  });
  const text = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent || ""');
  const waitText = (selector, value) => browser.wait('(document.querySelector(' + JSON.stringify(selector)
    + ')?.textContent || "").includes(' + JSON.stringify(value) + ')');
  const ids = () => browser.evaluate('Array.from(document.querySelectorAll(".provider-queue-list li[data-request-id]")).map(node => Number(node.dataset.requestId))');
  const queueCalls = () => browser.apiCalls.filter(call => new URL(call.url).pathname === '/api/requests/provider-queue').length;
  const active = id => waitText('.provider-queue-active', '#' + id);
  async function dashboard(overrides = {}, session = authFixture('organization', 9), route = '/organization/dashboard') {
    reset(overrides);
    await browser.seed(session, route);
    await browser.wait('Boolean(document.querySelector(".provider-queue"))');
    if (state.queueStatus === 200) {
      await browser.wait('document.querySelector(".provider-queue-start") && !document.querySelector(".provider-queue-refresh").disabled');
    }
  }
  async function start(id) {
    await browser.click('.provider-queue-start');
    await active(id);
  }
  async function refresh() {
    const before = queueCalls();
    await browser.click('.provider-queue-refresh');
    await browser.wait('document.querySelector(".provider-queue-refresh")?.disabled === false');
    assert.ok(queueCalls() > before);
  }
  try {
    await suite.test('visible queue presents JavaScript priority, FCFS ties, remaining units, reasons and long-wait reminder', async () => {
      const first = row(13, 'Emergency', 3), tie = { ...first, request_id: 14 };
      await dashboard({ requests: [row(31, 'Normal', 48), row(15, 'Emergency', 1), tie, first] });
      await browser.wait('document.querySelectorAll(".provider-queue-list li[data-request-id]").length === 4');
      assert.deepEqual(await ids(), [13, 14, 15, 31]);
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelectorAll(".provider-queue-position")).map(node => Number(node.textContent))'), [1, 2, 3, 4]);
      const queueText = await text('.provider-queue');
      assert.match(queueText, /Emergency/); assert.match(queueText, /Normal/);
      assert.match(queueText, /Priority 0/); assert.match(queueText, /Priority 1/);
      assert.match(queueText, /FCFS/); assert.match(queueText, /creation/i);
      assert.match(queueText, /remaining/i); assert.match(queueText, /4/);
      assert.match(await text('.provider-queue-alert'), /Normal|normal/);
      assert.ok(!/starvation[- ]free|prevents starvation/i.test(queueText));
      assert.ok(!queueText.includes('Private'));
    });
    await suite.test('Start Next Review fetches a fresh queue, selects new Emergency and prevents duplicate dispatch', async () => {
      await dashboard();
      state.queueRows = [row(31), row(12, 'Emergency')]; state.queueDelay = 350;
      const before = queueCalls();
      await browser.click('.provider-queue-start');
      await browser.wait('document.querySelector(".provider-queue-start").disabled');
      await browser.click('.provider-queue-start');
      await active(12);
      assert.equal(queueCalls() - before, 1);
      assert.equal(await browser.evaluate('document.querySelector(".provider-queue-new-round").disabled'), true);
    });
    await suite.test('new Emergency cannot preempt active Normal; next dispatch selects it without clinical writes', async () => {
      await dashboard(); await start(31);
      const original = JSON.stringify(state.requests);
      state.queueRows = [row(31), row(12, 'Emergency')];
      await refresh(); await active(31);
      await waitText('.provider-queue-emergency', 'Emergency');
      assert.equal(await browser.evaluate('document.querySelector(".provider-queue-start").disabled'), true);
      assert.equal(await browser.evaluate('document.querySelector(".provider-queue-new-round").disabled'), true);
      await browser.click('.provider-queue-finish');
      await browser.wait('!document.querySelector(".provider-queue-active")');
      assert.ok(!(await ids()).includes(31));
      await start(12);
      assert.equal(JSON.stringify(state.requests), original);
      assert.equal(browser.apiCalls.filter(call => call.method !== 'GET').length, 0);
    });
    await suite.test('Finish Review changes only this review round; new round restores still-open requests', async () => {
      await dashboard();
      const original = JSON.stringify(state.requests);
      await start(31); await browser.click('.provider-queue-finish');
      await browser.wait('!document.querySelector(".provider-queue-active")');
      assert.deepEqual(await ids(), []);
      assert.equal(JSON.stringify(state.requests), original);
      await browser.click('.provider-queue-new-round');
      await browser.wait('document.querySelectorAll(".provider-queue-list li[data-request-id]").length === 1');
      assert.deepEqual(await ids(), [31]); await start(31);
      assert.equal(state.requests[0].status, 'Processing');
      assert.equal(state.requests[0].remaining_units, 4);
    });
    await suite.test('active review survives a queue omission after cancellation and can be explicitly finished', async () => {
      await dashboard(); await start(31);
      state.requests[0] = { ...state.requests[0], status: 'Cancelled' }; state.queueRows = [];
      await refresh(); await active(31);
      assert.deepEqual(await ids(), []);
      await browser.click('.provider-queue-finish');
      await browser.wait('!document.querySelector(".provider-queue-active")');
      assert.equal(state.requests[0].status, 'Cancelled');
      assert.equal(state.requests[0].remaining_units, 4);
    });
    await suite.test('failed queue refresh preserves active review and shows safe error', async () => {
      await dashboard(); await start(31); state.queueStatus = 500;
      await refresh(); await active(31);
      await browser.wait('Boolean(document.querySelector(".provider-queue-error"))');
      assert.ok(!(await text('.provider-queue-error')).includes('Private'));
    });
    for (const status of [403, 500, 'network']) await suite.test('queue error ' + status + ' is visible and retryable without private details', async () => {
      await dashboard({ queueStatus: status });
      await browser.wait('Boolean(document.querySelector(".provider-queue-error"))');
      assert.ok(!(await text('.provider-queue-error')).includes('Private'));
      state.queueStatus = 200; await refresh();
      await browser.wait('!document.querySelector(".provider-queue-error")');
      assert.deepEqual(await ids(), [31]);
    });
    await suite.test('queue 401 logs out and redirects to login', async () => {
      await dashboard(); state.queueStatus = 401;
      await browser.click('.provider-queue-refresh');
      await browser.wait('location.pathname === "/login"');
      assert.equal(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'), null);
    });
    await suite.test('queue Open request resets history filter and focuses existing clinical request card', async () => {
      await dashboard();
      await browser.wait('Boolean(document.querySelector("#bank-request-filter"))');
      await browser.input('#bank-request-filter', 'Cancelled');
      await browser.wait('document.querySelectorAll(".bank-request-card").length === 0');
      await browser.click('.provider-queue-list li[data-request-id="31"] button');
      await browser.wait('Boolean(document.querySelector("#provider-request-31"))');
      assert.equal(await browser.evaluate('document.querySelector("#bank-request-filter").value'), 'All');
      await browser.wait('document.activeElement.id === "provider-request-31"');
    });
    await suite.test('Hospital sees functional scheduling queue without inventory controls or calls', async () => {
      const before = browser.apiCalls.length;
      await dashboard({ profile: { ...profile, organization_type: 'Hospital' } });
      await start(31);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-inventory"))'), false);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-process"))'), false);
      assert.ok(!browser.apiCalls.slice(before).some(call => new URL(call.url).pathname.startsWith('/api/inventory/')));
    });
    await suite.test('NGO dashboard does not display or request a clinical queue', async () => {
      reset({ profile: { ...profile, organization_type: 'NGO', bank_id: null } });
      const before = browser.apiCalls.length;
      await browser.seed(authFixture('organization', 9), '/organization/dashboard');
      await waitText('.organization-page', profile.name);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".provider-queue"))'), false);
      assert.ok(!browser.apiCalls.slice(before).some(call => new URL(call.url).pathname === '/api/requests/provider-queue'));
    });
    await suite.test('legacy Blood Bank route exposes scheduling and supports a narrow viewport without overflow', async () => {
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 375, height: 812, deviceScaleFactor: 1, mobile: false });
      await dashboard({ profile: { ...profile, user_id: 3, user_type: 'blood_bank' }, profileDelay: 300 }, authFixture('blood_bank', 3), '/blood-bank/dashboard');
      await start(31);
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      assert.equal(await browser.evaluate('document.querySelectorAll("#provider-review-queue").length'), 1);
    });
    await suite.test('equivalent legacy profile refresh cannot abort an in-flight review dispatch', async () => {
      await dashboard({ profile: { ...profile, user_id: 3, user_type: 'blood_bank' } }, authFixture('blood_bank', 3), '/blood-bank/dashboard');
      state.profileDelay = 400;
      const replies = state.profileReplies, before = queueCalls();
      await browser.click('.provider-queue-list li[data-request-id="31"] button');
      await browser.wait('document.querySelector(".provider-queue-refresh")?.disabled === false');
      assert.ok(queueCalls() > before);
      state.queueDelay = 800;
      await start(31);
      assert.ok(state.profileReplies > replies);
      assert.equal(browser.apiCalls.filter(call => call.method !== 'GET').length, 0);
    });
    assert.deepEqual(browser.browserErrors, []);
    assert.deepEqual(browser.failures, []);
  } finally { await browser.close(); }
});
