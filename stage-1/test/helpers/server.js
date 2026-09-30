'use strict';

/**
 * Test helper: boots an isolated PhantomPay app (fresh engine + server) on an
 * ephemeral port and returns a tiny client. Every spawn is independent, so
 * tests never contaminate each other's ledger state.
 */

const { createApp, seedDemoData } = require('../../server');

async function spawnServer({ seed = true } = {}) {
  const app = createApp();
  if (seed) seedDemoData(app.engine);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  async function raw(path, { method = 'GET', body, headers = {} } = {}) {
    return fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  }

  async function json(path, options) {
    const res = await raw(path, options);
    const payload = await res.json();
    return { status: res.status, headers: res.headers, body: payload };
  }

  async function text(path) {
    const res = await raw(path);
    return res.text();
  }

  async function close() {
    await new Promise((resolve) => app.server.close(resolve));
  }

  return { base, app, engine: app.engine, raw, json, text, close };
}

module.exports = { spawnServer };
