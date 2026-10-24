import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { authFixture, pause, startBrowser, storageKey } from './helpers/recipientBrowser.js';
import { providerQueueFixture } from './helpers/providerQueueFixture.js';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const memoryPassword = 'Memory-test-password';
const privateMarker = 'PRIVATE_INTERNAL_RESPONSE';

test('account forms and shared footer in a real Chrome browser with memory-only APIs', {
  timeout: 180000, skip: !fs.existsSync(chromePath) && 'Set CHROME_PATH to run browser checks.',
}, async suite => {
  const browser = await startBrowser(chromePath);
  let state;
  const organization = { organization_id: 9, user_id: 9, user_type: 'organization',
    organization_type: 'Hospital', name: 'Memory Organization', bank_id: 6,
    state: 'Maharashtra', city: 'Pune', address: 'Memory-only test address',
    phone: '9876543210', email: 'memory@example.test' };
  function reset(overrides = {}) {
    state = { loginStatus: 401, registrationStatus: 201, loginDelay: 0,
      registrationDelay: 0, profile: { ...organization }, ...overrides };
  }
  browser.mock(async (request, url) => {
    const snapshot = { ...state, profile: { ...state.profile } };
    if (request.method === 'POST' && /^\/api\/auth\/(donor|recipient|organization)\/login$/.test(url.pathname)) {
      if (snapshot.loginDelay) await pause(snapshot.loginDelay);
      if (snapshot.loginNetwork) return { networkError: true };
      if (snapshot.loginStatus !== 200) return { status: snapshot.loginStatus,
        body: { message: privateMarker, password: privateMarker, password_hash: privateMarker } };
      const role = url.pathname.split('/').at(-2);
      const session = authFixture(role, 9);
      return { body: { token: session.token, user: snapshot.profile,
        password: privateMarker, password_hash: privateMarker } };
    }
    if (request.method === 'POST' && ['/api/organizations', '/api/donors', '/api/recipients'].includes(url.pathname)) {
      if (snapshot.registrationDelay) await pause(snapshot.registrationDelay);
      if (snapshot.registrationNetwork) return { networkError: true };
      return { status: snapshot.registrationStatus, body: { message: privateMarker,
        organization: snapshot.profile, password: privateMarker, password_hash: privateMarker } };
    }
    if (request.method === 'GET' && url.pathname === '/api/auth/me') return { body: snapshot.profile };
    if (request.method === 'GET' && url.pathname === '/api/requests/provider-queue') return { body: providerQueueFixture([], {
      bankId: snapshot.profile.bank_id, organizationId: snapshot.profile.organization_id }) };
    if (request.method === 'GET' && url.pathname === '/api/requests') return { body: { requests: [] } };
    if (request.method === 'GET' && url.pathname === '/api/inventory/6') return { body: { bank_id: 6, inventory: [] } };
    throw new Error('Unexpected memory API path: ' + request.method + ' ' + url.pathname);
  });
  const text = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent || ""');
  const value = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.value');
  const exists = selector => browser.evaluate('Boolean(document.querySelector(' + JSON.stringify(selector) + '))');
  const waitText = (selector, expected) => browser.wait('(document.querySelector(' + JSON.stringify(selector) + ')?.textContent || "").includes(' + JSON.stringify(expected) + ')');
  async function open(route, overrides = {}) {
    reset(overrides);
    await browser.seed(null, route);
    await browser.wait('Boolean(document.querySelector(' + JSON.stringify(route.startsWith('/login') ? '.login-card' : route.startsWith('/register') ? '.register-card' : '.home-hero') + '))');
  }
  async function input(selector, entry) {
    await browser.evaluate('(() => { const node = document.querySelector(' + JSON.stringify(selector) + '); const proto = node.tagName === "SELECT" ? HTMLSelectElement.prototype : node.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, "value").set.call(node, ' + JSON.stringify(entry) + '); node.dispatchEvent(new Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true })); })()');
  }
  async function fillOrganization(overrides = {}) {
    const entries = { '#register-name': 'Memory Organization', '#register-organization-type': 'Hospital',
      '#register-phone': '9876543210', '#register-email': 'memory@example.test',
      '#register-address': 'Memory-only test address', '#register-state': 'Maharashtra', '#register-city': 'Pune',
      '#register-password': memoryPassword, '#register-confirm-password': memoryPassword, ...overrides };
    for (const [selector, entry] of Object.entries(entries)) await input(selector, entry);
  }
  async function submitLogin(identifier = '9876543210', password = memoryPassword) {
    const selector = await exists('#login-identifier') ? '#login-identifier' : '#login-phone';
    await input(selector, identifier);
    await input('#login-password', password);
    await browser.click('.login-submit');
  }
  async function viewport(width) {
    await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: width < 700 });
    await pause(80);
  }
  async function screenshot(label) {
    const result = await browser.cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const cache = path.resolve(import.meta.dirname, '../node_modules/.cache');
    fs.writeFileSync(path.join(cache, 'account-forms-' + label + '.png'), Buffer.from(result.data, 'base64'));
  }
  try {
    await suite.test('login exposes exactly Donor Recipient Organization with no duplicate legacy option', async () => {
      await open('/login');
      const labels = await browser.evaluate('Array.from(document.querySelector("#login-type").options, option => [option.value, option.textContent])');
      assert.deepEqual(labels, [['donor', 'Donor'], ['recipient', 'Recipient'], ['organization', 'Organization']]);
      assert.ok(!(await text('.login-card')).includes('Blood Bank (existing account)'));
      await input('#login-type', 'organization');
      await waitText('#login-identifier-hint', 'Hospital, Blood Bank and NGO');
      assert.equal(await browser.evaluate('document.querySelector("label[for=login-identifier]").textContent'), 'Phone or Email');
    });
    await suite.test('each visible login type sends phone and email to its existing endpoint', async () => {
      for (const role of ['donor', 'recipient', 'organization']) {
        await open('/login', { loginStatus: 400 });
        await input('#login-type', role);
        for (const identifier of ['9876543210', 'memory@example.test']) {
          const before = browser.apiCalls.length;
          await submitLogin(identifier);
          await waitText('.login-error', 'Please check');
          const calls = browser.apiCalls.slice(before);
          assert.equal(calls.length, 1);
          assert.equal(new URL(calls[0].url).pathname, '/api/auth/' + role + '/login');
          const payload = JSON.parse(calls[0].postData);
          assert.equal(payload.identifier, identifier);
          assert.deepEqual(Object.keys(payload).sort(), ['identifier', 'password']);
          assert.ok(!(await text('.login-card')).includes(privateMarker));
        }
      }
    });
    await suite.test('login rejects empty invalid phone invalid email and missing password without an API call', async () => {
      await open('/login');
      const before = browser.apiCalls.length;
      for (const [identifier, password, message] of [
        ['', '', 'Please enter'], ['short', memoryPassword, 'valid email'],
        ['12345', memoryPassword, 'valid email'], ['memory@invalid', memoryPassword, 'valid email'],
        ['9876543210', '', 'Please enter'],
      ]) {
        await submitLogin(identifier, password);
        await waitText('.login-error', message);
      }
      assert.equal(browser.apiCalls.length, before);
    });
    await suite.test('organization login loading prevents duplicate submissions and safely clears password after 401', async () => {
      await open('/login', { loginDelay: 450 });
      await input('#login-type', 'organization');
      const before = browser.apiCalls.length;
      await submitLogin('memory@example.test');
      await waitText('.login-submit', 'Logging in...');
      assert.equal(await browser.evaluate('document.querySelector(".login-submit").disabled'), true);
      assert.equal(await browser.evaluate('document.querySelector("#login-type").disabled'), true);
      await browser.evaluate('document.querySelector(".login-form").requestSubmit()');
      await waitText('.login-error', 'Incorrect phone number');
      assert.equal(browser.apiCalls.slice(before).length, 1);
      assert.equal(await value('#login-password'), '');
      assert.equal(await browser.evaluate('document.querySelector(".login-submit").disabled'), false);
      assert.ok(!(await text('.login-card')).includes(privateMarker));
    });
    for (const [status, message] of [[400, 'Please check'], [500, 'server could not complete'], ['network', 'Unable to reach the backend']]) {
      await suite.test('organization login handles ' + status + ' safely', async () => {
        await open('/login', status === 'network' ? { loginNetwork: true } : { loginStatus: status });
        await input('#login-type', 'organization');
        await submitLogin('memory@example.test');
        await waitText('.login-error', message);
        assert.ok(!(await text('body')).includes(privateMarker));
      });
    }
    for (const type of ['Hospital', 'Blood Bank', 'NGO']) {
      await suite.test('single Organization login handles a ' + type + ' account with minimal JWT identity storage', async () => {
        const profile = { ...organization, organization_type: type, name: 'Memory ' + type,
          bank_id: type === 'NGO' ? null : 6 };
        await open('/login', { loginStatus: 200, profile });
        await input('#login-type', 'organization');
        await submitLogin('memory@example.test');
        await browser.wait('location.pathname === "/organization/dashboard"');
        await waitText('main', profile.name);
        const stored = JSON.parse(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'));
        assert.deepEqual(stored.user, { user_id: 9, user_type: 'organization' });
        assert.deepEqual(Object.keys(stored).sort(), ['token', 'user']);
        assert.ok(!JSON.stringify(stored).includes(privateMarker));
        assert.ok(!(await text('body')).includes(privateMarker));
        if (type === 'NGO') assert.equal(await exists('.bank-inventory'), false);
      });
    }
    await suite.test('registration has role-appropriate fields without personal donor fields for organizations', async () => {
      await open('/register');
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelector("#register-type").options, option => option.textContent)'), ['Donor', 'Recipient', 'Organization']);
      assert.equal(await exists('#register-date-of-birth'), true);
      assert.equal(await exists('#register-age'), false);
      assert.equal(await exists('#register-last-donation'), true);
      await input('#register-type', 'recipient');
      assert.equal(await exists('#register-age'), true);
      assert.equal(await exists('#register-date-of-birth'), false);
      assert.equal(await exists('#register-state'), false);
      await input('#register-type', 'organization');
      for (const selector of ['#register-organization-type', '#register-name', '#register-state', '#register-city', '#register-address', '#register-phone', '#register-email', '#register-password', '#register-confirm-password']) assert.equal(await exists(selector), true);
      for (const selector of ['#register-gender', '#register-age', '#register-date-of-birth', '#register-blood-group', '#register-last-donation', '#register-availability', '#register-monitored-by']) assert.equal(await exists(selector), false);
      assert.equal(await text('label[for=register-name]'), 'Organization Name *');
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelector("#register-organization-type").options, option => option.textContent)'), ['Hospital', 'Blood Bank', 'NGO']);
    });
    await suite.test('registration uses one 36-state select and city depends on selected state', async () => {
      await open('/register?type=organization');
      const before = browser.apiCalls.length;
      assert.equal(await exists('#register-state-search'), false);
      const states = await browser.evaluate('Array.from(document.querySelector("#register-state").options, option => option.value).filter(Boolean)');
      assert.equal(states.length, 36);
      assert.equal(new Set(states).size, 36);
      for (const territory of ['Delhi', 'Jammu and Kashmir', 'Ladakh', 'Puducherry', 'Chandigarh', 'Lakshadweep', 'Andaman and Nicobar Islands', 'Dadra and Nagar Haveli and Daman and Diu']) assert.ok(states.includes(territory));
      assert.equal(await browser.evaluate('document.querySelector("#register-city").disabled'), true);
      await input('#register-state', 'Maharashtra');
      assert.equal(await browser.evaluate('document.querySelector("#register-city").disabled'), false);
      await input('#register-city', 'Pune');
      await input('#register-state', 'Uttar Pradesh');
      assert.equal(await value('#register-city'), '');
      await waitText('#register-city-hint', 'Uttar Pradesh');
      assert.equal(browser.apiCalls.length, before, 'No fabricated provider or city directory is loaded by registration');
    });
    await suite.test('desktop retains existing compact widths and aligns organization and location fields', async () => {
      await viewport(1440);
      await open('/login');
      assert.equal(await browser.evaluate('Math.round(document.querySelector(".login-card").getBoundingClientRect().width)'), 480);
      await screenshot('login-desktop');
      await open('/register?type=organization');
      assert.equal(await browser.evaluate('Math.round(document.querySelector(".register-card").getBoundingClientRect().width)'), 760);
      for (const [left, right] of [['#register-name', '#register-organization-type'], ['#register-state', '#register-city'], ['#register-password', '#register-confirm-password']]) {
        const positions = await browser.evaluate('(() => { const a = document.querySelector(' + JSON.stringify(left) + ').getBoundingClientRect(); const b = document.querySelector(' + JSON.stringify(right) + ').getBoundingClientRect(); return { ay:a.y, by:b.y, ax:a.x, bx:b.x, aw:a.width, bw:b.width }; })()');
        assert.ok(Math.abs(positions.ay - positions.by) <= 1, 'Paired field controls share the same row');
        assert.ok(positions.bx > positions.ax);
        assert.ok(Math.abs(positions.aw - positions.bw) <= 1);
      }
      await screenshot('organization-desktop');
    });
    for (const [field, entry, message] of [
      ['#register-phone', '12345', '10 to 15 phone digits'],
      ['#register-email', 'memory@invalid', 'valid email address'],
      ['#register-password', 'short', 'at least 8 characters'],
      ['#register-confirm-password', 'different-value', 'must match'],
      ['#register-address', '', 'organization type, address and email'],
    ]) {
      await suite.test('organization registration validates ' + field.slice(1) + ' before posting', async () => {
        await open('/register?type=organization');
        await fillOrganization({ [field]: entry });
        const before = browser.apiCalls.length;
        await browser.click('.register-submit');
        await waitText('.register-error', message);
        assert.equal(browser.apiCalls.length, before);
      });
    }
    for (const type of ['Hospital', 'Blood Bank', 'NGO']) {
      await suite.test(type + ' registration submits only organization fields and safely displays success', async () => {
        await open('/register?type=organization');
        await fillOrganization({ '#register-organization-type': type });
        const before = browser.apiCalls.length;
        await browser.click('.register-submit');
        await waitText('.register-success', 'organization account was registered successfully');
        const calls = browser.apiCalls.slice(before);
        assert.equal(calls.length, 1);
        assert.equal(new URL(calls[0].url).pathname, '/api/organizations');
        const payload = JSON.parse(calls[0].postData);
        assert.equal(payload.organization_type, type);
        assert.deepEqual(Object.keys(payload).sort(), ['address', 'city', 'email', 'name', 'organization_type', 'password', 'phone', 'state']);
        assert.equal(await value('#register-password'), '');
        assert.equal(await value('#register-confirm-password'), '');
        assert.equal(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'), null);
        assert.ok(!(await text('body')).includes(privateMarker));
      });
    }
    await suite.test('organization registration loading prevents duplicate requests and disables account fields', async () => {
      await open('/register?type=organization', { registrationDelay: 450 });
      await fillOrganization();
      const before = browser.apiCalls.length;
      await browser.click('.register-submit');
      await waitText('.register-submit', 'Registering...');
      assert.equal(await browser.evaluate('document.querySelector(".register-submit").disabled'), true);
      assert.equal(await browser.evaluate('document.querySelector("#register-type").disabled'), true);
      assert.equal(await browser.evaluate('document.querySelector("#register-phone").matches(":disabled")'), true);
      await browser.evaluate('document.querySelector(".register-form").requestSubmit()');
      await waitText('.register-success', 'registered successfully');
      assert.equal(browser.apiCalls.slice(before).length, 1);
    });
    for (const [status, message] of [[400, 'registration details are invalid'], [409, 'conflict with an existing record'], [500, 'server could not complete'], ['network', 'Unable to reach the backend']]) {
      await suite.test('organization registration handles ' + status + ' without exposing server details', async () => {
        await open('/register?type=organization', status === 'network' ? { registrationNetwork: true } : { registrationStatus: status });
        await fillOrganization();
        await browser.click('.register-submit');
        await waitText('.register-error', message);
        assert.ok(!(await text('body')).includes(privateMarker));
        assert.equal(await value('#register-password'), '');
        assert.equal(await value('#register-confirm-password'), '');
        assert.equal(await browser.evaluate('document.querySelector(".register-submit").disabled'), false);
      });
    }
    await suite.test('footer renders once with requested identity content and no invented contact links', async () => {
      await open('/login');
      assert.equal(await browser.evaluate('document.querySelectorAll("footer.lifesaver-footer").length'), 1);
      const footer = await text('.lifesaver-footer');
      for (const expected of ['LifeSaver', 'Blood Donation Management System',
        'Connecting eligible donors, recipients, hospitals and blood banks for faster and safer blood coordination.',
        'Platform', 'For Users', '© 2026 LifeSaver. All rights reserved.']) assert.ok(footer.includes(expected));
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelector("#footer-platform-title").parentElement.querySelectorAll("a"), anchor => [anchor.textContent, anchor.getAttribute("href")])'),
        [['Home', '/'], ['How It Works', '/#how-it-works'], ['Login', '/login'], ['Register', '/register']]);
      assert.deepEqual(await browser.evaluate('Array.from(document.querySelector("#footer-users-title").parentElement.querySelectorAll("a"), anchor => [anchor.textContent, anchor.getAttribute("href")])'),
        [['Donors', '/register?type=donor'], ['Recipients', '/register?type=recipient'], ['Organizations', '/register?type=organization']]);
      assert.equal(await browser.evaluate('Array.from(document.querySelectorAll(".lifesaver-footer a")).filter(anchor => /^(tel:|mailto:|http)/.test(anchor.getAttribute("href"))).length'), 0);
    });
    await suite.test('footer How It Works from Login navigates and focuses the real Home section', async () => {
      await open('/login');
      await browser.click('.lifesaver-footer a[href="/#how-it-works"]');
      await browser.wait('location.pathname === "/" && location.hash === "#how-it-works"');
      await browser.wait('document.activeElement?.id === "how-it-works"');
      assert.equal(await browser.evaluate('document.querySelectorAll("footer.lifesaver-footer").length'), 1);
      await browser.click('.lifesaver-footer a[href="/login"]');
      await browser.wait('Boolean(document.querySelector(".login-card"))');
      await browser.click('.lifesaver-footer a[href="/register"]');
      await browser.wait('Boolean(document.querySelector(".register-card"))');
    });
    await suite.test('footer role links select the correct forms including query changes on the same page', async () => {
      await open('/register');
      for (const role of ['organization', 'recipient', 'donor', 'organization']) {
        await input('#register-name', 'Previous form name');
        await input('#register-password', memoryPassword);
        await browser.click('.lifesaver-footer a[href="/register?type=' + role + '"]');
        await browser.wait('document.querySelector("#register-type")?.value === ' + JSON.stringify(role));
        assert.equal(await value('#register-name'), '');
        assert.equal(await value('#register-password'), '');
        assert.equal(await exists('#register-organization-type'), role === 'organization');
        assert.equal(await exists('#register-age'), role === 'recipient');
        assert.equal(await exists('#register-date-of-birth'), role === 'donor');
      }
    });
    await suite.test('footer role links restore the requested role after manual override even when query role is unchanged', async () => {
      await open('/register');
      await input('#register-type', 'recipient');
      await browser.click('.lifesaver-footer a[href="/register?type=donor"]');
      await browser.wait('document.querySelector("#register-type")?.value === "donor"');
      assert.equal(await exists('#register-date-of-birth'), true);
      assert.equal(await exists('#register-age'), false);
      await open('/register?type=organization');
      await input('#register-type', 'recipient');
      await browser.click('.lifesaver-footer a[href="/register?type=organization"]');
      await browser.wait('document.querySelector("#register-type")?.value === "organization"');
      assert.equal(await exists('#register-organization-type'), true);
      assert.equal(await exists('#register-age'), false);
    });
    for (const [destination, oldStatus] of [['recipient', 201], ['recipient', 409], ['organization', 201]]) {
      await suite.test('late registration ' + oldStatus + ' cannot replace a newer ' + destination + ' footer form', async () => {
        await open('/register?type=organization', { registrationDelay: 600, registrationStatus: oldStatus });
        await fillOrganization();
        await browser.click('.register-submit');
        await waitText('.register-submit', 'Registering...');
        if (destination === 'organization') {
          await browser.click('.lifesaver-footer a[href="/register?type=recipient"]');
          await browser.wait('document.querySelector("#register-type")?.value === "recipient"');
        }
        await browser.click('.lifesaver-footer a[href="/register?type=' + destination + '"]');
        await browser.wait('document.querySelector("#register-type")?.value === ' + JSON.stringify(destination));
        await input('#register-name', 'New form remains');
        await input('#register-password', 'New memory value');
        await pause(850);
        assert.equal(await value('#register-type'), destination);
        assert.equal(await value('#register-name'), 'New form remains');
        assert.equal(await value('#register-password'), 'New memory value');
        assert.equal(await exists('.register-success'), false);
        assert.equal(await exists('.register-error'), false);
        assert.equal(await browser.evaluate('document.querySelector(".register-submit").disabled'), false);
      });
    }
    for (const width of [320, 390, 1440]) {
      await suite.test('login organization registration and footer fit a ' + width + 'px viewport', async () => {
        await viewport(width);
        for (const [route, label] of [['/login', 'login'], ['/register?type=organization', 'organization']]) {
          await open(route);
          assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true);
          assert.equal(await browser.evaluate('document.querySelectorAll("footer.lifesaver-footer").length'), 1);
          const button = label === 'login' ? '.login-submit' : '.register-submit';
          assert.equal(await browser.evaluate('document.querySelector(' + JSON.stringify(button) + ').getBoundingClientRect().height >= 44'), true);
          if (label === 'organization' && width < 600) {
            assert.equal(await browser.evaluate('document.querySelector("#register-name").getBoundingClientRect().y < document.querySelector("#register-organization-type").getBoundingClientRect().y'), true);
          }
          await screenshot(label + '-' + width);
        }
      });
    }
    await suite.test('forms and footer have no uncaught browser or mocked API errors', async () => {
      await pause(100);
      assert.deepEqual(browser.browserErrors, []);
      assert.deepEqual(browser.failures, []);
    });
  } finally {
    await browser.close();
  }
});
