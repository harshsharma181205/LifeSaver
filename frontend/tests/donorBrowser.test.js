import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authFixture, pause, startBrowser, storageKey } from './helpers/recipientBrowser.js';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('donor dashboard with memory-only authenticated API fixtures', {
  timeout: 180000, skip: !fs.existsSync(chromePath) && 'Set CHROME_PATH to run browser checks.',
}, async (suite) => {
  const browser = await startBrowser(chromePath);
  const profile = { name: 'Gaurav', blood_group: 'A+', location: 'Pune', is_available: 1 };
  const match = { request_id: 27, blood_group: 'A+', units_required: 1,
    urgency_level: 'Emergency', bank_id: 1, bank_name: 'Selected Bank', bank_address: 'Pune', bank_phone: '9876543000', bank_email: 'bank@example.org', donor_response: null,
    status: 'Pending', request_date: '2026-10-07T06:30:00.000Z' };
  const note = { notification_id: 8, donor_id: 16, recipient_id: null, request_id: 27, channel: 'InApp',
    message: 'You may be able to help with an urgent blood request.', is_read: 0, sent_at: '2026-10-07T06:30:00.000Z' };
  let state;
  function reset(overrides = {}) {
    state = { profile: { ...profile }, matches: [{ ...match }], notifications: [{ ...note }],
      profileStatus: 200, matchesStatus: 200, notificationsStatus: 200, markStatus: 200,
      profileDelay: 0, matchesDelay: 0, notificationsDelay: 0, markDelay: 0,
      ownerId: 16, availabilityStatus: 200, availabilityDelay: 0, responseStatus: 201, responseDelay: 0, ...overrides };
  }
  function identity(request) {
    const header = request.headers.Authorization || request.headers.authorization;
    assert.match(header || '', /^Bearer /);
    return JSON.parse(Buffer.from(header.slice(7).split('.')[1], 'base64url').toString());
  }
  const reply = (status, body) => status === 'network' ? { networkError: true } : { status, body };
  browser.mock(async (request, url) => {
    const snap = structuredClone(state);
    if (request.method === 'POST' && /^\/api\/auth\/(donor|recipient)\/login$/.test(url.pathname)) {
      const role = url.pathname.includes('/donor/') ? 'donor' : 'recipient';
      return { body: { token: authFixture(role).token,
        [role]: { [role + '_id']: 16, name: role === 'donor' ? 'Gaurav' : 'Recipient example' } } };
    }
    const owner = identity(request);
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      await pause(snap.profileDelay);
      const body = owner.user_type === 'donor' ? { user_id: owner.user_id, user_type: 'donor', ...snap.profile }
        : { user_id: owner.user_id, user_type: 'recipient', name: 'Recipient example' };
      return reply(snap.profileStatus, snap.profileStatus === 200 ? body : { message: 'Private profile SQL' });
    }
    if (request.method === 'GET' && url.pathname === '/api/requests') {
      assert.equal(owner.user_type, 'recipient', 'Donors must not fetch all recipient requests');
      return { body: { requests: [] } };
    }
    assert.equal(owner.user_type, 'donor');
    assert.equal(url.search, '', 'Donor APIs must not send ownership queries');
    if (request.method === 'GET' && url.pathname === '/api/donors/me/matching-requests') {
      await pause(snap.matchesDelay);
      return reply(snap.matchesStatus, snap.matchesStatus === 200 ? { requests: snap.matches } : { message: 'Private matching SQL' });
    }
    if (request.method === 'PATCH' && url.pathname === '/api/donors/me/availability') {
      const body = JSON.parse(request.postData);
      assert.deepEqual(Object.keys(body), ['is_available']); assert.equal(typeof body.is_available, 'boolean');
      await pause(snap.availabilityDelay);
      if (snap.availabilityStatus === 200 && owner.user_id === state.ownerId) {
        state.profile.is_available = Number(body.is_available);
        state.matches = body.is_available ? [{ ...match }] : [];
      }
      return reply(snap.availabilityStatus, snap.availabilityStatus === 200 ? { is_available: Number(body.is_available) } : { message: 'Private availability SQL' });
    }
    const respond = url.pathname.match(/^\/api\/donors\/me\/requests\/(\d+)\/response$/);
    if (request.method === 'POST' && respond) {
      const body = JSON.parse(request.postData);
      assert.deepEqual(Object.keys(body), ['response']); assert.ok(['Accepted', 'Declined'].includes(body.response));
      const id = Number(respond[1]); assert.ok(snap.matches.some(item => item.request_id === id));
      await pause(snap.responseDelay);
      if ([200, 201].includes(snap.responseStatus) && owner.user_id === state.ownerId) {
        state.matches = body.response === 'Declined' ? state.matches.filter(item => item.request_id !== id)
          : state.matches.map(item => item.request_id === id ? { ...item, donor_response: 'Accepted', status: 'Processing' } : item);
      }
      return reply(snap.responseStatus, [200, 201].includes(snap.responseStatus) ? { request_id: id, response: body.response } : { message: 'Private donor response SQL' });
    }
    const list = url.pathname.match(/^\/api\/notifications\/donor\/(\d+)$/);
    if (request.method === 'GET' && list) {
      assert.equal(Number(list[1]), owner.user_id);
      await pause(snap.notificationsDelay);
      return reply(snap.notificationsStatus, snap.notificationsStatus === 200
        ? { user_type: 'donor', user_id: owner.user_id, notifications: snap.notifications.filter(item => item.donor_id === owner.user_id) }
        : { message: 'Private notification SQL' });
    }
    const mark = url.pathname.match(/^\/api\/notifications\/(\d+)\/read$/);
    if (request.method === 'PATCH' && mark) {
      assert.deepEqual(request.postData ? JSON.parse(request.postData) : {}, {});
      const id = Number(mark[1]);
      assert.ok(snap.notifications.some(item => item.notification_id === id && item.donor_id === owner.user_id));
      await pause(snap.markDelay);
      if (snap.markStatus === 200) {
        const current = state.notifications.find(item => item.notification_id === id && item.donor_id === owner.user_id);
        if (current) current.is_read = 1;
      }
      return reply(snap.markStatus, snap.markStatus === 200 ? { notification_id: id, is_read: 1 } : { message: 'Private mark SQL' });
    }
    throw new Error('Unexpected donor fixture request: ' + request.method + ' ' + url.pathname);
  });
  const text = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent || ""');
  const waitText = (selector, value) => browser.wait('document.querySelector(' + JSON.stringify(selector) + ')?.textContent.includes(' + JSON.stringify(value) + ')');
  const saved = () => browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')');
  const patches = () => browser.apiCalls.filter(call => call.method === 'PATCH').length;
  async function waitPatch(before) {
    for (let n = 0; n < 200; n += 1) { if (patches() > before) return; await pause(25); }
    throw new Error('Timed out waiting for mark-read request');
  }
  async function dashboard(overrides = {}, session = authFixture('donor')) {
    reset(overrides); await browser.seed(session, '/donor/dashboard');
    await browser.wait('Boolean(document.querySelector(".donor-dashboard"))');
  }
  async function settled() {
    await waitText('.donor-welcome-title', 'Gaurav!');
    await waitText('.donor-matches', 'Request #27');
    await waitText('.donor-notifications', note.message);
  }
  async function switchDonor() {
    const next = JSON.stringify(authFixture('donor', 17));
    await browser.evaluate('localStorage.setItem(' + JSON.stringify(storageKey) + ',' + JSON.stringify(next)
      + ');window.dispatchEvent(new StorageEvent("storage",{key:' + JSON.stringify(storageKey) + '}));');
  }
  function secondDonor() {
    reset({ ownerId: 17, profile: { ...profile, name: 'Second donor' }, matches: [{ ...match, request_id: 44 }],
      notifications: [{ ...note, notification_id: 9, donor_id: 17, message: 'Second donor alert' }] });
  }
  async function assertSecondDonor() {
    await waitText('.donor-welcome-title', 'Second donor!');
    await waitText('.donor-matches', 'Request #44');
    await waitText('.donor-notifications', 'Second donor alert');
    assert.equal(await browser.evaluate('location.pathname'), '/donor/dashboard');
    assert.equal(JSON.parse(await saved()).user.user_id, 17);
    assert.ok(!(await text('.donor-matches')).includes('Request #27'));
    assert.ok(!(await text('.donor-notifications')).includes(note.message));
    assert.match(await text('.donor-unread-count'), /1/);
  }
  async function login(role) {
    await browser.input('#login-type', role); await browser.input('#login-phone', '9876543210');
    await browser.input('#login-password', 'Browser-only-password'); await browser.click('.login-submit');
  }
  try {
    await suite.test('wrong roles and expired auth deny access before API calls', async () => {
      reset();
      for (const session of [null, authFixture('recipient'), authFixture('donor', 16, Math.floor(Date.now() / 1000) - 1)]) {
        const before = browser.apiCalls.length;
        await browser.seed(session, '/donor/dashboard'); await browser.wait('location.pathname === "/login"');
        assert.equal(browser.apiCalls.length, before);
        if (session?.user.user_type === 'recipient') assert.deepEqual(JSON.parse(await saved()), session);
        else assert.equal(await saved(), null);
      }
    });
    await suite.test('both logins redirect and Header remains role-specific', async () => {
      for (const role of ['donor', 'recipient']) {
        reset(); await browser.seed(null, '/login');
        await browser.wait('Boolean(document.querySelector("#login-type"))'); await login(role);
        await browser.wait('location.pathname === ' + JSON.stringify('/' + role + '/dashboard'));
        const own = '.site-navigation a[href="/' + role + '/dashboard"]';
        await browser.wait('Boolean(document.querySelector(' + JSON.stringify(own) + '))');
        const opposite = role === 'donor' ? 'recipient' : 'donor';
        assert.equal(await browser.evaluate('Boolean(document.querySelector(' + JSON.stringify('.site-navigation a[href="/' + opposite + '/dashboard"]') + '))'), false);
        const auth = JSON.parse(await saved());
        assert.deepEqual(Object.keys(auth).sort(), ['token', 'user']);
        assert.deepEqual(Object.keys(auth.user).sort(), ['user_id', 'user_type']);
      }
    });
    for (const available of [1, 0]) await suite.test('availability ' + available + ' is self-reported', async () => {
      await dashboard({ profile: { ...profile, is_available: available }, matches: available ? [match] : [] });
      await waitText('.donor-welcome-title', 'Gaurav!');
      assert.match(await text('.donor-availability'), available ? /\bAvailable\b/ : /\bUnavailable\b/);
      assert.match(await text('.donor-dashboard'), /self[- ]reported/i);
      assert.ok((await text('.donor-dashboard')).includes('Pune'));
      assert.ok(!(await text('.donor-welcome-title')).includes('Donor #'));
    });
    await suite.test('loading differs from successful empty sections', async () => {
      await dashboard({ matches: [], notifications: [], matchesDelay: 700, notificationsDelay: 700 });
      await waitText('.donor-matches', 'Loading');
      assert.ok(!(await text('.donor-matches')).includes('No matching blood requests'));
      await waitText('.donor-matches', 'No matching blood requests');
      await browser.wait('!document.querySelector(".donor-notification-item") && !document.querySelector(".donor-notifications").textContent.includes("Loading")');
      assert.match(await text('.donor-unread-count'), /0/);
    });
    await suite.test('matching requests and notifications expose eligible donor actions', async () => {
      await dashboard(); await settled();
      for (const value of ['A+', 'Emergency', 'Pending']) assert.ok((await text('.donor-matches')).includes(value));
      assert.ok((await text('.donor-notifications')).includes('2026'));
      assert.match(await text('.donor-unread-count'), /1/);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".donor-accept") && document.querySelector(".donor-decline"))'), true);
      assert.ok((await text('.donor-matches')).includes('Selected Bank'));
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".donor-dashboard a[href^=\\"/recipient/requests/\\"]"))'), false);
    });
    for (const failure of [404, 500, 'network']) await suite.test('profile ' + failure + ' preserves other sections', async () => {
      await dashboard({ profileStatus: failure }); await waitText('.donor-matches', 'Request #27');
      await waitText('.donor-notifications', note.message);
      await browser.wait('Boolean(document.querySelector(".donor-profile .donor-section-error"))');
      assert.equal((await text('.donor-welcome-title')).trim(), 'Welcome back!');
      assert.ok(!(await text('.donor-dashboard')).includes('Private profile SQL'));
      assert.notEqual((await text('.donor-availability')).trim(), 'Unavailable');
    });
    await suite.test('missing name and unknown availability are not invented', async () => {
      await dashboard({ profile: { ...profile, name: null, is_available: null } });
      await waitText('.donor-matches', 'Request #27');
      assert.equal((await text('.donor-welcome-title')).trim(), 'Welcome back!');
      assert.notEqual((await text('.donor-availability')).trim(), 'Unavailable');
    });
    for (const section of ['matches', 'notifications']) for (const failure of [403, 404, 500, 'network']) {
      await suite.test(section + ' ' + failure + ' is safe and retryable', async () => {
        await dashboard({ [section + 'Status']: failure });
        const selector = '.donor-' + section;
        await browser.wait('Boolean(document.querySelector(' + JSON.stringify(selector + ' .donor-section-error button') + '))');
        assert.ok(!(await text('.donor-dashboard')).includes('Private'));
        await waitText('.donor-welcome-title', 'Gaurav!');
        state[section + 'Status'] = 200;
        await browser.click(selector + ' .donor-section-error button');
        await waitText(selector, section === 'matches' ? 'Request #27' : note.message);
      });
    }
    await suite.test('pending mark-read waits for success and prevents duplicates', async () => {
      await dashboard({ markDelay: 500 }); await settled();
      const before = patches(); await browser.click('.donor-mark-read');
      await browser.wait('document.querySelector(".donor-mark-read")?.disabled === true');
      assert.match(await text('.donor-unread-count'), /1/);
      await browser.click('.donor-mark-read'); await browser.wait('!document.querySelector(".donor-mark-read")');
      assert.equal(patches() - before, 1); assert.match(await text('.donor-unread-count'), /0/);
      assert.equal(await text('.donor-read-state'), 'Read');
    });
    for (const failure of [500, 'network']) await suite.test('failed mark-read ' + failure + ' preserves unread', async () => {
      await dashboard({ markStatus: failure }); await settled(); await browser.click('.donor-mark-read');
      await browser.wait('Boolean(document.querySelector(".donor-notifications [role=\\"alert\\"]"))');
      assert.match(await text('.donor-unread-count'), /1/);
      assert.ok(!(await text('.donor-notifications')).includes('Private mark SQL'));
      state.markStatus = 200; await browser.click('.donor-mark-read');
      await browser.wait('!document.querySelector(".donor-mark-read")');
      assert.match(await text('.donor-unread-count'), /0/);
    });
    for (const section of ['profile', 'matches', 'notifications']) await suite.test(section + ' 401 clears auth through reload', async () => {
      reset({ [section + 'Status']: 401 }); await browser.seed(authFixture('donor'), '/donor/dashboard');
      await browser.wait('location.pathname === "/login"'); assert.equal(await saved(), null);
      await browser.navigate('/donor/dashboard'); await browser.wait('location.pathname === "/login"');
    });
    await suite.test('mark-read 401 and mounted expiry clear auth', async () => {
      await dashboard({ markStatus: 401 }); await settled(); await browser.click('.donor-mark-read');
      await browser.wait('location.pathname === "/login"'); assert.equal(await saved(), null);
      await dashboard({}, authFixture('donor', 16, Math.floor(Date.now() / 1000) + 3));
      await waitText('.donor-welcome-title', 'Gaurav!');
      await browser.wait('location.pathname === "/login"'); assert.equal(await saved(), null);
    });
    for (const oldStatus of [200, 401]) {
      await suite.test('late donor A GET ' + oldStatus + ' cannot affect B', async () => {
        const before = browser.apiCalls.length;
        await dashboard({ profileDelay: 900, matchesDelay: 900, notificationsDelay: 900,
          profileStatus: oldStatus, matchesStatus: oldStatus, notificationsStatus: oldStatus });
        await waitText('.donor-matches', 'Loading');
        const paths = () => [...new Set(browser.apiCalls.slice(before).filter(call => call.method === 'GET').map(call => new URL(call.url).pathname))].sort();
        for (let n = 0; n < 100 && paths().length < 3; n += 1) await pause(10);
        assert.deepEqual(paths(), ['/api/auth/me', '/api/donors/me/matching-requests', '/api/notifications/donor/16']);
        secondDonor(); await switchDonor();
        await assertSecondDonor(); await pause(1100); await assertSecondDonor();
      });
      await suite.test('late donor A PATCH ' + oldStatus + ' cannot affect B', async () => {
        await dashboard({ markStatus: oldStatus, markDelay: 700 }); await settled();
        const before = patches(); await browser.click('.donor-mark-read'); await waitPatch(before);
        secondDonor(); await switchDonor(); await assertSecondDonor(); await pause(850); await assertSecondDonor();
      });
    }
    await suite.test('keyboard mark-read and logout remain usable', async () => {
      await dashboard(); await settled();
      await browser.cdp.send('Page.bringToFront');
      await browser.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      async function enter(selector) {
        await browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ').focus()');
        for (const type of ['rawKeyDown', 'char', 'keyUp']) await browser.cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, ...(type === 'char' ? { text: '\r', unmodifiedText: '\r' } : {}) });
      }
      await enter('.donor-mark-read'); await browser.wait('!document.querySelector(".donor-mark-read")');
      assert.equal(await browser.evaluate('document.activeElement.classList.contains("donor-notification-item")'), true);
      assert.equal(await text('.donor-read-state'), 'Read');
      await enter('.donor-logout'); await browser.wait('location.pathname === "/login"');
      assert.equal(await saved(), null); await browser.navigate('/donor/dashboard'); await browser.wait('location.pathname === "/login"');
    });
    await suite.test('320,390,1440 layouts wrap long safe values', async () => {
      await dashboard({ profile: { ...profile, name: 'Donor' + 'x'.repeat(65), location: 'City' + 'x'.repeat(90) },
        matches: [{ ...match, units_required: 2147483647 }], notifications: [{ ...note, message: 'Alert' + 'x'.repeat(150) }] });
      await waitText('.donor-welcome-title', 'Donorxxxxx'); await waitText('.donor-notifications', 'Alertxxxxx');
      for (const width of [320, 390, 1440]) {
        await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 500 });
        await pause(100);
        assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
        assert.equal(await browser.evaluate('Array.from(document.querySelectorAll(".donor-profile-value,.donor-request-item,.donor-notification-item")).every(n=>n.scrollWidth<=n.clientWidth+1)'), true);
        const screenshot = await browser.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        fs.writeFileSync(new URL('../node_modules/.cache/donor-dashboard-' + width + '.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
      }
    });

    await suite.test('availability toggles use real protected PATCH and refresh matching requests', async () => {
      await dashboard({ availabilityDelay: 500 }); await settled();
      const before = patches(); await browser.click('.donor-availability-controls button:nth-child(2)');
      await browser.wait('document.querySelector(".donor-availability-controls button")?.disabled === true');
      await browser.click('.donor-availability-controls button:nth-child(2)');
      await waitText('.donor-availability', 'Unavailable'); await waitText('.donor-matches', 'No matching blood requests');
      assert.equal(patches() - before, 1);
      await browser.click('.donor-availability-controls button:first-child');
      await waitText('.donor-availability', 'Available'); await waitText('.donor-matches', 'Request #27');
    });
    for (const failure of [400, 403, 500, 'network']) await suite.test('availability failure ' + failure + ' preserves previous state', async () => {
      await dashboard({ availabilityStatus: failure }); await settled(); await browser.click('.donor-availability-controls button:nth-child(2)');
      await browser.wait('Boolean(document.querySelector(".donor-profile [role=alert]"))');
      assert.equal((await text('.donor-availability')).trim(), 'Available');
      assert.ok(!(await text('.donor-profile')).includes('Private'));
    });
    await suite.test('profile failure disables availability actions', async () => {
      await dashboard({ profileStatus: 500 }); await waitText('.donor-matches', 'Request #27');
      assert.equal(await browser.evaluate('Array.from(document.querySelectorAll(".donor-availability-controls button")).every(button=>button.disabled)'), true);
    });
    await suite.test('accept awaits server confirmation then screening state survives refresh', async () => {
      await dashboard({ responseDelay: 500 }); await settled();
      const before = browser.apiCalls.filter(item => item.method === 'POST').length;
      await browser.click('.donor-accept');
      await browser.wait('document.querySelector(".donor-accept")?.disabled === true');
      assert.ok(!(await text('.donor-matches')).includes('Awaiting Hospital / Blood Bank Medical Screening'));
      await browser.click('.donor-decline');
      await waitText('.donor-accepted', 'Awaiting Hospital / Blood Bank Medical Screening');
      assert.equal(browser.apiCalls.filter(item => item.method === 'POST').length - before, 1);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".donor-accept"))'), false);
      assert.ok((await text('.donor-action-success')).includes('Request is Processing'));
      await browser.click('.donor-refresh'); await waitText('.donor-accepted', 'Awaiting Hospital / Blood Bank Medical Screening');
    });
    await suite.test('decline removes only confirmed opportunity and survives reload', async () => {
      await dashboard(); await settled(); await browser.click('.donor-decline');
      await waitText('.donor-matches', 'No matching blood requests');
      assert.ok((await text('.donor-action-success')).includes('Request declined'));
      await browser.navigate('/donor/dashboard'); await waitText('.donor-matches', 'No matching blood requests');
    });
    for (const failure of [400, 403, 404, 409, 500, 'network']) await suite.test('response failure ' + failure + ' keeps eligibility until refresh', async () => {
      await dashboard({ responseStatus: failure }); await settled(); await browser.click('.donor-accept');
      await browser.wait('Boolean(document.querySelector(".donor-request-item [role=alert]"))');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".donor-accepted"))'), false);
      assert.equal(await browser.evaluate('document.querySelector(".donor-accept").disabled'), false);
      assert.ok(!(await text('.donor-matches')).includes('Private'));
    });
    for (const action of ['availability', 'response']) await suite.test(action + ' 401 logs out safely', async () => {
      await dashboard({ [action + 'Status']: 401 }); await settled();
      await browser.click(action === 'availability' ? '.donor-availability-controls button:nth-child(2)' : '.donor-accept');
      await browser.wait('location.pathname === "/login"'); assert.equal(await saved(), null);
    });
    for (const action of ['availability', 'response']) for (const status of [200, 401]) await suite.test('late ' + action + ' ' + status + ' from donor A cannot affect B', async () => {
      await dashboard({ [action + 'Status']: status, [action + 'Delay']: 800 }); await settled();
      const before = browser.apiCalls.length;
      await browser.click(action === 'availability' ? '.donor-availability-controls button:nth-child(2)' : '.donor-accept');
      for (let n = 0; n < 100 && browser.apiCalls.length === before; n += 1) await pause(10);
      assert.ok(browser.apiCalls.length > before);
      secondDonor(); await switchDonor(); await assertSecondDonor(); await pause(1000); await assertSecondDonor();
      assert.equal(await text('.donor-availability'), 'Available');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".donor-accepted"))'), false);
    });
    await suite.test('no uncaught browser errors or fixture failures', async () => {
      await pause(100); assert.deepEqual(browser.browserErrors, []); assert.deepEqual(browser.failures, []);
    });
  } finally { await browser.close(); }
});
