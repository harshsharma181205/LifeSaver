import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'vite';

export const storageKey = 'lifesaver_auth';
const secret = randomBytes(32);
export function authFixture(role = 'recipient', id = 16, expires = Math.floor(Date.now() / 1000) + 3600) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode({ user_id: id, user_type: role, exp: expires });
  const signature = createHmac('sha256', secret).update(header + '.' + payload).digest('base64url');
  return { token: header + '.' + payload + '.' + signature, user: { user_id: id, user_type: role } };
}
export const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function until(callback, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await callback()) return;
    await pause(30);
  }
  throw new Error('Timed out: ' + message);
}
async function connect(url) {
  const ws = new WebSocket(url);
  await once(ws, 'open');
  let nextId = 0;
  const pending = new Map();
  const handlers = new Map();
  const failures = [];
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.id) {
      const job = pending.get(message.id);
      if (!job) return;
      clearTimeout(job.timer);
      pending.delete(message.id);
      message.error ? job.reject(new Error(message.error.message)) : job.resolve(message.result);
    } else {
      for (const handler of handlers.get(message.method) || []) {
        Promise.resolve().then(() => handler(message.params)).catch(error => failures.push(error.message));
      }
    }
  });
  ws.addEventListener('close', () => {
    for (const job of pending.values()) { clearTimeout(job.timer); job.reject(new Error('Browser connection closed')); }
    pending.clear();
  });
  return {
    failures, ws,
    on(method, handler) {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(handler);
    },
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Browser command timeout: ' + method)); }, 10000);
        pending.set(id, { resolve, reject, timer });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
  };
}

export async function startBrowser(chromePath) {
  const root = path.resolve(import.meta.dirname, '../..');
  const cache = path.join(root, 'node_modules/.cache');
  fs.mkdirSync(cache, { recursive: true });
  const profile = fs.mkdtempSync(path.join(cache, 'recipient-browser-'));
  let vite, chrome, cdp;
  async function close() {
    if (cdp) {
      try { await cdp.send('Browser.close'); } catch {}
      cdp.ws.close();
    }
    if (chrome && chrome.exitCode === null) {
      await Promise.race([once(chrome, 'exit'), pause(2000)]);
      if (chrome.exitCode === null) chrome.kill();
    }
    if (vite) await vite.close();
    // Sirf apni verified test profile delete hogi.
    if (path.resolve(profile).startsWith(path.resolve(cache) + path.sep)) {
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  }
  try {
    vite = await createServer({ root, server: { host: '127.0.0.1', port: 0 }, logLevel: 'silent' });
    await vite.listen();
    const origin = 'http://127.0.0.1:' + vite.httpServer.address().port;
    chrome = spawn(chromePath, [
      '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-sync',
      '--disable-extensions', '--disable-component-update', '--no-first-run', '--no-default-browser-check',
      '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank',
    ], { stdio: 'ignore', windowsHide: true });
    chrome.on('error', () => {});
    const portFile = path.join(profile, 'DevToolsActivePort');
    await until(() => fs.existsSync(portFile), 'Chrome startup');
    const port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    cdp = await connect(pages.find(page => page.type === 'page').webSocketDebuggerUrl);
    const apiCalls = [], browserErrors = [], cancelled = new Set();
    let handler = async () => { throw new Error('API fixture not configured'); };
    let workflowOptions = {}; 
    let loads = 0;
    cdp.on('Page.loadEventFired', () => { loads += 1; });
    cdp.on('Runtime.exceptionThrown', event => {
      browserErrors.push(event.exceptionDetails.exception?.description || event.exceptionDetails.text);
    });
    cdp.on('Network.loadingFailed', event => { if (event.canceled) cancelled.add(event.requestId); });
    // Navigation/abort can remove a paused request before CDP resumes it.
    async function sendPaused(method, parameters) {
      try { return await cdp.send(method, parameters); } catch (error) {
        if (error.message !== 'Invalid InterceptionId.') throw error;
      }
    }
    cdp.on('Fetch.requestPaused', async (event) => {
      const { requestId, request } = event;
      const url = new URL(request.url);
      if (url.origin === origin) {
        await sendPaused('Fetch.continueRequest', { requestId });
        return;
      }
      if (url.origin !== 'http://localhost:5000') {
        await sendPaused('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
        return;
      }
      const headers = [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'Access-Control-Allow-Origin', value: origin },
        { name: 'Access-Control-Allow-Headers', value: 'Authorization, Content-Type' },
        { name: 'Access-Control-Allow-Methods', value: 'GET, POST, PUT, PATCH, OPTIONS' },
      ];
      try {
        if (request.method === 'OPTIONS') {
          await sendPaused('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: headers });
          return;
        }
        const isWorkflowConfig = request.method === 'GET' && url.pathname === '/api/requests/workflow-config';
        if (!isWorkflowConfig) apiCalls.push(request);
        const result = isWorkflowConfig ? { status: workflowOptions.status || 200, body: { workflow_v2_enabled: workflowOptions.enabled === true } } : await handler(request, url);
        if (result.networkError) {
          await sendPaused('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' });
        } else {
          await sendPaused('Fetch.fulfillRequest', {
            requestId, responseCode: result.status || 200, responseHeaders: headers,
            body: Buffer.from(JSON.stringify(result.body)).toString('base64'),
          });
        }
      } catch (error) {
        if (!cancelled.has(event.networkId)) throw error;
      }
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    async function evaluate(expression) {
      const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result?.value;
    }
    async function navigate(route) {
      const count = loads;
      await cdp.send('Page.navigate', { url: origin + route });
      await until(() => loads > count, 'page load');
    }
    async function seed(session, route = '/recipient/dashboard') {
      await navigate('/');
      await evaluate('localStorage.clear();' + (session ? 'localStorage.setItem(' + JSON.stringify(storageKey) + ',' + JSON.stringify(JSON.stringify(session)) + ')' : ''));
      await navigate(route);
    }
    async function input(selector, value) {
      await evaluate('(() => {const node=document.querySelector(' + JSON.stringify(selector) + ');const proto=node.tagName==="SELECT"?HTMLSelectElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,"value").set.call(node,' + JSON.stringify(value) + ');node.dispatchEvent(new Event(node.tagName==="SELECT"?"change":"input",{bubbles:true}));})()');
    }
    return {
      origin, apiCalls, browserErrors, failures: cdp.failures, cdp, evaluate, seed, navigate, input, close,
      mock(fn, options = {}) { handler = fn; workflowOptions = options; },
      wait(expression, message = expression) { return until(() => evaluate(expression), message); },
      click(selector) { return evaluate('document.querySelector(' + JSON.stringify(selector) + ').click()'); },
    };
  } catch (error) { await close(); throw error; }
}
