import {assertPrivateFile} from './test/platform.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProactiveRuntime, DEFAULT_PROACTIVE_POLICY } from './proactive-runtime.mjs';

const policy = patch => ({ ...DEFAULT_PROACTIVE_POLICY, enabled: true, mode: 'ai', dailyAiLimit: 0, ...patch });
const usage = { input: 40, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 45 };
const reply = text => ({ text: text || '合成测试主动消息', source: 'codex', model: 'test-model', modelCalls: 1, usage: { ...usage } });
async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-proactive-test-'));
  let timestamp = Date.parse('2026-10-28T00:00:00Z');
  let sequence = 0;
  const timers = new Map();
  const calls = [];
  const make = () => createProactiveRuntime({
    root, now: () => timestamp, random: options.random || (() => 0),
    schedule(callback, delay) { const id = ++sequence; timers.set(id, { at: timestamp + delay, callback }); return () => timers.delete(id); },
    canRun: options.canRun || (() => true),
    getCompanionSettings: options.getCompanionSettings,
    generate: async args => { calls.push(args); return options.generate ? options.generate(args, calls.length) : reply(); },
  });
  const f = { root, file: path.join(root, 'data', 'proactive.json'), timers, calls, runtime: make(), make,
    now() { return timestamp; }, setTime(value) { timestamp = typeof value === 'string' ? Date.parse(value) : value; },
    async next({ heartbeat = true, presence = {} } = {}) {
      const [id, next] = [...timers].sort((a,b) => a[1].at - b[1].at)[0] || [];
      assert.ok(next, 'a future wakeup is registered');
      if (heartbeat) while (timestamp + 30_000 < next.at) { timestamp += 30_000; await f.runtime.inbox('0', presence); }
      timestamp = Math.max(timestamp, next.at);
      if (heartbeat) await f.runtime.inbox('0', presence);
      timers.delete(id);
      return next.callback();
    },
    async enable(patch) { await f.runtime.configure(policy(patch)); await f.runtime.start(); return f.runtime.inbox(); },
  };
  t.after(async () => { await f.runtime.close(); await fs.rm(root, { recursive: true }); });
  return f;
}

test('API-generated proactive replies retain their provider source through delivery and restart',async t=>{
  const f=await fixture(t,{generate:async()=>({...reply('API合成主动消息'),source:'api'})});
  await f.enable();await f.next();const received=await f.runtime.inbox('0');assert.equal(received.messages[0].source,'api');
  await f.runtime.close();const restarted=f.make();t.after(()=>restarted.close());assert.equal((await restarted.status()).usage.totalTokens,45);
  assert.equal(JSON.parse(await fs.readFile(f.file,'utf8')).messages[0].source,'api');
});

test('default disabled runtime never calls a model; explicit policy and fresh UI presence arm only future wakeups', async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.runtime.settings(), DEFAULT_PROACTIVE_POLICY);
  await f.runtime.start();
  assert.equal(f.timers.size, 0);
  assert.equal(f.calls.length, 0);
  await f.runtime.configure(policy());
  assert.equal(f.timers.size, 0);
  const first = await f.runtime.inbox();
  assert.equal(first.cursor, '0'); assert.deepEqual(first.messages, []);
  assert.equal(Date.parse(first.status.nextAt) - f.now(), 60_000);
  assert.equal(f.calls.length, 0);
  await assertPrivateFile(f.file);
});

test('one wakeup dispatches one AI request, stores real usage and delivers exactly once by cursor', async t => {
  const f = await fixture(t);
  await f.enable(); await f.next();
  assert.equal(f.calls.length, 1);
  const received = await f.runtime.inbox('0');
  assert.equal(received.messages.length, 1);
  assert.equal(received.messages[0].source, 'codex');
  assert.equal(received.messages[0].usage.totalTokens, 45);
  assert.equal(received.status.aiUsedToday, 1);
  assert.equal(received.status.usage.totalTokens, 45);
  assert.equal((await f.runtime.inbox(received.cursor)).messages.length, 0);
  assert.equal((await f.runtime.inbox()).messages.length, 0, 'initial sync does not replay old messages');
  assert.equal(f.timers.size, 1);
  await assert.rejects(f.runtime.inbox('../../anything'), { code: 'BAD_PROACTIVE_CURSOR' });
});

test('random interval upper bound and restart discard expired deadlines without generating catchup messages', async t => {
  const f = await fixture(t, { random: () => 0.999999999 });
  await f.enable();
  assert.equal(Date.parse((await f.runtime.status()).nextAt) - f.now(), 600_000);
  await f.runtime.close(); f.runtime = f.make();
  f.setTime(f.now() + 2_000_000);
  await f.runtime.start();
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  const resumed = await f.runtime.inbox();
  assert.equal(Date.parse(resumed.status.nextAt) - f.now(), 600_000);
  assert.equal(f.calls.length, 0);
});

