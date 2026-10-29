import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createChatServer, formatCompanionSettings } from './service.mjs';
import { createCompanionSettings, parseCompanionCommand } from './companion-settings.mjs';
import { createProactiveRuntime } from './proactive-runtime.mjs';

const originalPolicy = { enabled: true, mode: 'ai', minIntervalSeconds: 60, maxIntervalSeconds: 600, dailyAiLimit: 0 };
const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer SYNTHETIC-COMPANION-TOKEN' };

async function fixture(backendOverrides = {}, { realRuntime = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-companion-http-'));
  const companion = createCompanionSettings({ root });
  const calls = { configured: 0, model: 0, commit: 0, interact: 0, refresh: 0 };
  let policy = { ...originalPolicy };
  const mockProactive = {
    busy: false,
    async settings() { return { ...policy }; },
    async status() { return { backoffMultiplier: 1, unansweredCount: 0 }; },
    async configure(value) { policy = { ...value }; return { policy, status: await this.status() }; },
    async interact() { calls.interact++; },
    async interrupt() {},
    async refreshCompanionSettings() { calls.refresh++; },
    async close() {},
  };
  const proactive = realRuntime ? createProactiveRuntime({ root, getCompanionSettings: () => companion.get(), generate: async () => { calls.model++; throw new Error('unexpected background model call'); }, schedule: () => () => {} }) : mockProactive;
  if (realRuntime) await proactive.configure(originalPolicy);
  const backend = {
    companion,
    async configured() { calls.configured++; return true; },
    async chat(input) { calls.model++; return { text: 'synthetic reply', model: 'fixture', source: 'codex' }; },
    async close() {},
    ...backendOverrides,
  };
  const screenBudget = {
    async status() { return { remaining: 33, limit: 36, used: 3, minIntervalSeconds: 300, canSend: true, allowed: true, nextAllowedAt: null }; },
    async commit() { calls.commit++; },
  };
  const app = createChatServer({ backend, token: 'SYNTHETIC-COMPANION-TOKEN', port: 0, proactiveRuntime: proactive, screenBudget });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  return {
    ...app, root, companion, calls, proactive,
    request(route, body, extraHeaders = {}) { return fetch(url + route, { method: body === undefined ? 'GET' : 'POST', headers: { ...headers, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); },
    async close() { await app.close(); await fs.rm(root, { recursive: true, force: true }); },
  };
}

function jpeg() {
  const bytes = Buffer.from([0xff,0xd8,0xff,0xc0,0x00,0x0b,0x08,0,8,0,8,0x01,0x01,0x11,0x00,0xff,0xd9]);
  return { data: bytes.toString('base64'), mimeType: 'image/jpeg' };
}

test('every short command displayed in companion help is handled locally', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'whale-companion-help-'));
  try {
    const settings = await createCompanionSettings({ root }).get();
    const help = formatCompanionSettings(settings);
    const commands = help.split('可以直接说：\n')[1].split(/[\n／]/).filter(Boolean);
    assert.ok(commands.length >= 10);
    for (const command of commands) assert.ok(parseCompanionCommand(command), `help command must remain local: ${command}`);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('companion settings require local authentication and preserve settings on invalid writes', async () => {
  const app = await fixture();
  try {
    assert.equal((await app.request('/api/companion-settings', undefined, { Authorization: '' })).status, 401);
    assert.equal((await app.request('/api/companion-settings', undefined, { Origin: 'https://example.com' })).status, 403);
    assert.equal((await app.request('/api/companion-settings', { preferences: { preferredName: '阿蓝' } })).status, 200);
    assert.equal((await app.companion.get()).preferences.preferredName, '阿蓝');
    const snapshot = await app.companion.get();
    assert.equal((await app.request('/api/companion-settings', { unexpected: true })).status, 400);
    assert.deepEqual(await app.companion.get(), snapshot);
    assert.equal(app.calls.model, 0);
    assert.equal(app.calls.configured, 0);
  } finally { await app.close(); }
});

test('local companion commands ignore attached valid and invalid pixels without model, auth lookup or screenshot dispatch', async () => {
  const app = await fixture({ async configured() { throw new Error('must-not-check-provider'); }, async chat() { throw new Error('must-not-use-model'); } });
  try {
    for (const screen of [jpeg(), { mimeType: 'image/jpeg', data: 'invalid-image' }]) {
      const response = await app.request('/api/chat', { message: '叫我阿蓝', screen, activity: { app: 'Private App', title: 'not-a-topic' }, history: [{ role: 'user', content: 'not-a-topic' }] });
      assert.equal(response.status, 200);
      const value = await response.json();
      assert.equal(value.source, 'local');
      assert.equal(value.modelCalls, 0);
      assert.equal(value.screenUsed, false);
      assert.equal(value.screenReason, 'local_command');
      assert.equal(value.awareness.activityUsed, false);
      assert.equal(value.awareness.screenRequested, true);
    }
    assert.equal((await app.companion.get()).preferences.preferredName, '阿蓝');
    assert.deepEqual(await app.companion.recentContext(), []);
    assert.equal(app.calls.commit, 0);
    assert.equal(app.calls.model, 0);
    const restored = createCompanionSettings({ root: app.root });
    assert.equal((await restored.get()).preferences.preferredName, '阿蓝');
  } finally { await app.close(); }
});

test('quoted commands remain ordinary user text and cannot change companion preferences', async () => {
  let submitted;
  const app = await fixture({ async chat(input) { submitted = input; return { text: 'quoted-command-discussion', source: 'codex', model: 'fixture' }; } });
  try {
    const message = '朋友说“叫我小王”，你怎么看？';
    const response = await app.request('/api/chat', { message });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).source, 'codex');
    assert.equal(submitted.message, message);
    assert.equal((await app.companion.get()).preferences.preferredName, '你');
    assert.equal(app.calls.interact, 1);
  } finally { await app.close(); }
});

test('focus controls may quiet proactive work during a foreground reply, while identity changes wait for that reply', async () => {
  let release, began;
  const entered = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const app = await fixture({ async chat(input, signal) { began(); await gate; assert.equal(signal.aborted, false); return { text: 'foreground-completed', source: 'codex', model: 'fixture' }; } });
  let pending;
  try {
    pending = app.request('/api/chat', { message: 'a genuine foreground request' });
    await entered;
    assert.equal((await app.request('/api/companion-settings', { preferences: { preferredName: '新称呼' } })).status, 409);
    const focus = await app.request('/api/companion/focus', { minutes: 60 });
    assert.equal(focus.status, 200);
    const settings = (await focus.json()).settings;
    assert.ok(Date.parse(settings.focusUntil) > Date.now() + 59 * 60_000);
    assert.equal(settings.preferences.preferredName, '你');
    release();
    assert.equal((await pending).status, 200);
    assert.equal(app.calls.refresh, 1);
  } finally { release(); if (pending) await pending; await app.close(); }
});

test('legacy five-field proactive policy writes do not reset quiet hours, focus, nickname or retreat settings', async () => {
  const app = await fixture({}, { realRuntime: true });
  try {
    await app.request('/api/companion-settings', { preferences: { preferredName: '阿蓝' }, quiet: { enabled: true, start: '22:30', end: '07:45' }, backoff: { enabled: false } });
    assert.equal((await app.request('/api/companion/focus', { minutes: 30 })).status, 200);
    const before = await app.companion.get();
    const response = await app.request('/api/proactive-policy', { ...originalPolicy, minIntervalSeconds: 120, maxIntervalSeconds: 900 });
    assert.equal(response.status, 200);
    assert.deepEqual(await app.companion.get(), before);
    assert.equal((await app.request('/api/companion/resume', {})).status, 200);
    const after = await app.companion.get();
    assert.equal(after.focusUntil, null);
    assert.equal(after.preferences.preferredName, '阿蓝');
    assert.deepEqual(after.quiet, before.quiet);
    assert.deepEqual(after.backoff, before.backoff);
    assert.equal((await app.request('/api/companion/focus', { minutes: 0, prompt: 'not-accepted' })).status, 400);
  } finally { await app.close(); }
});

test('resume and legacy policy saves share one control slot so an older snapshot cannot overwrite a newer interval', async () => {
  const app = await fixture();
  let entered, release;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const configure = app.companion.configure;
  let pending;
  try {
    await app.request('/api/proactive-policy', { ...originalPolicy, enabled: false });
    app.companion.configure = async patch => { entered(); await gate; return configure(patch); };
    pending = app.request('/api/companion/resume', {});
    await began;
    const changed = { ...originalPolicy, minIntervalSeconds: 120, maxIntervalSeconds: 900 };
    assert.equal((await app.request('/api/proactive-policy', changed)).status, 409);
    release();
    assert.equal((await pending).status, 200);
    assert.equal((await app.request('/api/proactive-policy', changed)).status, 200);
    assert.deepEqual(await app.proactive.settings(), changed);
  } finally { release(); if (pending) await pending; await app.close(); }
});

test('shutdown lets an accepted setting save refresh its runtime before closing that runtime', async () => {
  const app = await fixture();
  let entered, release, runtimeClosed = false, closePromise;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const configure = app.companion.configure;
  app.companion.configure = async patch => { entered(); await gate; return configure(patch); };
  app.proactive.refreshCompanionSettings = async () => { assert.equal(runtimeClosed, false); };
  app.proactive.close = async () => { runtimeClosed = true; };
  let pending;
  try {
    pending = app.request('/api/companion/focus', { minutes: 10 });
    await began;
    closePromise = app.close();
    assert.equal(app.canStartProactive(), false);
    assert.equal(runtimeClosed, false);
    release();
    assert.equal((await pending).status, 200);
    await closePromise;
    assert.equal(runtimeClosed, true);
  } finally { release(); if (pending) await pending; if (closePromise) await closePromise; else await app.close(); }
});
