'use strict';

/**
 * Stage-4 HTTP end-to-end tests: the payment lifecycle and audit chain over
 * a live server, plus global invariants (conservation, chain validity).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { server, engine, audit } = require('../server');

let baseUrl = '';

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function api(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('full payment lifecycle over HTTP: authorize, capture part, capture rest, refund part', async () => {
  await api('POST', '/accounts', { id: 'e2e:buyer', currency: 'USD', name: 'Buyer' });
  await api('POST', '/accounts', { id: 'e2e:shop', currency: 'USD', name: 'Shop' });
  await api('POST', '/deposits', { externalId: 'e2e:dep:buyer', accountId: 'e2e:buyer', amount: 100 });

  const auth = await api('POST', '/payments', {
    externalId: 'e2e:pay:1',
    merchantAccountId: 'e2e:shop',
    customerId: 'e2e:buyer',
    amount: 40,
  });
  assert.equal(auth.status, 201);
  assert.equal(auth.body.status, 'authorized');
  const paymentId = auth.body.id;

  const replay = await api('POST', '/payments', {
    externalId: 'e2e:pay:1',
    merchantAccountId: 'e2e:shop',
    customerId: 'e2e:buyer',
    amount: 40,
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.idempotentReplay, true);

  const cap1 = await api('POST', `/payments/${paymentId}/capture`, { amount: 15, idempotencyKey: 'e2e:cap:1' });
  assert.equal(cap1.status, 200);
  assert.equal(cap1.body.payment.status, 'partially_captured');

  const cap1Replay = await api('POST', `/payments/${paymentId}/capture`, { amount: 15, idempotencyKey: 'e2e:cap:1' });
  assert.equal(cap1Replay.body.idempotentReplay, true);
  assert.equal(cap1Replay.body.payment.capturedAmountMinor, 1500);

  const cap2 = await api('POST', `/payments/${paymentId}/capture`, {});
  assert.equal(cap2.body.payment.status, 'captured');
  assert.equal(cap2.body.payment.capturedAmountMinor, 4000);

  const refund = await api('POST', `/payments/${paymentId}/refund`, { amount: 10 });
  assert.equal(refund.body.payment.status, 'partially_refunded');
  assert.equal(refund.body.payment.refundedAmountMinor, 1000);

  const buyer = await api('GET', '/accounts/e2e:buyer/balances');
  assert.equal(buyer.body.balance.amountMinor, 7000); // 100 - 40 + 10 refund

  const refused = await api('POST', `/payments/${paymentId}/refund`, { amount: 999 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'refund_exceeds_captured');

  const auditPage = await api('GET', '/audit?type=payment_captured');
  assert.ok(auditPage.body.items.length >= 2);
  assert.equal(auditPage.body.verification.valid, true);
});

test('void flow over HTTP releases the hold', async () => {
  const auth = await api('POST', '/payments', {
    externalId: 'e2e:pay:2',
    merchantAccountId: 'e2e:shop',
    customerId: 'e2e:buyer',
    amount: 5,
  });
  assert.equal(auth.status, 201);
  const voided = await api('POST', `/payments/${auth.body.id}/void`, {});
  assert.equal(voided.body.payment.status, 'voided');
  const buyer = await api('GET', '/accounts/e2e:buyer/balances');
  assert.equal(buyer.body.balance.amountMinor, 7000);
});

test('unknown payment returns 404 and audit verify endpoint works', async () => {
  const missing = await api('GET', '/payments/pay_nope');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'payment_not_found');

  const verify = await api('GET', '/audit/verify');
  assert.equal(verify.status, 200);
  assert.equal(verify.body.valid, true);
  assert.ok(verify.body.length > 0);
});

test('global conservation and audit chain remain intact after all features', () => {
  let sum = 0n;
  for (const account of engine.listAccounts()) {
    sum += engine.balanceOf(account);
    if (!account.allowNegative && engine.balanceOf(account) < 0n) assert.fail(`${account.id} went negative`);
  }
  assert.equal(sum, 0n);
  const verification = audit.verify();
  assert.equal(verification.valid, true);
});