test('offline, typing and application work skip generation; offline stops wakeups until the UI returns', async t => {
  let workBusy = false;
  const f = await fixture(t, { canRun: () => !workBusy });
  await f.enable();
  f.setTime(f.now() + 60_001);
  await f.next({ heartbeat: false });
  assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 0);
  assert.equal((await f.runtime.status()).reason, 'ui_offline');
  await f.runtime.inbox('0', { typing: true });
  await f.next({ presence: { typing: true } });
  assert.equal(f.calls.length, 0); assert.equal((await f.runtime.status()).reason, 'user_busy');
  workBusy = true;
  await f.next();
  assert.equal(f.calls.length, 0); assert.equal((await f.runtime.status()).reason, 'work_busy');
  workBusy = false; await f.next(); assert.equal(f.calls.length, 1);
});

test('daily AI cap counts failures, persists across restart and resets on Shanghai day; ai mode does not fake local success', async t => {
  const f = await fixture(t, { generate: async (_args, count) => { if (count === 1) throw Object.assign(new Error('upstream diagnostic must not persist'), { code: 'TEST_FAILURE' }); return reply(); } });
  await f.enable({ dailyAiLimit: 2 });
  await f.next(); assert.equal((await f.runtime.status()).aiUsedToday, 1);
  assert.equal((await f.runtime.inbox('0')).messages.length, 0);
  await f.next(); await f.next();
  assert.equal(f.calls.length, 2);
  const capped = await f.runtime.inbox('0');
  assert.equal(capped.messages.length, 1); assert.equal(capped.status.reason, 'daily_limit');
  await f.runtime.close(); f.runtime = f.make(); await f.runtime.start(); await f.runtime.inbox(); await f.next();
  assert.equal(f.calls.length, 2); assert.equal((await f.runtime.status()).aiUsedToday, 2);
  f.setTime('2026-10-28T16:00:01Z');
  const preview = await f.runtime.preview();
  assert.equal(preview.message.source, 'codex'); assert.equal(preview.status.aiUsedToday, 1);
  assert.equal(preview.status.day, '2026-10-29');
  const content = await fs.readFile(f.file, 'utf8'); assert.equal(content.includes('upstream diagnostic'), false);
});

test('pause and interrupt abort in-flight generation, preserve attempt count and reject late delivery', async t => {
  let entered, resolve;
  const started = new Promise(r => { entered = r; });
  const f = await fixture(t, { generate: async ({ signal }) => { entered(signal); return new Promise(r => { resolve = r; }); } });
  await f.enable(); const wakeup = f.next(); const signal = await started;
  const pausing = f.runtime.configure(policy({ enabled: false }));
  for (let i = 0; i < 10 && !signal.aborted; i++) await new Promise(r => setTimeout(r, 1));
  assert.equal(signal.aborted, true);
  resolve(reply('必须丢弃的迟到回复')); await pausing; await wakeup;
  const after = await f.runtime.inbox('0');
  assert.equal(after.messages.length, 0); assert.equal(after.status.aiUsedToday, 1); assert.equal(after.status.usage.totalTokens, 45);
  assert.equal(f.timers.size, 0);
});

test('interrupt is lower-priority cancellation without disabling policy and schedules a fresh future attempt', async t => {
  let entered;
  const started = new Promise(r => { entered = r; });
  const f = await fixture(t, { generate: async ({ signal }) => { entered(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); } });
  await f.enable(); const wakeup = f.next(); await started;
  await f.runtime.interrupt(); await wakeup;
  const status = await f.runtime.status();
  assert.equal(status.enabled, true); assert.equal(status.generating, false); assert.equal(f.calls.length, 1);
  assert.ok(Date.parse(status.nextAt) > f.now()); assert.equal(f.timers.size, 1);
});

test('economy mode clearly labels local messages and uses AI at most once per hour', async t => {
  const f = await fixture(t);
  await f.enable({ mode: 'economy', dailyAiLimit: 1 });
  await f.next(); await f.next(); await f.next();
  assert.equal(f.calls.length, 1);
  const first = await f.runtime.inbox('0'); assert.deepEqual(first.messages.map(x => x.source), ['codex', 'local', 'local']);
  assert.equal(first.status.localMessagesToday, 2);
  f.setTime(f.now() + 3_600_000); await f.next();
  assert.equal(f.calls.length, 1, 'daily limit also applies to economy AI requests');
  assert.equal((await f.runtime.inbox('0')).messages.at(-1).source, 'local');
});

