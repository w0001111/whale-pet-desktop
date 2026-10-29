import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createUsageBudget, parseUsageCommand } from './usage-budget.mjs';

const usage = (total = 100) => ({ input: total - 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: total });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-usage-budget-'));
  let time = Date.parse('2026-10-29T02:00:00Z');
  const now = () => time;
  const make = () => createUsageBudget({ root, now });
  const f = { root, now, make, budget: make(), policyFile: path.join(root, 'data', 'usage-policy.json'), ledgerFile: path.join(root, 'data', 'usage-ledger.json'),
    setTime(value) { time = typeof value === 'string' ? Date.parse(value) : value; },
    record(patch = {}) { return f.budget.record({ id: 'synthetic-' + Math.random().toString(36).slice(2), kind: 'chat', at: new Date(time).toISOString(), status: 'completed', modelCalls: 1, usage: usage(), ...patch }); },
  };
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return f;
}

test('fresh files default to unlimited with private modes and an honest coverage boundary', async t => {
  const f = await fixture(t); const result = await f.budget.get();
  assert.equal(result.available, true); assert.deepEqual(result.policy, { dailyTokenLimit: 0 });
  assert.equal(result.timezone, 'Asia/Shanghai'); assert.equal(result.day, '2026-10-29');
  assert.equal(result.today.requests, 0); assert.equal(result.history.length, 30);
  assert.equal(result.gate.blocked, false); assert.equal(result.gate.remainingTokens, null);
  assert.equal(result.coverage.includesAccountTotal, false); assert.match(result.coverage.note, /本功能启用前/); assert.match(result.coverage.note, /不是硬计费封顶/);
  assert.equal((await fs.stat(f.policyFile)).mode & 0o777, 0o600); assert.equal((await fs.stat(f.ledgerFile)).mode & 0o777, 0o600);
  assert.deepEqual(await f.budget.snapshot(), result);
});

test('chat, proactive and task use share totals but preserve per-kind request, status and reported model counts', async t => {
  const f = await fixture(t);
  await f.record({ id: 'normal-chat', kind: 'chat', usage: usage(100), modelCalls: 2 });
  await f.record({ id: 'pet-message', kind: 'proactive', usage: usage(50), modelCalls: 1 });
  await f.record({ id: 'tool-task', kind: 'task', status: 'cancelled', usage: usage(75), modelCalls: 3 });
  const result = await f.budget.get();
  assert.equal(result.today.usage.totalTokens, 225); assert.equal(result.today.modelCalls, 6); assert.equal(result.today.requests, 3);
  assert.equal(result.today.completed, 2); assert.equal(result.today.cancelled, 1); assert.equal(result.today.failed, 0);
  assert.equal(result.today.byKind.chat.usage.totalTokens, 100); assert.equal(result.today.byKind.proactive.usage.totalTokens, 50); assert.equal(result.today.byKind.task.usage.totalTokens, 75);
  assert.equal(result.today.unknownUsageAttempts, 0);
  const stored = await fs.readFile(f.ledgerFile, 'utf8'); assert.equal(stored.includes('normal-chat'), false, 'dedup IDs are hashed');
});

test('same ID is idempotent across retries, kind changes and process restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.record({ id: 'stable-id' })).recorded, true);
  const repeated = await f.record({ id: 'stable-id', kind: 'task', usage: usage(900) });
  assert.equal(repeated.duplicate, true); f.budget = f.make();
  assert.equal((await f.record({ id: 'stable-id', usage: usage(500) })).duplicate, true);
  const result = await f.budget.get(); assert.equal(result.today.requests, 1); assert.equal(result.today.usage.totalTokens, 100);
});

test('a response may cross the daily threshold; only subsequent proactive generation is gated and raising or disabling restores it', async t => {
  const f = await fixture(t); await f.budget.configure({ dailyTokenLimit: 150 });
  await f.record(); assert.equal((await f.budget.proactiveGate()).blocked, false);
  await f.record({ kind: 'proactive', usage: usage(80) });
  let gate = await f.budget.proactiveGate();
  assert.equal(gate.reason, 'token_budget'); assert.equal(gate.usedTokens, 180); assert.equal(gate.remainingTokens, 0); assert.equal(gate.nextAllowedAt, '2026-10-29T16:00:00.000Z');
  await f.record({ kind: 'chat', usage: usage(40) }); await f.record({ kind: 'task', usage: usage(30) });
  assert.equal((await f.budget.get()).today.usage.totalTokens, 250, 'explicit chat and task accounting continue at the proactive threshold');
  await f.budget.configure({ dailyTokenLimit: 500 }); gate = await f.budget.proactiveGate();
  assert.equal(gate.blocked, false); assert.equal(gate.remainingTokens, 250);
  await f.budget.configure({ dailyTokenLimit: 0 }); assert.equal((await f.budget.proactiveGate()).blocked, false);
  assert.equal((await f.budget.get()).today.requests, 4, 'configuration never clears usage');
});

