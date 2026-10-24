import assert from 'node:assert/strict';
import { startBrowser, pause } from '../../../frontend/tests/helpers/recipientBrowser.js';

// The caller owns temporary account generation and database cleanup.
// Every business response below comes from the real Express/MySQL application.
export async function runLiveFrontend(base, accounts) {
  const browser = await startBrowser(process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe');
  const registered = {};
  let requestId = null;
  let lastMatch = null;
  let lastScreening = null;
  let lastDonation = null;
  let lastAllocation = null;
  let lastDonorMatches = null;
  const group = accounts.donor.blood_group || accounts.recipient.blood_group || 'A+';
  const orgKeys = ['hospital', 'bank'];
  const profileFields = ['organization_id', 'organization_type', 'name', 'state', 'city', 'address', 'phone', 'email', 'bank_id', 'created_at'];
  function safeProfile(value) {
    return Object.fromEntries(profileFields.filter(field => value[field] !== undefined).map(field => [field, value[field]]));
  }
  browser.mock(async (request, url) => {
    const headers = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (['authorization', 'content-type', 'accept'].includes(name.toLowerCase())) headers[name] = value;
    }
    const response = await fetch(new URL(url.pathname + url.search, base), {
      method: request.method, headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.postData,
      signal: AbortSignal.timeout(20000),
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('Live API returned a non-JSON response.'); }
    if (response.ok && request.method === 'GET' && url.pathname === '/api/donors/me/matching-requests') lastDonorMatches = data;
    if (response.ok && request.method === 'POST') {
      const input = request.postData ? JSON.parse(request.postData) : {};
      if (url.pathname === '/api/organizations' && response.status === 201) {
        const key = orgKeys.find(name => accounts[name].email.toLowerCase() === input.email.toLowerCase());
        if (key) registered[key] = safeProfile(data.organization);
      }
      if (url.pathname === '/api/donors' && response.status === 201 && input.email === accounts.donor.email) registered.donor = { donor_id: data.donor_id };
      if (url.pathname === '/api/recipients' && response.status === 201 && input.email === accounts.recipient.email) registered.recipient = { recipient_id: data.recipient_id };
      if (url.pathname === '/api/requests' && input.recipient_id === registered.recipient?.recipient_id) requestId = data.request_id;
      if (url.pathname === '/api/allocations/match/' + requestId) lastMatch = data;
      if (url.pathname === '/api/screenings/' + requestId) lastScreening = data;
      if (url.pathname === '/api/donations/' + requestId) lastDonation = data;
      if (url.pathname === '/api/allocations/process/' + requestId) lastAllocation = data;
    }
    return { status: response.status, body: data };
  });
  async function input(selector, value) {
    // The established helper's input setter does not handle textarea elements.
    await browser.evaluate('(() => { const node=document.querySelector(' + JSON.stringify(selector) + '); if(!node)throw new Error("Live form input missing"); const proto=node.tagName==="SELECT"?HTMLSelectElement.prototype:node.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto,"value").set.call(node,' + JSON.stringify(String(value)) + '); node.dispatchEvent(new Event(node.tagName==="SELECT"?"change":"input",{bubbles:true})); })()');
  }
  const text = selector => browser.evaluate('document.querySelector(' + JSON.stringify(selector) + ')?.textContent || ""');
  const waitText = (selector, value) => browser.wait('(document.querySelector(' + JSON.stringify(selector) + ')?.textContent || "").includes(' + JSON.stringify(value) + ')');
  const card = (className, id) => 'Array.from(document.querySelectorAll(' + JSON.stringify('.' + className) + ')).find(node=>node.querySelector("h3")?.textContent.trim()===' + JSON.stringify('Request #' + id) + ')';
  async function clickRequest(className, label) {
    await browser.evaluate('(() => { const node=' + card(className, requestId) + '; const button=Array.from(node?.querySelectorAll("button")||[]).find(button=>button.textContent.trim()===' + JSON.stringify(label) + '); if(!button||button.disabled)throw new Error("Live request action unavailable"); button.click(); })()');
  }
  async function checkLayout(label) {
    for (const width of [1440, 390]) {
      await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width < 500 });
      await pause(80);
      assert.ok(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), label + ' overflows its viewport.');
    }
    await browser.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  }
  async function register(key, role) {
    const account = accounts[key];
    await browser.navigate('/register');
    await browser.wait('Boolean(document.querySelector("#register-type"))');
    await input('#register-type', role);
    await input('#register-name', account.name);
    if (role === 'organization') await input('#register-organization-type', account.organization_type || (key === 'bank' ? 'Blood Bank' : 'Hospital'));
    else {
      await input('#register-gender', account.gender || 'Other');
      await input('#register-blood-group', account.blood_group || group);
      await input(role === 'donor' ? '#register-date-of-birth' : '#register-age', role === 'donor' ? account.date_of_birth || '1995-01-01' : account.age || 28);
    }
    await input('#register-phone', account.phone);
    await input('#register-email', account.email);
    if (role !== 'recipient') {
      await input('#register-address', account.address || 'Temporary evaluator test address');
      await input('#register-state', account.state || accounts.bank.state);
      await input('#register-city', account.city || accounts.bank.city);
    }
    await input('#register-password', account.password);
    await input('#register-confirm-password', account.password);
    await checkLayout('Registration');
    await browser.click('.register-submit');
    await waitText('.register-success', 'registered successfully');
    assert.ok(registered[key], 'The live registration did not return its account identity.');
  }
  async function login(key, role, identifier) {
    await browser.navigate('/login');
    await browser.wait('Boolean(document.querySelector("#login-type"))');
    await input('#login-type', role);
    await input(role === 'organization' ? '#login-identifier' : '#login-phone', identifier);
    await input('#login-password', accounts[key].password);
    await browser.click('.login-submit');
    const route = '/' + role + '/dashboard';
    await browser.wait('location.pathname === ' + JSON.stringify(route));
    if (role === 'organization') {
      await waitText('.bank-welcome h1', accounts[key].name);
      await browser.wait('Boolean(document.querySelector(".bank-requests")) && !document.querySelector(".bank-requests .bank-state")');
      if (key === 'hospital') assert.equal(await browser.evaluate('Boolean(document.querySelector(".bank-inventory"))'), false, 'Hospital dashboard exposed stock editing.');
      else await browser.wait('document.querySelectorAll(".bank-stock-card").length === 8');
    } else await waitText(role === 'donor' ? '.donor-welcome-title' : '#recipient-welcome-title', accounts[key].name);
  }
  async function logout(role) {
    await browser.click(role === 'organization' ? '.bank-logout' : role === 'donor' ? '.donor-logout' : '.recipient-logout');
    await browser.wait('location.pathname === "/login"');
  }
  async function requestDetails() {
    await browser.navigate('/recipient/requests/' + requestId);
    await waitText('.request-details-header h1', 'Blood Request #' + requestId);
  }
  function stockCard() {
    return 'Array.from(document.querySelectorAll(".bank-stock-card")).find(node=>node.querySelector("h3")?.textContent===' + JSON.stringify(group) + ')';
  }
  try {
    await register('hospital', 'organization');
    await register('bank', 'organization');
    await register('donor', 'donor');
    await register('recipient', 'recipient');
    assert.ok(Number.isInteger(registered.bank.bank_id) && registered.bank.bank_id > 0, 'The registered bank lacks its operational provider identity.');
    // Both identifier forms are exercised for each account category, through real Login.
    for (const [key, role] of [['hospital', 'organization'], ['bank', 'organization'], ['donor', 'donor'], ['recipient', 'recipient']]) {
      for (const identifier of [accounts[key].phone, accounts[key].email]) {
        await login(key, role, identifier);
        await logout(role);
      }
    }
    await checkLayout('Login');
    await login('recipient', 'recipient', accounts.recipient.phone);
    await browser.click('.recipient-create-button');
    await browser.wait('Boolean(document.querySelector("#request-state"))');
    await input('#request-state', registered.bank.state);
    await browser.wait('Array.from(document.querySelector("#request-city").options).some(option=>option.value===' + JSON.stringify(registered.bank.city) + ')');
    await input('#request-city', registered.bank.city);
    await browser.wait('Array.from(document.querySelector("#request-organization").options).some(option=>option.value===' + JSON.stringify(String(registered.bank.organization_id)) + ')');
    await input('#request-organization', registered.bank.organization_id);
    await input('#request-blood-group', group);
    await input('#request-units', 3);
    await input('#request-urgency', 'Normal');
    await checkLayout('Request creation');
    await browser.click('.create-request-form button[type=submit]');
    await waitText('.create-request-success', 'created successfully');
    assert.ok(Number.isInteger(requestId) && requestId > 0, 'The live request did not return its identity.');
    await requestDetails();
    let content = await text('.request-details-content');
    assert.ok(content.includes('Pending'), 'A new request must remain Pending.');
    assert.ok(!content.includes(accounts.donor.phone) && !content.includes(accounts.donor.email), 'Private donor contact appeared before acceptance.');
    await checkLayout('Recipient request details');
    await browser.navigate('/recipient/dashboard');
    await browser.wait('Boolean(document.querySelector(".recipient-logout"))');
    await logout('recipient');
    await login('bank', 'organization', accounts.bank.email);
    await browser.evaluate('(' + stockCard() + ').querySelector(".bank-edit-stock").click()');
    await input('.bank-units-input', 2);
    await browser.click('.bank-stock-actions .bank-primary');
    await waitText('.bank-notice', 'updated to 2 units');
    await browser.wait('(' + stockCard() + ')?.querySelector(".bank-stock-units strong")?.textContent === "2"');
    await clickRequest('bank-request-card', 'Find matching donors');
    await waitText('.bank-notice', 'eligible donors');
    assert.equal(lastMatch?.allocated_units, 0, 'Matching deducted stock.');
    assert.equal(lastMatch?.status, 'Pending', 'Matching prematurely advanced the request.');
    assert.equal(lastMatch?.fulfilled_units, 0, 'Matching invented fulfilled units.');
    await logout('organization');
    await login('donor', 'donor', accounts.donor.phone);
    await browser.wait('Boolean(' + card('donor-request-item', requestId) + ')');
    content = await browser.evaluate('(' + card('donor-request-item', requestId) + ').textContent');
    assert.ok(!content.includes(accounts.recipient.phone) && !content.includes(accounts.recipient.email), 'Private recipient contact appeared before acceptance.');
    await clickRequest('donor-request-item', 'Accept');
    await browser.wait('Boolean((' + card('donor-request-item', requestId) + ')?.querySelector(".donor-recipient-details"))');
    content = await browser.evaluate('(' + card('donor-request-item', requestId) + ').textContent');
    assert.ok(content.includes('Processing') && content.includes(accounts.recipient.name), 'Acceptance did not show its Processing state and recipient information.');
    assert.ok(content.includes(accounts.recipient.phone), 'Accepted donor cannot view recipient coordination details.');
    await checkLayout('Donor dashboard');
    await logout('donor');
    await login('recipient', 'recipient', accounts.recipient.email);
    await requestDetails();
    await browser.wait('Boolean(document.querySelector(".accepted-donor-list"))');
    content = await text('.accepted-donor-list');
    assert.ok(content.includes(accounts.donor.phone), 'Recipient cannot see accepted donor contact.');
    assert.ok((await text('.request-fulfillment')).includes('0 / 3 units fulfilled'), 'Acceptance invented fulfilled units.');
    await browser.navigate('/recipient/dashboard');
    await browser.wait('Boolean(document.querySelector(".recipient-logout"))');
    await logout('recipient');
    await login('bank', 'organization', accounts.bank.phone);
    await clickRequest('bank-request-card', 'Screening passed');
    await waitText('.bank-notice', 'screening passed');
    assert.equal(lastScreening?.screening_result, 'Passed');
    await browser.wait('Boolean(document.querySelector(".bank-donation-form"))');
    content = await browser.evaluate('(' + card('bank-request-card', requestId) + ').textContent');
    assert.ok(content.includes('Processing'), 'Passed screening prematurely fulfilled the request.');
    assert.ok(content.includes('Inventory: 0 units') && content.includes('Donation: 0 units'), 'Passed screening invented allocation units.');
    // User-required order: a real donor donation first, then bank inventory.
    await input('#donation-units-' + requestId + '-' + registered.donor.donor_id, 1);
    await browser.click('.bank-donation-form button[type=submit]');
    await waitText('.bank-notice', 'Actual donation recorded');
    assert.equal(lastDonation?.fulfilled_units, 1); assert.equal(lastDonation?.remaining_units, 2); assert.equal(lastDonation?.status, 'Processing');
    await browser.wait('(' + stockCard() + ')?.querySelector(".bank-stock-units strong")?.textContent === "2"');
    await clickRequest('bank-request-card', 'Allocate available stock');
    await waitText('.bank-notice', '3/3 fulfilled');
    assert.equal(lastAllocation?.inventory_units, 2); assert.equal(lastAllocation?.donation_units, 1);
    assert.equal(lastAllocation?.remaining_units, 0); assert.equal(lastAllocation?.status, 'Fulfilled');
    await browser.wait('(' + stockCard() + ')?.querySelector(".bank-stock-units strong")?.textContent === "0"');
    await checkLayout('Blood bank dashboard');
    await logout('organization');
    await login('recipient', 'recipient', accounts.recipient.email);
    await requestDetails();
    await waitText('.request-fulfillment', '3 / 3 units fulfilled');
    content = await text('.request-fulfillment');
    assert.ok(content.includes('Inventory: 2 units') && content.includes('Donation: 1 units'), 'Final recipient view lacks its actual source totals.');
    assert.ok((await text('.request-details-content')).includes('Fulfilled'), 'Final recipient request is not Fulfilled.');
    await checkLayout('Fulfilled recipient details');
    await browser.navigate('/recipient/dashboard');
    await browser.wait('Boolean(document.querySelector(".recipient-logout"))');
    await logout('recipient');
    lastDonorMatches = null;
    await login('donor', 'donor', accounts.donor.email);
    await browser.wait('Boolean(' + card('donor-request-item', requestId) + ')');
    const reopened = lastDonorMatches?.requests.find(request => request.request_id === requestId);
    assert.ok(reopened, 'The accepted request disappeared after reopening the donor dashboard.');
    assert.equal(reopened.status, 'Fulfilled');
    assert.deepEqual([reopened.fulfilled_units, reopened.remaining_units, reopened.inventory_units, reopened.donation_units], [3, 0, 2, 1], 'Reopened donor dashboard lost its numeric fulfillment source totals.');
    assert.equal(reopened.history_available, true, 'Actual source history was reported unavailable.');
    assert.equal(reopened.recipient?.phone, accounts.recipient.phone, 'Recipient coordination details were lost after accepted donor login.');
    assert.equal(reopened.recipient?.email, accounts.recipient.email);
    content = await browser.evaluate('(' + card('donor-request-item', requestId) + ').textContent');
    assert.ok(content.includes('Fulfilled'), 'Reopened donor request is not shown as Fulfilled.');
    assert.ok(content.includes('Inventory: 2 units') && content.includes('Donation: 1 units'), 'Reopened donor request does not show actual source totals.');
    assert.ok(content.includes(accounts.recipient.name) && content.includes(accounts.recipient.phone), 'Accepted donor coordination information is missing after reopening.');
    assert.equal(await browser.evaluate('Boolean((' + card('donor-request-item', requestId) + ')?.querySelector(".donor-response-actions"))'), false, 'A fulfilled accepted request still exposes acceptance actions.');
    await checkLayout('Reopened fulfilled donor dashboard');
    await pause(100);
    assert.equal(browser.browserErrors.length, 0, 'Uncaught browser JavaScript error during the live journey.');
    assert.equal(browser.failures.length, 0, 'The live browser proxy or UI journey failed.');
    return { hospital: registered.hospital, bank: registered.bank, donor: registered.donor,
      recipient: registered.recipient, request_id: requestId };
  } finally { await browser.close(); }
}