test('manual preview works while disabled, enters inbox, honors presence, daily cap and source/usage validity', async t => {
  const f = await fixture(t);
  await f.runtime.configure(policy({ enabled: false, dailyAiLimit: 1 })); await f.runtime.start();
  const preview = await f.runtime.preview();
  assert.equal(preview.message.source, 'codex'); assert.equal(preview.status.enabled, false); assert.equal(f.timers.size, 0);
  assert.equal((await f.runtime.inbox(preview.cursor)).messages.length, 0);
  await assert.rejects(f.runtime.preview(), { code: 'PROACTIVE_DAILY_LIMIT' });
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.runtime.preview({ typing: true }), { code: 'PROACTIVE_BUSY' });
});

test('invalid or corrupt policy cannot silently start or reset a private persistent state', async t => {
  const f = await fixture(t);
  await f.enable(); const before = await fs.readFile(f.file, 'utf8');
  await assert.rejects(f.runtime.configure(policy({ minIntervalSeconds: 0 })), { code: 'INVALID_PROACTIVE_POLICY' });
  await assert.rejects(f.runtime.configure({ ...policy(), extra: true }), { code: 'INVALID_PROACTIVE_POLICY' });
  assert.equal(await fs.readFile(f.file, 'utf8'), before);
  await f.runtime.close(); await fs.writeFile(f.file, 'broken-json'); f.runtime = f.make();
  await assert.rejects(f.runtime.start(), { code: 'PROACTIVE_STORAGE_UNAVAILABLE' });
  assert.equal(f.calls.length, 0);
  // Do not ask close() to repair deliberately corrupted test storage.
  await fs.unlink(f.file);
});

test('AI results require one reported model call and real usage; invalid replies never become local or successful messages', async t => {
  const f = await fixture(t, { generate: async () => ({ text: '不能展示为成功的回复', source: 'codex', usage }) });
  await f.enable(); await f.next();
  assert.equal(f.calls.length, 1);
  const state = await f.runtime.inbox('0');
  assert.equal(state.messages.length, 0); assert.equal(state.status.aiUsedToday, 1);
  assert.equal(state.status.lastError, 'PROACTIVE_RESULT_INVALID');
});

test('losing the UI heartbeat during generation discards late output and stops future wakeups', async t => {
  let entered, resolve;
  const started = new Promise(r => { entered = r; });
  const f = await fixture(t, { generate: async () => { entered(); return new Promise(r => { resolve = r; }); } });
  await f.enable(); const work = f.next(); await started;
  f.setTime(f.now() + 60_001); resolve(reply()); await work;
  assert.equal((await f.runtime.status()).uiOnline, false);
  assert.equal(f.timers.size, 0);
  assert.equal((await f.runtime.inbox('0')).messages.length, 0);
});

test('failed persistence rolls back a new policy rather than enabling unsaved settings', async t => {
  const f = await fixture(t);
  await f.enable({ dailyAiLimit: 2 });
  await fs.rename(f.file, f.file + '.saved'); await fs.mkdir(f.file);
  await assert.rejects(f.runtime.configure(policy({ dailyAiLimit: 0 })), { code: 'PROACTIVE_STORAGE_FAILED' });
  assert.equal((await f.runtime.settings()).dailyAiLimit, 2);
  assert.equal(f.timers.size, 0);
  await fs.rmdir(f.file); await fs.rename(f.file + '.saved', f.file);
});

test('cold or disconnected inbox synchronizes the cursor without replaying missed bubbles, and unknown cursors do not guess a message', async t => {
  const f = await fixture(t, { generate: async (_args, number) => reply('合成消息 ' + number) });
  await f.enable(); await f.next();
  const first = (await f.runtime.inbox('0')).cursor;
  await f.next(); const latest = (await f.runtime.inbox(first)).cursor;
  const unknown = await f.runtime.inbox('8c390aa9-f555-4339-894e-f8171b691324');
  assert.deepEqual(unknown.messages, []); assert.equal(unknown.cursor, latest); assert.equal(unknown.resynchronized, true);
  await f.runtime.close(); f.runtime = f.make(); await f.runtime.start();
  const cold = await f.runtime.inbox(first);
  assert.deepEqual(cold.messages, []); assert.equal(cold.cursor, latest); assert.equal(cold.resynchronized, true);
  await f.runtime.close(); f.runtime = f.make(); await f.runtime.start();
  const coldZero = await f.runtime.inbox('0');
  assert.deepEqual(coldZero.messages, []); assert.equal(coldZero.cursor, latest);
  f.setTime(f.now() + 600_001);
  const resumed = await f.runtime.inbox(first);
  assert.deepEqual(resumed.messages, []); assert.equal(resumed.cursor, latest); assert.equal(resumed.resynchronized, true);
  assert.ok(Date.parse(resumed.status.nextAt) > f.now(), 'reconnect replaces a stale wakeup with a future deadline');
});

