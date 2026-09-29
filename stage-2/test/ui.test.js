'use strict';

/**
 * Web UI end-to-end tests: the single-page shell, its static assets, and
 * path-traversal protection on the static handler.
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

test('the root serves the single-page shell', async () => {
  const res = await fetch(baseUrl);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.ok(html.includes('PhantomPay'));
  assert.ok(html.includes('/ui/app.js'));
  assert.ok(html.includes('/ui/ui.css'));
});

test('static assets are served with correct types', async () => {
  const css = await fetch(`${baseUrl}/ui/ui.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.ok((await css.text()).includes('--accent'));

  const js = await fetch(`${baseUrl}/ui/app.js`);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);

  const icon = await fetch(`${baseUrl}/ui/favicon.svg`);
  assert.equal(icon.status, 200);
  assert.match(icon.headers.get('content-type'), /svg/);
});

test('path traversal is blocked', async () => {
  const res = await fetch(`${baseUrl}/ui/%2e%2e%2fserver.js`);
  assert.equal(res.status, 404);
  const res2 = await fetch(`${baseUrl}/ui/..%2Fserver.js`);
  assert.ok([404, 400].includes(res2.status));
});

test('unknown ui assets return 404 while api routes stay live', async () => {
  const missing = await fetch(`${baseUrl}/ui/nope.css`);
  assert.equal(missing.status, 404);

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  const body = await health.json();
  assert.equal(body.service, 'phantom-pay');
  assert.equal(body.stage, 2);
});
