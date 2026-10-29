import {assertPrivateFile} from './test/platform.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createScreenBudget, DEFAULT_SCREEN_POLICY } from './screen-policy.mjs';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-screen-policy-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const file = path.join(directory, 'screen-budget.json');
  const policyFile = path.join(directory, 'screen-policy.json');
  let timestamp = Date.parse('2026-10-28T00:00:00Z');
  const options = { file, policyFile, now: () => timestamp };
  return { file, policyFile, options, budget: createScreenBudget(options), advance(ms) { timestamp += ms; }, setTime(value) { timestamp = Date.parse(value); } };
}

test('absent settings keep old defaults; configured policy and dispatch counters survive restart privately', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.budget.settings(), DEFAULT_SCREEN_POLICY);
  assert.equal((await f.budget.status()).allowed, true);
  const changed = await f.budget.configure({ minIntervalSeconds: 120, dailyLimit: 25 });
  assert.equal(changed.budget.limit, 25);
  await f.budget.commit();
  const resumed = createScreenBudget(f.options);
  assert.deepEqual(await resumed.settings(), { minIntervalSeconds: 120, dailyLimit: 25 });
  const status = await resumed.status();
  assert.equal(status.used, 1);
  assert.equal(status.remaining, 24);
  assert.equal(status.minIntervalSeconds, 120);
  assert.equal(status.reason, 'cooldown');
  await assertPrivateFile(f.policyFile);
  await assertPrivateFile(f.file);
});

test('lowering then raising daily limit never resets usage or invalidates a legacy ledger over the new cap', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify({ version: 1, day: '2026-10-28', count: 12, lastSentAt: Date.parse('2026-10-27T23:00:00Z') }), { mode: 0o600 });
  const previous = await fs.readFile(f.file, 'utf8');
  const lowered = await f.budget.configure({ minIntervalSeconds: 600, dailyLimit: 3 });
  assert.equal(lowered.budget.used, 12);
  assert.equal(lowered.budget.remaining, 0);
  assert.equal(lowered.budget.reason, 'daily_limit');
  await assert.rejects(f.budget.commit(), { code: 'SCREEN_BUDGET_REFUSED', screenReason: 'daily_limit' });
  assert.equal(await fs.readFile(f.file, 'utf8'), previous);
  const raised = await f.budget.configure({ minIntervalSeconds: 600, dailyLimit: 20 });
  assert.equal(raised.budget.allowed, true);
  assert.equal(raised.budget.remaining, 8);
  const sent = await f.budget.commit();
  assert.equal(sent.used, 13);
  assert.equal(sent.remaining, 7);
  assert.equal((await createScreenBudget(f.options).status()).used, 13);
});

test('changing the interval recomputes from last dispatch, including immediate every-message mode', async t => {
  const f = await fixture(t);
  await f.budget.commit();
  f.advance(120000);
  assert.equal((await f.budget.status()).secondsUntilNext, 480);
  const reduced = await f.budget.configure({ minIntervalSeconds: 60, dailyLimit: 12 });
  assert.equal(reduced.budget.allowed, true);
  assert.equal(reduced.budget.used, 1);
  const lengthened = await f.budget.configure({ minIntervalSeconds: 300, dailyLimit: 12 });
  assert.equal(lengthened.budget.allowed, false);
  assert.equal(lengthened.budget.secondsUntilNext, 180);
  await f.budget.configure({ minIntervalSeconds: 0, dailyLimit: 12 });
  assert.equal((await f.budget.commit()).used, 2);
  assert.equal((await f.budget.commit()).used, 3);
});

