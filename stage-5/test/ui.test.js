'use strict';

/**
 * UI contract: `/` serves the command-center shell, static assets carry the
 * right content types, path traversal is refused, and the built-in app.js
 * references the endpoints it must consume.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../server');

let baseUrl = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function get(path) {
  const res = await fetch(`${baseUrl}${path}`);
  const body = await res.text();
  return { status: res.status, type: res.headers.get('content-type') || '', body };
}

test('index serves the command center shell', async () => {
  const page = await get('/');
  assert.equal(page.status, 200);
  assert.equal(page.type, 'text/html; charset=utf-8');
  assert.ok(page.body.includes('PhantomPay'));
  assert.ok(page.body.includes('/ui/app.js'));
  assert.ok(page.body.includes('/ui/ui.css'));
});

test('static assets carry correct content types', async () => {
  const css = await get('/ui/ui.css');
  assert.equal(css.status, 200);
  assert.equal(css.type, 'text/css; charset=utf-8');
  assert.ok(css.body.includes('--accent'));

  const js = await get('/ui/app.js');
  assert.equal(js.status, 200);
  assert.equal(js.type, 'text/javascript; charset=utf-8');

  const svg = await get('/ui/favicon.svg');
  assert.equal(svg.status, 200);
  assert.equal(svg.type, 'image/svg+xml');
});

test('path traversal is refused', async () => {
  const evil = await get('/ui/..%2F..%2Fserver.js');
  assert.equal(evil.status, 404);
});

test('app.js references the fusion endpoints', async () => {
  const js = await get('/ui/app.js');
  for (const marker of ['/stream', '/safety/faults', '/safety/recovery', '/bus/fault', '/uds', '/verify', '/lint', '/telemetry']) {
    assert.ok(js.body.includes(marker), `app.js must reference ${marker}`);
  }
});

test('index.html wires the six command-center tabs', async () => {
  const page = await get('/');
  for (const id of ['tab-overview', 'tab-bus', 'tab-ledger', 'tab-payments', 'tab-telemetry', 'tab-audit']) {
    assert.ok(page.body.includes(id), `missing tab panel ${id}`);
  }
  assert.ok(page.body.includes('demo-run'));
  assert.ok(page.body.includes('safety-chip'));
  assert.ok(page.body.includes('audio-toggle'));
});