test('missing, zero or invalid usage is unknown, partial known usage is retained, and unlimited clears only the budget-unknown gate', async t => {
  const f = await fixture(t); await f.budget.configure({ dailyTokenLimit: 1000 });
  await f.record({ status: 'failed', usage: undefined, modelCalls: 1 });
  await f.record({ status: 'cancelled', usage: usage(30), usageIncomplete: true, modelCalls: 2 });
  await f.record({ status: 'failed', usage: { totalTokens: -1 }, modelCalls: undefined });
  await f.record({ status: 'failed', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, modelCalls: 1 });
  const result = await f.budget.get();
  assert.equal(result.today.requests, 4); assert.equal(result.today.unknownUsageAttempts, 4); assert.equal(result.today.unknownModelCallAttempts, 1);
  assert.equal(result.today.usage.totalTokens, 30); assert.equal(result.today.modelCalls, 4);
  assert.equal(result.gate.reason, 'usage_unknown'); assert.equal(result.gate.nextAllowedAt, '2026-10-29T16:00:00.000Z');
  await f.budget.configure({ dailyTokenLimit: 0 }); assert.equal((await f.budget.proactiveGate()).blocked, false);
  assert.equal((await f.budget.get()).today.unknownUsageAttempts, 4);
});

test('positive reported failure usage counts without fabricating a missing remainder or a successful response', async t => {
  const f = await fixture(t);
  await f.record({ status: 'failed', usage: usage(60), modelCalls: 2 });
  const result = await f.budget.get(); assert.equal(result.today.failed, 1); assert.equal(result.today.completed, 0);
  assert.equal(result.today.usage.totalTokens, 60); assert.equal(result.today.unknownUsageAttempts, 0);
});

test('an explicitly complete zero-use report with zero model calls is known zero, while missing or incomplete evidence stays unknown', async t => {
  const f = await fixture(t); await f.budget.configure({ dailyTokenLimit: 1000 });
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  await f.record({ id: 'preflight-known-zero', status: 'failed', modelCalls: 0, usage: zero });
  let result = await f.budget.get();
  assert.equal(result.today.requests, 1); assert.equal(result.today.modelCalls, 0); assert.equal(result.today.unknownUsageAttempts, 0); assert.equal(result.gate.blocked, false);
  for (const patch of [
    { id: 'no-call-count', modelCalls: undefined, usage: zero },
    { id: 'one-call-no-report', modelCalls: 1, usage: zero },
    { id: 'zero-call-incomplete', modelCalls: 0, usage: zero, usageIncomplete: true },
    { id: 'zero-call-partial-zero', modelCalls: 0, usage: { totalTokens: 0 } },
    { id: 'zero-call-no-usage', modelCalls: 0, usage: undefined },
  ]) await f.record({ status: 'failed', ...patch });
  result = await f.budget.get();
  assert.equal(result.today.usage.totalTokens, 0); assert.equal(result.today.unknownUsageAttempts, 5); assert.equal(result.gate.reason, 'usage_unknown');
});

test('inconsistent, zero or absent totals cannot undercount reported components, while incomplete reports remain unknown', async t => {
  const f = await fixture(t); await f.budget.configure({ dailyTokenLimit: 500 });
  await f.record({ id: 'low-total', usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 3, totalTokens: 1 } });
  assert.equal((await f.budget.get()).today.usage.totalTokens, 128);
  await f.record({ id: 'zero-total', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } });
  assert.equal((await f.budget.get()).today.usage.totalTokens, 248);
  await f.record({ id: 'components-only', usage: { input: 100, output: 20, cacheRead: 10, cacheWrite: 0 } });
  assert.equal((await f.budget.get()).today.usage.totalTokens, 378);
  await f.record({ id: 'higher-total', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 200 } });
  let result = await f.budget.get();
  assert.equal(result.today.usage.totalTokens, 578); assert.equal(result.today.unknownUsageAttempts, 0);
  assert.equal(result.gate.reason, 'token_budget');
  await f.record({ id: 'incomplete-low-total', status: 'failed', usage: { input: 40, output: 10, totalTokens: 1 }, usageIncomplete: true });
  result = await f.budget.get();
  assert.equal(result.today.usage.totalTokens, 628); assert.equal(result.today.unknownUsageAttempts, 1);
  assert.equal(result.gate.reason, 'usage_unknown');
});