test('every generation receives only the five latest safe text/source records for repetition avoidance', async t => {
  const f = await fixture(t, { generate: async (_args, number) => reply('合成消息 ' + number) });
  await f.enable();
  for (let number = 0; number < 7; number++) await f.next();
  assert.deepEqual(f.calls[0].recentMessages, []);
  assert.deepEqual(f.calls[6].recentMessages.map(item => item.text), ['合成消息 2', '合成消息 3', '合成消息 4', '合成消息 5', '合成消息 6']);
  assert.ok(f.calls[6].recentMessages.every(item => Object.keys(item).sort().join(',') === 'source,text'));
});

test('an interrupt during reservation or dispatch waits until the generation has fully settled', async t => {
  let cleanupFinished = false;
  let dispatched = false;
  const f = await fixture(t, { generate: async ({ signal }) => {
    dispatched = true;
    return new Promise((_resolve, reject) => {
      const finish = () => setTimeout(() => { cleanupFinished = true; reject(signal.reason); }, 15);
      if (signal.aborted) finish(); else signal.addEventListener('abort', finish, { once: true });
    });
  } });
  await f.enable(); const work = f.next();
  for (let attempt = 0; attempt < 100 && !f.runtime.busy; attempt++) await new Promise(resolve => setImmediate(resolve));
  await f.runtime.interrupt();
  assert.equal(f.runtime.busy, false);
  if (dispatched) assert.equal(cleanupFinished, true);
  await work;
  assert.equal((await f.runtime.inbox('0')).messages.length, 0);
});

test('a replaced timer callback already queued before reconnect cannot dispatch before the fresh deadline', async t => {
  const f = await fixture(t);
  await f.enable();
  const stale = [...f.timers.values()][0].callback;
  f.setTime(f.now() + 600_001);
  const reconnected = await f.runtime.inbox('0');
  const nextAt = reconnected.status.nextAt;
  await stale();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.runtime.status()).nextAt, nextAt);
  assert.ok(Date.parse(nextAt) > f.now());
  assert.equal(f.timers.size, 1);
});

const companion = patch => ({ preferences: { preferredName: '老板', tone: 'natural' }, quiet: { enabled: false, start: '23:00', end: '08:00' }, focusUntil: null, backoff: { enabled: true, afterUnanswered: 3, maxMultiplier: 8, maxIntervalSeconds: 3600 }, recentTopics: { enabled: true, maxAgeMinutes: 120 }, ...patch });

test('Shanghai overnight quiet hours avoid a future night and resume only after a fresh interval at the exact end', async t => {
  const settings = companion({ quiet: { enabled: true, start: '23:00', end: '08:00' } });
  const f = await fixture(t, { getCompanionSettings: async () => settings });
  f.setTime('2026-10-28T22:59:30+08:00');
  await f.enable();
  const before = await f.runtime.status();
  assert.equal(before.quietActive, false);
  assert.equal(before.nextAt, '2026-10-29T00:01:00.000Z');
  assert.equal((await f.runtime.settings()).minIntervalSeconds, 60);
  const stale = [...f.timers.values()][0].callback;
  f.setTime('2026-10-28T23:00:00+08:00');
  const night = await f.runtime.inbox('0');
  assert.equal(night.status.quietActive, true); assert.equal(night.status.reason, 'quiet_hours');
  assert.equal(night.status.nextAllowedAt, '2026-10-29T00:00:00.000Z');
  await stale();
  assert.equal(f.calls.length, 0);
  f.setTime('2026-10-29T08:00:00+08:00');
  const morning = await f.runtime.inbox('0');
  assert.equal(morning.status.quietActive, false); assert.equal(morning.status.nextAllowedAt, null);
  assert.equal(morning.status.reason, 'ready');
  assert.equal(Date.parse(morning.status.nextAt) - f.now(), 60_000);
  assert.equal(f.calls.length, 0, 'opening time does not cause an immediate catchup message');
  await f.next(); assert.equal(f.calls.length, 1);
});

