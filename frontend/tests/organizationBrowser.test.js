import { providerQueueFixture } from './helpers/providerQueueFixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { authFixture, pause, startBrowser, storageKey } from './helpers/recipientBrowser.js';

const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
test('organization accounts, role boundaries and location completion in Chrome with in-memory APIs', {
  timeout: 180000, skip: !fs.existsSync(chromePath) && 'Set CHROME_PATH to run browser checks.',
}, async suite => {
  const browser = await startBrowser(chromePath);
  const baseProfile = { user_id: 11, user_type: 'organization', organization_id: 11,
    organization_type: 'NGO', name: 'Temporary fixture NGO', state: 'Uttar Pradesh', city: 'Ghaziabad',
    address: 'Fixture address', phone: '9876543210', email: 'fixture@example.test', bank_id: null };
  let state;
  function reset(overrides = {}) {
    state = { profile: { ...baseProfile }, profileStatus: 200, profileDelay: 0, ...overrides };
  }
  browser.mock(async (request, url) => {
    if (url.pathname === '/api/organizations' && request.method === 'POST') {
      const body = JSON.parse(request.postData);
      assert.deepEqual(Object.keys(body).sort(), ['address', 'city', 'email', 'name', 'organization_type', 'password', 'phone', 'state']);
      assert.ok(['Hospital', 'Blood Bank', 'NGO'].includes(body.organization_type));
      assert.equal(body.state, 'Uttar Pradesh'); assert.equal(body.city, 'Ghaziabad City');
      assert.equal(body.name, 'Temporary fixture organization');
      return { status: 201, body: { organization: { organization_id: 100, ...body, password_hash: 'Private hash' } } };
    }
    if (url.pathname === '/api/donors' && request.method === 'POST') {
      const body = JSON.parse(request.postData);
      assert.equal(body.state, 'Uttar Pradesh'); assert.equal(body.city, 'Ghaziabad');
      assert.equal(body.location, 'Fixture area');
      assert.equal(body.is_available, true);
      return { status: 201, body: { donor_id: 16 } };
    }
    if (/^\/api\/auth\/(donor|recipient|organization)\/login$/.test(url.pathname)) {
      const role = url.pathname.split('/')[3];
      const body = JSON.parse(request.postData);
      assert.deepEqual(Object.keys(body).sort(), ['identifier', 'password']);
      assert.ok(['9876543210', 'fixture@example.test'].includes(body.identifier));
      const fixture = authFixture(role, role === 'organization' ? 11 : 16);
      return { body: { token: fixture.token, ...(role === 'organization'
        ? { user: { ...baseProfile, password_hash: 'Private hash' } }
        : { [role]: { [role + '_id']: 16, name: 'Fixture person', password_hash: 'Private hash' } }) } };
    }
    const authorization = request.headers.Authorization || request.headers.authorization;
    assert.ok(authorization?.startsWith('Bearer '));
    const identity = JSON.parse(Buffer.from(authorization.slice(7).split('.')[1], 'base64url').toString());
    if (url.pathname === '/api/auth/me') {
      const snapshot = { ...state.profile };
      if (state.profileDelay) await pause(state.profileDelay);
      if (identity.user_type === 'organization' || identity.user_type === 'blood_bank') {
        return { status: state.profileStatus, body: state.profileStatus === 200
          ? { ...snapshot, password_hash: 'Private hash' } : { message: 'Private SQL' } };
      }
      return { body: { user_id: identity.user_id, user_type: identity.user_type, name: 'Fixture person',
        blood_group: 'A+', location: 'Ghaziabad', state: 'Uttar Pradesh', city: 'Ghaziabad', is_available: 1 } };
    }
    if (url.pathname === '/api/organizations/me/location') {
      assert.equal(request.method, 'put'.toUpperCase());
      const body = JSON.parse(request.postData);
      assert.deepEqual(Object.keys(body).sort(), ['city', 'state']);
      state.profile = { ...state.profile, ...body };
      return { body: { message: 'Saved', organization: { ...state.profile, user_id: undefined, user_type: undefined } } };
    }
    if (url.pathname.startsWith('/api/inventory/')) {
      assert.equal(url.pathname, '/api/inventory/3');
      assert.ok(['organization', 'blood_bank'].includes(identity.user_type));
      return { body: { bank_id: 3, inventory: [] } };
    }
    if (url.pathname === '/api/requests/provider-queue') return { body: providerQueueFixture([], {
      bankId: state.profile.bank_id || 3, organizationId: identity.user_type === 'organization' ? identity.user_id : null }) };
    if (url.pathname === '/api/requests') return { body: { requests: [] } };
    if (url.pathname === '/api/donors/me/matching-requests') return { body: { requests: [] } };
    if (url.pathname.startsWith('/api/notifications/donor/')) return { body: { user_id: identity.user_id, user_type: 'donor', notifications: [] } };
    throw new Error('Unexpected fixture endpoint: ' + request.method + ' ' + url.pathname);
  });
  const text = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent || ""');
  const waitText = (selector, value) => browser.wait('(document.querySelector(' + JSON.stringify(selector) + ')?.textContent || "").includes(' + JSON.stringify(value) + ')');
  async function textarea(selector, value) {
    await browser.evaluate('(() => { const node=document.querySelector(' + JSON.stringify(selector)
      + ');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(node,' + JSON.stringify(value)
      + ');node.dispatchEvent(new Event("input",{bubbles:true})); })()');
  }
  async function registerCommon() {
    await browser.input('#register-name', 'Temporary fixture organization');
    await browser.input('#register-phone', '9876543210');
    await browser.input('#register-email', 'fixture@example.test');
    await browser.input('#register-password', 'Fixture-password');
    await browser.input('#register-confirm-password', 'Fixture-password');
  }
  try {
    await suite.test('organization route rejects unauthenticated, donor and recipient identities before APIs', async () => {
      reset();
      for (const session of [null, authFixture('donor', 16), authFixture('recipient', 16)]) {
        const before = browser.apiCalls.length;
        await browser.seed(session, '/organization/dashboard');
        await browser.wait('location.pathname === "/login"');
        assert.equal(browser.apiCalls.length, before);
      }
    });
    await suite.test('registers each organization type with genuine entered location and no patient fields', async () => {
      for (const type of ['Hospital', 'Blood Bank', 'NGO']) {
        reset(); await browser.seed(null, '/register');
        await browser.wait('Boolean(document.querySelector("#register-type"))');
        await browser.input('#register-type', 'organization');
        await registerCommon();
        await browser.input('#register-organization-type', type);
        await textarea('#register-address', 'Fixture address');
        assert.equal(await browser.evaluate('Boolean(document.querySelector("#register-gender"))'), false);
        assert.equal(await browser.evaluate('document.querySelector("#register-city").disabled'), true);
        assert.equal(await browser.evaluate('document.querySelector("#register-state").options.length'), 37);
        await browser.input('#register-state', 'Uttar Pradesh');
        await browser.input('#register-city', ' Ghaziabad   City ');
        await browser.click('.register-submit');
        await waitText('.register-success', 'registered successfully');
        assert.equal(await browser.evaluate('document.querySelector("#register-password").value'), '');
        assert.ok(!(await text('.register-card')).includes('Private hash'));
        assert.equal(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'), null);
      }
    });
    await suite.test('donor registration carries canonical state/city and preserves optional locality', async () => {
      reset(); await browser.seed(null, '/register');
      await browser.wait('Boolean(document.querySelector("#register-type"))');
      await registerCommon();
      await browser.input('#register-gender', 'Other');
      await browser.input('#register-blood-group', 'A+');
      await browser.input('#register-date-of-birth', '2000-01-01');
      await browser.input('#register-state', 'Uttar Pradesh');
      await browser.input('#register-city', 'Ghaziabad');
      await browser.input('#register-location', 'Fixture area');
      await browser.click('.register-submit');
      await waitText('.register-success', 'registered successfully');
    });
    await suite.test('donor, recipient and organization login accept both identifiers and store minimal identity', async () => {
      for (const role of ['donor', 'recipient', 'organization']) {
        for (const identifier of ['9876543210', 'fixture@example.test']) {
          reset(); await browser.seed(null, '/login');
          await browser.wait('Boolean(document.querySelector("#login-type"))');
          await browser.input('#login-type', role);
          await browser.input(role === 'organization' ? '#login-identifier' : '#login-phone', identifier);
          await browser.input('#login-password', 'Fixture-password');
          await browser.click('.login-submit');
          await browser.wait('location.pathname === ' + JSON.stringify('/' + role + '/dashboard'));
          const saved = JSON.parse(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'));
          assert.deepEqual(Object.keys(saved.user).sort(), ['user_id', 'user_type']);
          assert.equal(saved.user.user_type, role);
          assert.ok(!JSON.stringify(saved).includes('Private'));
        }
      }
    });
    await suite.test('NGO dashboard exposes profile only and never requests clinical inventory', async () => {
      reset(); const before = browser.apiCalls.length;
      await browser.seed(authFixture('organization', 11), '/organization/dashboard');
      await waitText('.organization-page', baseProfile.name);
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-dashboard"))'), false);
      assert.ok(!browser.apiCalls.slice(before).some(call => /\/api\/(inventory|allocations)/.test(call.url)));
      assert.ok(!(await text('.organization-page')).includes('Private hash'));
      assert.equal(await browser.evaluate('document.querySelectorAll("footer.lifesaver-footer").length'), 1);
    });
    await suite.test('blood bank organization dashboard uses linked bank ID and original organization token', async () => {
      reset({ profile: { ...baseProfile, organization_type: 'Blood Bank', bank_id: 3 } });
      await browser.seed(authFixture('organization', 11), '/organization/dashboard');
      await browser.wait('Boolean(document.querySelector(".bank-dashboard"))');
      await waitText('.bank-profile', baseProfile.name);
      await browser.wait('document.querySelectorAll(".bank-stock-card").length === 8');
      const call = browser.apiCalls.findLast(call => new URL(call.url).pathname === '/api/inventory/3');
      const header = call.headers.Authorization || call.headers.authorization;
      const token = JSON.parse(Buffer.from(header.slice(7).split('.')[1], 'base64url').toString());
      assert.equal(token.user_id, 11); assert.equal(token.user_type, 'organization');
    });
    await suite.test('legacy bank completes real location while retaining bank JWT and existing dashboard route', async () => {
      reset({ profile: { ...baseProfile, user_id: 3, user_type: 'blood_bank', bank_name: 'Fixture legacy bank',
        organization_type: 'Blood Bank', bank_id: 3, state: null, city: null } });
      await browser.seed(authFixture('blood_bank', 3), '/organization/dashboard');
      await waitText('.organization-page', 'Complete your organization location');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-dashboard"))'), false);
      await browser.input('#organization-state', 'Uttar Pradesh');
      await browser.input('#organization-city', ' Ghaziabad ');
      await browser.click('.organization-location-form button[type="submit"]');
      await browser.wait('Boolean(document.querySelector(".bank-dashboard"))');
      await waitText('.organization-location', 'Ghaziabad, Uttar Pradesh');
      const saved = JSON.parse(await browser.evaluate('localStorage.getItem(' + JSON.stringify(storageKey) + ')'));
      assert.equal(saved.user.user_id, 3); assert.equal(saved.user.user_type, 'blood_bank');
      assert.equal(await browser.evaluate('Boolean(document.querySelector(".site-navigation a[href=\\"/blood-bank/dashboard\\"]"))'), true);
    });
    await suite.test('organization load errors stay safe and account changes clear previous personal data', async () => {
      reset({ profileStatus: 500 });
      await browser.seed(authFixture('organization', 11), '/organization/dashboard');
      await waitText('.organization-error', 'server could not');
      assert.ok(!(await text('.organization-page')).includes('Private SQL'));
      reset();
      await browser.click('.organization-card .organization-button');
      await waitText('.organization-page', baseProfile.name);
      state.profile = { ...baseProfile, user_id: 12, organization_id: 12, name: 'Next fixture NGO' };
      const next = JSON.stringify(authFixture('organization', 12));
      await browser.evaluate('localStorage.setItem(' + JSON.stringify(storageKey) + ',' + JSON.stringify(next)
        + ');window.dispatchEvent(new StorageEvent("storage",{key:' + JSON.stringify(storageKey) + '}));');
      await waitText('.organization-page', 'Next fixture NGO');
      assert.ok(!(await text('.organization-page')).includes(baseProfile.name));
    });
    await suite.test('shared footer appears once and mobile account form has no horizontal overflow', async () => {
      reset(); await browser.seed(null, '/');
      assert.equal(await browser.evaluate('document.querySelectorAll("footer").length'), 1);
      assert.equal(await browser.evaluate('document.querySelectorAll("footer nav").length'), 0);
      await browser.navigate('/register');
      await browser.wait('Boolean(document.querySelector("#register-type"))');
      await browser.input('#register-type', 'organization');
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
    });
    assert.deepEqual(browser.browserErrors, []);
    assert.deepEqual(browser.failures, []);
  } finally { await browser.close(); }
});