test('Shanghai midnight resets the current gate while a late response remains on its request-start day', async t => {
  const f = await fixture(t); f.setTime('2026-10-29T23:59:50+08:00'); await f.budget.configure({ dailyTokenLimit: 50 });
  const startedAt = new Date(f.now()).toISOString(); await f.record({ id: 'before-midnight', usage: usage(80) });
  assert.equal((await f.budget.proactiveGate()).reason, 'token_budget');
  f.setTime('2026-10-30T00:00:10+08:00'); await f.record({ id: 'late-response', at: startedAt, kind: 'task', usage: usage(40) });
  const result = await f.budget.get();
  assert.equal(result.day, '2026-10-30'); assert.equal(result.today.requests, 0); assert.equal(result.gate.blocked, false);
  assert.equal(result.history[1].day, '2026-10-29'); assert.equal(result.history[1].usage.totalTokens, 120);
  assert.equal(result.history[1].byKind.task.usage.totalTokens, 40);
});

test('30-day retention prunes old aggregates and their replay IDs while expired callbacks cannot add old usage again', async t => {
  const f = await fixture(t); const beginning = f.now();
  for (let index = 0; index < 32; index++) { f.setTime(beginning + index * 86_400_000); await f.record({ id: 'retention-' + index }); }
  const result = await f.budget.get(), stored = JSON.parse(await fs.readFile(f.ledgerFile, 'utf8'));
  assert.equal(result.history.length, 30); assert.equal(Object.keys(stored.days).length, 30); assert.equal(Object.keys(stored.seen).length, 30);
  const expired = await f.record({ id: 'retention-0', at: new Date(beginning).toISOString() });
  assert.equal(expired.expired, true); assert.equal(expired.recorded, false);
  assert.equal((await f.budget.get()).history.reduce((sum, day) => sum + day.usage.totalTokens, 0), 3000);
});

test('legacy proactive aggregate imports once and does not invent completion statuses or exact model counts', async t => {
  const f = await fixture(t); const seed = { day: '2026-10-29', usage: usage(300), aiAttempts: 4 };
  assert.equal((await f.budget.seedProactive(seed)).seeded, true);
  assert.equal((await f.budget.seedProactive(seed)).alreadySeeded, true);
  f.budget = f.make(); assert.equal((await f.budget.seedProactive({ ...seed, usage: usage(900) })).alreadySeeded, true);
  await f.record({ kind: 'proactive', usage: usage(20) }); const result = await f.budget.get();
  assert.equal(result.today.usage.totalTokens, 320); assert.equal(result.today.requests, 5); assert.equal(result.today.unclassifiedRequests, 4);
  assert.equal(result.today.completed, 1); assert.equal(result.today.modelCalls, 1); assert.equal(result.today.unknownModelCallAttempts, 4);
  assert.equal(result.coverage.proactiveSeed.aiAttempts, 4); assert.equal(result.coverage.proactiveSeed.source, 'proactive_v1_reported_aggregate');
});

test('zero-use legacy attempts stay unknown, an empty seed is still one-time, and old seeds do not reappear in current usage', async t => {
  const f = await fixture(t); await f.budget.seedProactive({ day: '2026-10-29', usage: { totalTokens: 0 }, aiAttempts: 2 });
  await f.budget.configure({ dailyTokenLimit: 100 }); assert.equal((await f.budget.get()).today.unknownUsageAttempts, 2);
  assert.equal((await f.budget.proactiveGate()).reason, 'usage_unknown');
  f.setTime('2026-12-01T10:00:00+08:00'); const result = await f.budget.get();
  assert.equal(result.today.requests, 0); assert.equal(result.gate.blocked, false);
  assert.equal((await f.budget.seedProactive({ day: '2026-12-01', usage: usage(100), aiAttempts: 1 })).alreadySeeded, true);
});