test('same-day quiet boundaries and focus ending inside a night use the Shanghai union of restrictions', async t => {
  let settings = companion({ quiet: { enabled: true, start: '13:00', end: '14:00' } });
  const f = await fixture(t, { getCompanionSettings: async () => settings });
  f.setTime('2026-10-28T13:00:00+08:00'); await f.enable();
  const lunch = await f.runtime.status();
  assert.equal(lunch.reason, 'quiet_hours'); assert.equal(lunch.nextAllowedAt, '2026-10-28T06:00:00.000Z');
  assert.equal(lunch.nextAt, '2026-10-28T06:01:00.000Z');
  f.setTime('2026-10-28T14:00:00+08:00'); await f.runtime.inbox();
  assert.equal((await f.runtime.status()).quietActive, false);
  f.setTime('2026-10-28T22:00:00+08:00');
  settings = companion({ quiet: { enabled: true, start: '23:00', end: '08:00' }, focusUntil: '2026-10-28T15:30:00.000Z' });
  await f.runtime.refreshCompanionSettings(); await f.runtime.inbox();
  const focus = await f.runtime.status();
  assert.equal(focus.focusActive, true); assert.equal(focus.quietActive, false); assert.equal(focus.reason, 'focus');
  assert.equal(focus.nextAllowedAt, '2026-10-29T00:00:00.000Z');
  assert.equal(focus.nextAt, '2026-10-29T00:01:00.000Z');
});

test('explicit preview bypasses quiet and focus once, respects the daily cap, and never increments unanswered', async t => {
  const settings = companion({ quiet: { enabled: true, start: '23:00', end: '08:00' }, focusUntil: '2026-10-28T16:00:00.000Z' });
  const f = await fixture(t, { getCompanionSettings: async () => settings });
  f.setTime('2026-10-28T23:20:00+08:00'); await f.enable({ dailyAiLimit: 1 });
  const preview = await f.runtime.preview();
  assert.equal(preview.message.source, 'codex'); assert.equal(preview.message.countsForBackoff, false);
  assert.equal(preview.status.unansweredCount, 0); assert.equal(preview.status.quietActive, true); assert.equal(f.calls.length, 1);
  const blocked = await f.runtime.inbox('0');
  assert.deepEqual(blocked.messages, []); assert.equal(blocked.cursor, preview.message.id); assert.equal(blocked.status.unansweredCount, 0);
  await assert.rejects(f.runtime.preview(), { code: 'PROACTIVE_DAILY_LIMIT' });
  await assert.rejects(f.runtime.preview({ typing: true }), { code: 'PROACTIVE_BUSY' });
  assert.equal(f.calls.length, 1);
});

test('delivered unanswered messages back off at three, six and nine; duplicate polls and previews do not count', async t => {
  let randomValue = 0;
  const f = await fixture(t, { getCompanionSettings: async () => companion(), random: () => randomValue });
  await f.enable();
  for (let count = 1; count <= 9; count++) {
    await f.next();
    const delivered = await f.runtime.inbox('0');
    assert.equal(delivered.status.unansweredCount, count);
    assert.equal(delivered.status.backoffMultiplier, Math.min(8, 2 ** Math.floor(count / 3)));
    assert.equal((await f.runtime.inbox('0')).status.unansweredCount, count, 'a message is counted only on its first delivery');
    if (count === 3) assert.equal(Date.parse(delivered.status.nextAt) - f.now(), 120_000);
    if (count === 6) assert.equal(Date.parse(delivered.status.nextAt) - f.now(), 240_000);
  }
  const backed = await f.runtime.status();
  assert.equal(backed.effectiveMinIntervalSeconds, 480); assert.equal(backed.effectiveMaxIntervalSeconds, 3600);
  await f.runtime.preview(); await f.runtime.inbox('0');
  assert.equal((await f.runtime.status()).unansweredCount, 9);
  randomValue = 0.999999999;
  const capped = await f.runtime.interrupt();
  assert.equal(Date.parse(capped.nextAt) - f.now(), 3_600_000);
  const resumed = await f.runtime.interact();
  assert.equal(resumed.unansweredCount, 0); assert.equal(resumed.backoffMultiplier, 1);
  assert.equal(resumed.effectiveMinIntervalSeconds, 60); assert.equal(resumed.effectiveMaxIntervalSeconds, 600);
  assert.equal(Date.parse(resumed.nextAt) - f.now(), 600_000);
  assert.equal(resumed.lastUserAt, new Date(f.now()).toISOString());
});