test('daily limit zero means unlimited and still accumulates used counts and enforces interval', async t => {
  const f = await fixture(t);
  await f.budget.configure({ minIntervalSeconds: 60, dailyLimit: 0 });
  const sent = await f.budget.commit();
  assert.equal(sent.dailyUnlimited, true);
  assert.equal(sent.limit, 0);
  assert.equal(sent.remaining, null);
  assert.equal(sent.reason, 'cooldown');
  await assert.rejects(f.budget.commit(), { screenReason: 'cooldown' });
  await f.budget.configure({ minIntervalSeconds: 0, dailyLimit: 0 });
  for (let index = 0; index < 20; index++) await f.budget.commit();
  const status = await f.budget.status();
  assert.equal(status.used, 21);
  assert.equal(status.allowed, true);
  assert.equal(status.remaining, null);
  f.setTime('2026-10-28T16:00:00Z');
  const nextDay = await f.budget.status();
  assert.equal(nextDay.day, '2026-10-29');
  assert.equal(nextDay.used, 0);
  assert.equal(nextDay.allowed, true);
});

test('a policy change and concurrent commits obey one queue, and dispatch rechecks a changed policy', async t => {
  const f = await fixture(t);
  await f.budget.configure({ minIntervalSeconds: 0, dailyLimit: 2 });
  await f.budget.commit();
  assert.equal((await f.budget.status()).allowed, true);
  const setting = f.budget.configure({ minIntervalSeconds: 0, dailyLimit: 1 });
  const refused = f.budget.commit();
  await setting;
  await assert.rejects(refused, { screenReason: 'daily_limit' });
  const raising = f.budget.configure({ minIntervalSeconds: 0, dailyLimit: 3 });
  const attempts = [f.budget.commit(), f.budget.commit(), f.budget.commit()];
  await raising;
  const results = await Promise.allSettled(attempts);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 2);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.equal((await f.budget.status()).used, 3);
});

test('invalid values or unknown fields never overwrite the valid policy or reset ledger', async t => {
  const f = await fixture(t);
  await f.budget.configure({ minIntervalSeconds: 120, dailyLimit: 30 });
  await f.budget.commit();
  const original = await fs.readFile(f.policyFile, 'utf8');
  const ledger = await fs.readFile(f.file, 'utf8');
  for (const input of [null, [], {}, { minIntervalSeconds: 1 }, { minIntervalSeconds: -1, dailyLimit: 12 }, { minIntervalSeconds: 1.5, dailyLimit: 12 }, { minIntervalSeconds: 86401, dailyLimit: 12 }, { minIntervalSeconds: 0, dailyLimit: -1 }, { minIntervalSeconds: 0, dailyLimit: 10001 }, { minIntervalSeconds: 0, dailyLimit: '12' }, { minIntervalSeconds: 0, dailyLimit: 12, reset: true }]) {
    await assert.rejects(f.budget.configure(input), { code: 'INVALID_SCREEN_POLICY' });
  }
  assert.equal(await fs.readFile(f.policyFile, 'utf8'), original);
  assert.equal(await fs.readFile(f.file, 'utf8'), ledger);
});

test('damaged policy or ledger fails closed and cannot silently restore permissive defaults', async t => {
  for (const damaged of ['policy', 'ledger']) {
    const f = await fixture(t);
    await f.budget.configure({ minIntervalSeconds: 0, dailyLimit: 0 });
    await f.budget.commit();
    const target = damaged === 'policy' ? f.policyFile : f.file;
    await fs.writeFile(target, '{invalid-json');
    const status = await f.budget.status();
    assert.equal(status.allowed, false);
    assert.equal(status.canSend, false);
    assert.equal(status.reason, 'storage_error');
    await assert.rejects(f.budget.commit(), { code: damaged === 'policy' ? 'SCREEN_POLICY_UNAVAILABLE' : 'SCREEN_BUDGET_UNAVAILABLE' });
    await assert.rejects(f.budget.configure({ minIntervalSeconds: 0, dailyLimit: 1000 }));
    assert.equal(await fs.readFile(target, 'utf8'), '{invalid-json');
    if (damaged === 'policy') await assert.rejects(f.budget.settings(), { code: 'SCREEN_POLICY_UNAVAILABLE' });
  }
});