test('corrupt ledger and partial file loss fail closed without overwriting evidence; repair replays buffered records once', async t => {
  const f = await fixture(t); await f.record({ id: 'original' });
  const before = await fs.readFile(f.ledgerFile, 'utf8'); await fs.writeFile(f.ledgerFile, 'BROKEN_SYNTHETIC_JSON');
  assert.equal((await f.budget.get()).available, false); assert.equal((await f.budget.proactiveGate()).reason, 'usage_unavailable');
  const response = await f.record({ id: 'completed-during-outage', usage: usage(40) });
  assert.equal(response.recorded, false); assert.equal(await fs.readFile(f.ledgerFile, 'utf8'), 'BROKEN_SYNTHETIC_JSON');
  await f.record({ id: 'completed-during-outage', usage: usage(900) });
  await fs.writeFile(f.ledgerFile, before);
  let recovered = await f.budget.get(); assert.equal(recovered.available, true); assert.equal(recovered.today.requests, 2); assert.equal(recovered.today.usage.totalTokens, 140);
  assert.equal((await f.record({ id: 'completed-during-outage' })).duplicate, true);
  await fs.rename(f.policyFile, f.policyFile + '.saved');
  recovered = await f.budget.get(); assert.equal(recovered.available, false); assert.equal(recovered.gate.reason, 'usage_unavailable');
  await fs.rename(f.policyFile + '.saved', f.policyFile); assert.equal((await f.budget.get()).available, true);
});

test('a ledger write failure cannot erase completed request usage or enable proactive work before its buffered commit recovers', async t => {
  const f = await fixture(t); await f.budget.get();
  await fs.rename(f.ledgerFile, f.ledgerFile + '.saved'); await fs.mkdir(f.ledgerFile);
  const result = await f.record({ id: 'io-failed', usage: usage(70) });
  assert.equal(result.reason, 'usage_unavailable'); assert.equal((await f.budget.proactiveGate()).blocked, true);
  await fs.rmdir(f.ledgerFile); await fs.rename(f.ledgerFile + '.saved', f.ledgerFile);
  const recovered = await f.budget.get(); assert.equal(recovered.available, true); assert.equal(recovered.today.usage.totalTokens, 70);
});

test('a failed policy write keeps the gate closed until writing really recovers, even while both files remain readable', async t => {
  const f = await fixture(t); await f.budget.get();
  const rename = fs.rename; let denyWrites = true;
  fs.rename = async (from, to) => {
    if (to === f.policyFile && denyWrites) throw Object.assign(new Error('SYNTHETIC_WRITE_FAILURE'), { code: 'EACCES' });
    return rename(from, to);
  };
  try {
    await assert.rejects(f.budget.configure({ dailyTokenLimit: 100 }), { code: 'USAGE_STORAGE_UNAVAILABLE' });
    assert.equal((await f.budget.proactiveGate()).reason, 'usage_unavailable');
    assert.equal((await f.budget.get()).available, false);
    denyWrites = false;
    const recovered = await f.budget.get();
    assert.equal(recovered.available, true); assert.equal(recovered.policy.dailyTokenLimit, 0, 'failed settings never silently take effect');
    await f.budget.configure({ dailyTokenLimit: 100 }); assert.equal((await f.budget.get()).policy.dailyTokenLimit, 100);
  } finally { fs.rename = rename; }
});

test('failed seed persistence is retried on storage recovery without losing the once-only migration barrier', async t => {
  const f = await fixture(t); await f.budget.get(); const before = await fs.readFile(f.ledgerFile, 'utf8');
  await fs.writeFile(f.ledgerFile, 'BROKEN');
  assert.equal((await f.budget.seedProactive({ day: '2026-10-29', usage: usage(200), aiAttempts: 2 })).reason, 'usage_unavailable');
  await fs.writeFile(f.ledgerFile, before);
  const recovered = await f.budget.get(); assert.equal(recovered.today.usage.totalTokens, 200); assert.equal(recovered.coverage.proactiveSeed.applied, true);
  assert.equal((await f.budget.seedProactive({ day: '2026-10-29', usage: usage(500), aiAttempts: 5 })).alreadySeeded, true);
});

test('symlinked policy or data directory never reads or modifies an outside target', async t => {
  const f = await fixture(t); await f.budget.get();
  const target = path.join(f.root, 'outside-policy.json'); await fs.writeFile(target, JSON.stringify({ dailyTokenLimit: 1 }));
  await fs.unlink(f.policyFile); await fs.symlink(target, f.policyFile);
  assert.equal((await f.budget.proactiveGate()).reason, 'usage_unavailable');
  await assert.rejects(f.budget.configure({ dailyTokenLimit: 10 }), { code: 'USAGE_STORAGE_UNAVAILABLE' });
  assert.equal(await fs.readFile(target, 'utf8'), '{"dailyTokenLimit":1}');
  await fs.unlink(f.policyFile); await fs.rename(path.join(f.root, 'data'), path.join(f.root, 'data.saved'));
  await fs.symlink(path.join(f.root, 'data.saved'), path.join(f.root, 'data'));
  assert.equal((await f.budget.get()).available, false);
});