test('unanswered state survives Shanghai midnight and restart while cold synchronization counts no missed messages', async t => {
  const f = await fixture(t, { getCompanionSettings: async () => companion() });
  f.setTime('2026-10-28T23:50:00+08:00'); await f.enable();
  for (let count = 0; count < 3; count++) { await f.next(); await f.runtime.inbox('0'); }
  assert.equal((await f.runtime.status()).unansweredCount, 3);
  await f.runtime.close(); f.runtime = f.make();
  f.setTime('2026-10-29T08:00:00+08:00'); await f.runtime.start();
  const restarted = await f.runtime.inbox('0');
  assert.deepEqual(restarted.messages, []); assert.equal(restarted.status.unansweredCount, 3);
  assert.equal(restarted.status.backoffMultiplier, 2); assert.equal(restarted.status.aiUsedToday, 0);
  await f.runtime.interact();
  await f.runtime.close(); f.runtime = f.make(); await f.runtime.start();
  const reset = await f.runtime.inbox('0');
  assert.equal(reset.status.unansweredCount, 0); assert.equal(reset.status.backoffMultiplier, 1);
});

test('quiet, focus, typing and user interaction discard generated but undelivered replies without counting them', async t => {
  let settings = companion();
  const f = await fixture(t, { getCompanionSettings: async () => settings });
  await f.enable(); await f.next();
  settings = companion({ focusUntil: new Date(f.now() + 3_600_000).toISOString() });
  await f.runtime.refreshCompanionSettings();
  const focused = await f.runtime.inbox('0');
  assert.deepEqual(focused.messages, []); assert.equal(focused.status.unansweredCount, 0);
  settings = companion(); await f.runtime.refreshCompanionSettings();
  assert.deepEqual((await f.runtime.inbox('0')).messages, []);
  await f.next();
  const typing = await f.runtime.inbox('0', { typing: true });
  assert.deepEqual(typing.messages, []); assert.equal(typing.status.reason, 'user_busy');
  assert.deepEqual((await f.runtime.inbox('0')).messages, []); assert.equal((await f.runtime.status()).unansweredCount, 0);
  await f.next(); await f.runtime.interact();
  assert.deepEqual((await f.runtime.inbox('0')).messages, []); assert.equal((await f.runtime.status()).unansweredCount, 0);
  await f.next();
  settings = companion({ quiet: { enabled: true, start: '08:00', end: '09:00' } });
  const quiet = await f.runtime.inbox('0');
  assert.deepEqual(quiet.messages, []); assert.equal(quiet.status.reason, 'quiet_hours'); assert.equal(quiet.status.unansweredCount, 0);
  settings = companion(); await f.runtime.refreshCompanionSettings();
  assert.deepEqual((await f.runtime.inbox('0')).messages, []);
});

test('refresh aborts an active reply, waits for cleanup and prevents stale timer or result delivery in a focus period', async t => {
  let settings = companion();
  let entered, resolve;
  const started = new Promise(r => { entered = r; });
  const f = await fixture(t, { getCompanionSettings: async () => settings, generate: async ({ signal }) => { entered(signal); return new Promise(r => { resolve = r; }); } });
  await f.enable(); const stale = [...f.timers.values()][0].callback;
  const work = f.next(); const signal = await started;
  settings = companion({ focusUntil: new Date(f.now() + 3_600_000).toISOString() });
  let settled = false;
  const refreshing = f.runtime.refreshCompanionSettings().then(status => { settled = true; return status; });
  for (let i = 0; i < 20 && !signal.aborted; i++) await new Promise(r => setTimeout(r, 1));
  assert.equal(signal.aborted, true); assert.equal(settled, false);
  resolve(reply('不得出现的旧回复')); await work; const status = await refreshing;
  assert.equal(status.generating, false); assert.equal(status.reason, 'focus');
  assert.equal(Date.parse(status.nextAt) - f.now(), 3_660_000);
  await stale(); assert.equal(f.calls.length, 1);
  assert.deepEqual((await f.runtime.inbox('0')).messages, []);
  assert.equal((await f.runtime.status()).unansweredCount, 0);
});

test('quiet beginning or draft activity during generation is checked again before committing a bubble', async t => {
  let entered, resolve;
  const started = new Promise(r => { entered = r; });
  const settings = companion({ quiet: { enabled: true, start: '23:00', end: '08:00' } });
  const f = await fixture(t, { getCompanionSettings: async () => settings, generate: async () => { entered(); return new Promise(r => { resolve = r; }); } });
  f.setTime('2026-10-28T22:58:40+08:00'); await f.enable();
  const work = f.next(); await started;
  f.setTime('2026-10-28T23:00:00+08:00'); await f.runtime.inbox('0');
  resolve(reply()); await work;
  const night = await f.runtime.inbox('0');
  assert.deepEqual(night.messages, []); assert.equal(night.status.aiUsedToday, 1); assert.equal(night.status.aiSucceededToday, 0);
  assert.equal(night.status.reason, 'quiet_hours'); assert.equal(night.status.nextAt, '2026-10-29T00:01:00.000Z');
});

test('interact aborts an active generation, resets durable unanswered and blocks a late reply without disabling policy', async t => {
  let entered, resolve;
  const started = new Promise(r => { entered = r; });
  const f = await fixture(t, { getCompanionSettings: async () => companion(), generate: async (_args, count) => {
    if (count <= 3) return reply();
    entered(); return new Promise(r => { resolve = r; });
  } });
  await f.enable();
  for (let count = 0; count < 3; count++) { await f.next(); await f.runtime.inbox('0'); }
  const work = f.next(); await started;
  const interacting = f.runtime.interact();
  await new Promise(r => setTimeout(r, 1)); resolve(reply('旧消息')); await work;
  const status = await interacting;
  assert.equal(status.enabled, true); assert.equal(status.unansweredCount, 0); assert.equal(status.backoffMultiplier, 1);
  assert.equal(Date.parse(status.nextAt) - f.now(), 60_000);
  assert.deepEqual((await f.runtime.inbox('0')).messages, []);
});

test('legacy version-one ledgers without optional delivery fields stay compatible, and economy uses the preferred name as text', async t => {
  const f = await fixture(t, { getCompanionSettings: async () => companion({ preferences: { preferredName: '小王$&$$', tone: 'gentle' } }) });
  await f.enable({ mode: 'economy', dailyAiLimit: 1 }); await f.next(); await f.next();
  const received = await f.runtime.inbox('0');
  assert.equal(received.messages.at(-1).source, 'local'); assert.equal(received.messages.at(-1).text.includes('老板'), false);
  assert.equal(received.messages.at(-1).text.includes('小王$&$$'), true, 'nickname is literal text, never a replacement instruction');
  await f.runtime.close();
  const ledger = JSON.parse(await fs.readFile(f.file, 'utf8'));
  delete ledger.unansweredCount; delete ledger.lastUserAt; delete ledger.deliveryEpoch;
  for (const message of ledger.messages) { delete message.countsForBackoff; delete message.deliveryEpoch; delete message.deliveredAt; delete message.suppressedAt; }
  await fs.writeFile(f.file, JSON.stringify(ledger)); f.runtime = f.make(); await f.runtime.start();
  const resumed = await f.runtime.inbox('0');
  assert.deepEqual(resumed.messages, []); assert.equal(resumed.status.unansweredCount, 0); assert.equal(resumed.status.backoffMultiplier, 1);
});

test('failed companion reads fail closed and later recovery requires a new future wakeup', async t => {
  let available = false;
  const f = await fixture(t, { getCompanionSettings: async () => { if (!available) throw new Error('private diagnostic'); return companion(); } });
  await f.enable();
  assert.equal(f.timers.size, 0); assert.equal((await f.runtime.status()).reason, 'settings_unavailable');
  await assert.rejects(f.runtime.preview(), { code: 'PROACTIVE_SETTINGS_UNAVAILABLE' }); assert.equal(f.calls.length, 0);
  available = true; const recovered = await f.runtime.refreshCompanionSettings();
  assert.equal(Date.parse(recovered.nextAt) - f.now(), 60_000); assert.equal(f.calls.length, 0);
  assert.equal((await fs.readFile(f.file, 'utf8')).includes('private diagnostic'), false);
});

test('backoff never shortens an existing base interval longer than its growth cap', async t => {
  const f = await fixture(t, { getCompanionSettings: async () => companion() });
  await f.enable({ minIntervalSeconds: 7200, maxIntervalSeconds: 10800 });
  const initial = await f.runtime.status();
  assert.equal(initial.backoffMultiplier, 1); assert.equal(initial.effectiveMinIntervalSeconds, 7200); assert.equal(initial.effectiveMaxIntervalSeconds, 10800);
  assert.equal(Date.parse(initial.nextAt) - f.now(), 7_200_000);
  for (let count = 0; count < 3; count++) { await f.next(); await f.runtime.inbox('0'); }
  const backed = await f.runtime.status();
  assert.equal(backed.backoffMultiplier, 2); assert.equal(backed.effectiveMinIntervalSeconds, 7200); assert.equal(backed.effectiveMaxIntervalSeconds, 10800);
});

test('a draft typed while a request runs discards its result and does not count an unanswered delivery', async t => {
  let entered, resolve;
  const started = new Promise(r => { entered = r; });
  const f = await fixture(t, { getCompanionSettings: async () => companion(), generate: async () => { entered(); return new Promise(r => { resolve = r; }); } });
  await f.enable(); const work = f.next(); await started;
  await f.runtime.inbox('0', { typing: true }); resolve(reply()); await work;
  const after = await f.runtime.inbox('0', { typing: true });
  assert.deepEqual(after.messages, []); assert.equal(after.status.reason, 'user_busy'); assert.equal(after.status.unansweredCount, 0);
  assert.equal(after.status.aiSucceededToday, 0); assert.equal(after.status.aiUsedToday, 1);
});