test('oversized, semantically corrupt or text-bearing persistent files fail closed rather than being accepted or repaired', async t => {
  const f = await fixture(t); await f.budget.get();
  const original = await fs.readFile(f.ledgerFile, 'utf8'), ledger = JSON.parse(original);
  ledger.privateText = 'MUST_NOT_BE_REEXPOSED'; await fs.writeFile(f.ledgerFile, JSON.stringify(ledger));
  const bad = await f.budget.get(); assert.equal(bad.available, false); assert.equal(JSON.stringify(bad).includes('MUST_NOT_BE_REEXPOSED'), false);
  await fs.writeFile(f.ledgerFile, original); await fs.writeFile(f.policyFile, ' '.repeat(16_385));
  assert.equal((await f.budget.proactiveGate()).reason, 'usage_unavailable');
});

test('invalid policy or request metadata is rejected without clearing already recorded data', async t => {
  const f = await fixture(t); await f.record(); const before = await fs.readFile(f.ledgerFile, 'utf8');
  assert.throws(() => f.budget.configure({ dailyTokenLimit: -1 }), { code: 'INVALID_USAGE_POLICY' });
  assert.throws(() => f.budget.configure({ dailyTokenLimit: 100, extra: true }), { code: 'INVALID_USAGE_POLICY' });
  assert.throws(() => f.record({ id: '../bad' }), { code: 'INVALID_USAGE_RECORD' });
  assert.throws(() => f.record({ at: 'not-a-date' }), { code: 'INVALID_USAGE_RECORD' });
  assert.throws(() => f.record({ modelCalls: -1 }), { code: 'INVALID_USAGE_RECORD' });
  assert.equal(await fs.readFile(f.ledgerFile, 'utf8'), before);
});

test('parallel records serialize idempotently and do not lose distinct requests', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 12 }, (_, index) => f.record({ id: 'concurrent-' + index })));
  await Promise.all(Array.from({ length: 8 }, () => f.record({ id: 'same-concurrent' })));
  const result = await f.budget.get(); assert.equal(result.today.requests, 13); assert.equal(result.today.usage.totalTokens, 1300);
});

test('clock may return a Date, and the gate follows Shanghai rather than UTC midnight', async t => {
  const f = await fixture(t); f.setTime('2026-10-29T15:59:59Z');
  const budget = createUsageBudget({ root: f.root, now: () => new Date(f.now()) });
  await budget.configure({ dailyTokenLimit: 50 });
  await budget.record({ id: 'date-clock', kind: 'chat', at: new Date(f.now()), status: 'completed', usage: usage(80), modelCalls: 1 });
  assert.equal((await budget.proactiveGate()).nextAllowedAt, '2026-10-29T16:00:00.000Z');
  f.setTime('2026-10-29T16:00:00Z'); assert.equal((await budget.get()).day, '2026-10-30'); assert.equal((await budget.proactiveGate()).blocked, false);
});

test('local usage commands are fully anchored and cannot turn quoted or conversational text into configuration', () => {
  for (const text of ['用量统计', '今日用量', '用量面板', '预算设置']) assert.deepEqual(parseUsageCommand(text), { type: 'status' });
  assert.deepEqual(parseUsageCommand('每日token预算10000'), { type: 'configure', patch: { dailyTokenLimit: 10000 } });
  assert.deepEqual(parseUsageCommand('每天预算 20000 token'), { type: 'configure', patch: { dailyTokenLimit: 20000 } });
  assert.deepEqual(parseUsageCommand('关闭token预算'), { type: 'configure', patch: { dailyTokenLimit: 0 } });
  assert.deepEqual(parseUsageCommand('预算不限'), { type: 'configure', patch: { dailyTokenLimit: 0 } });
  for (const text of ['请解释每日token预算10000的意思', '“预算不限”是什么意思', '每天预算-1token', '每日token预算1e9', '每天预算100token 然后聊天', '每日token预算99999999999999999']) assert.equal(parseUsageCommand(text), null);
});