test('a far future focus never overflows the host timer into immediate repeated wakeups', async t => {
  const f = await fixture(t, { getCompanionSettings: async () => companion({ focusUntil: '2027-10-28T00:00:00.000Z' }) });
  await f.enable(); const status = await f.runtime.status();
  assert.equal(status.reason, 'focus'); assert.equal(status.nextAt, '2027-10-28T00:01:00.000Z');
  assert.equal([...f.timers.values()][0].at - f.now(), 86_400_000);
  await f.next(); assert.equal(f.calls.length, 0);
  assert.equal((await f.runtime.status()).nextAt, '2027-10-28T00:01:00.000Z');
  assert.equal([...f.timers.values()][0].at - f.now(), 86_400_000);
});

test('pausing during settings refresh remains disabled after active cleanup and subsequent settings changes', async t => {
  let settings = companion();
  let entered, resolve;
  const started = new Promise(r => { entered = r; });
  const f = await fixture(t, { getCompanionSettings: async () => settings, generate: async () => { entered(); return new Promise(r => { resolve = r; }); } });
  await f.enable(); const work = f.next(); await started;
  settings = companion({ focusUntil: new Date(f.now() + 3_600_000).toISOString() });
  const refreshing = f.runtime.refreshCompanionSettings();
  const pausing = f.runtime.configure(policy({ enabled: false }));
  await new Promise(r => setTimeout(r, 1)); resolve(reply());
  await Promise.all([work, refreshing, pausing]);
  settings = companion(); await f.runtime.refreshCompanionSettings();
  const after = await f.runtime.inbox('0');
  assert.equal(after.status.enabled, false); assert.equal(after.status.generating, false); assert.equal(after.status.nextAt, null);
  assert.deepEqual(after.messages, []); assert.equal(f.timers.size, 0); assert.equal(f.calls.length, 1);
});

test('automatic omission of an expired focus does not add a second random interval at dispatch', async t => {
  let focusUntil;
  const f = await fixture(t, { random: () => 0.999999999, getCompanionSettings: async () => companion({ focusUntil: focusUntil && Date.parse(focusUntil) > f.now() ? focusUntil : null }) });
  focusUntil = new Date(f.now() + 3_600_000).toISOString();
  await f.enable();
  assert.equal(Date.parse((await f.runtime.status()).nextAt) - f.now(), 4_200_000);
  await f.next();
  assert.equal(f.calls.length, 1, 'the planned reply occurs 10 minutes after focus instead of being deferred to 20 minutes');
  assert.equal((await f.runtime.inbox('0')).messages.length, 1);
});

test('segmented timers preserve the not-before deadline even after focus has ended', async t => {
  let focusUntil;
  const f = await fixture(t, { getCompanionSettings: async () => companion({ focusUntil: focusUntil && Date.parse(focusUntil) > f.now() ? focusUntil : null }) });
  focusUntil = new Date(f.now() + 3_600_000).toISOString();
  await f.enable({ minIntervalSeconds: 86400, maxIntervalSeconds: 86400 });
  const deadline = (await f.runtime.status()).nextAt;
  assert.equal(Date.parse(deadline) - f.now(), 90_000_000);
  assert.equal([...f.timers.values()][0].at - f.now(), 86_400_000);
  await f.next();
  assert.equal(f.calls.length, 0, 'the 24-hour intermediate wakeup must not send the 25-hour reply');
  assert.equal((await f.runtime.status()).nextAt, deadline);
  assert.equal([...f.timers.values()][0].at - f.now(), 3_600_000);
  await f.next(); assert.equal(f.calls.length, 1);
});

test('long base intervals landing in quiet hours shift to the next opening without cycling into another night', async t => {
  const f = await fixture(t, { getCompanionSettings: async () => companion({ quiet: { enabled: true, start: '23:00', end: '08:00' } }) });
  f.setTime('2026-10-28T10:00:00+08:00');
  await f.enable({ minIntervalSeconds: 21 * 3600, maxIntervalSeconds: 21 * 3600 });
  const next = await f.runtime.status();
  assert.equal(next.nextAt, '2026-10-29T00:01:00.000Z');
  assert.ok(Date.parse(next.nextAt) - f.now() > 21 * 3_600_000, 'quiet adjustment respects the existing minimum interval');
  await f.next(); assert.equal(f.calls.length, 1);
  assert.equal((await f.runtime.inbox('0')).messages.length, 1);
});
