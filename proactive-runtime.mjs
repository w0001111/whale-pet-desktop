import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { shanghaiDay } from './screen-policy.mjs';

export const DEFAULT_PROACTIVE_POLICY = Object.freeze({ enabled: false, mode: 'economy', minIntervalSeconds: 60, maxIntervalSeconds: 600, dailyAiLimit: 24 });
const HEARTBEAT_MS = 60_000;
const ECONOMY_AI_INTERVAL_MS = 3_600_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
const DEFAULT_COMPANION = Object.freeze({ preferences: { preferredName: '你' }, quiet: { enabled: false, start: '23:00', end: '08:00' }, focusUntil: null, backoff: { enabled: false, afterUnanswered: 3, maxMultiplier: 8, maxIntervalSeconds: 3600 } });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const localMessages = Object.freeze([
  '老板，路过给你挥一下尾巴～🐋',
  '我在旁边陪着，老板忙完再理我就好。',
  '大肥鱼冒个泡：伸伸肩膀，喝口水也不错。',
  '老板今天想摸摸鲸鱼，还是继续专心做事？',
  '我只是来蹭一下存在感，尾巴已经摆好了。',
  '桌面小鲸鱼已就位，陪老板安静待一会儿。',
]);
const fail = code => Object.assign(new Error(code), { code });
const copy = value => structuredClone(value);
const blankUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
const safeCode = error => typeof error?.code === 'string' && /^[A-Z_]{2,70}$/.test(error.code) ? error.code : 'PROACTIVE_GENERATION_FAILED';

export function validateProactivePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !Object.hasOwn(DEFAULT_PROACTIVE_POLICY, key)) ||
      typeof value.enabled !== 'boolean' || !['economy', 'ai'].includes(value.mode) ||
      !Number.isSafeInteger(value.minIntervalSeconds) || value.minIntervalSeconds < 60 || value.minIntervalSeconds > 86400 ||
      !Number.isSafeInteger(value.maxIntervalSeconds) || value.maxIntervalSeconds < value.minIntervalSeconds || value.maxIntervalSeconds > 86400 ||
      !Number.isSafeInteger(value.dailyAiLimit) || value.dailyAiLimit < 0 || value.dailyAiLimit > 10000) throw fail('INVALID_PROACTIVE_POLICY');
  return { enabled: value.enabled, mode: value.mode, minIntervalSeconds: value.minIntervalSeconds, maxIntervalSeconds: value.maxIntervalSeconds, dailyAiLimit: value.dailyAiLimit };
}

function normalizedUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const result = blankUsage();
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const count = value[key] ?? 0;
    if (!Number.isFinite(count) || count < 0) return null;
    result[key] = count;
  }
  result.totalTokens = Math.max(Object.values(result).reduce((a, b) => a + b, 0), Number.isFinite(value.totalTokens) ? value.totalTokens : 0);
  return result.totalTokens > 0 ? result : null;
}

function normalizedCompanion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('BAD_COMPANION_SETTINGS');
  const preferences = { ...DEFAULT_COMPANION.preferences, ...value.preferences };
  const quiet = { ...DEFAULT_COMPANION.quiet, ...value.quiet };
  const backoff = { ...DEFAULT_COMPANION.backoff, ...value.backoff };
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (typeof preferences.preferredName !== 'string' || !preferences.preferredName.trim() || preferences.preferredName.length > 80 || /[\x00-\x1f\x7f]/.test(preferences.preferredName) ||
      typeof quiet.enabled !== 'boolean' || !time.test(quiet.start) || !time.test(quiet.end) || quiet.start === quiet.end ||
      typeof backoff.enabled !== 'boolean' || !Number.isSafeInteger(backoff.afterUnanswered) || backoff.afterUnanswered < 1 ||
      !Number.isSafeInteger(backoff.maxMultiplier) || backoff.maxMultiplier < 1 || backoff.maxMultiplier > 1024 ||
      !Number.isSafeInteger(backoff.maxIntervalSeconds) || backoff.maxIntervalSeconds < 60 || backoff.maxIntervalSeconds > 86400 ||
      (value.focusUntil != null && (typeof value.focusUntil !== 'string' || !Number.isFinite(Date.parse(value.focusUntil))))) throw fail('BAD_COMPANION_SETTINGS');
  return { preferences: { preferredName: preferences.preferredName.trim() }, quiet, focusUntil: value.focusUntil ?? null, backoff };
}

function quietAt(timestamp, quiet) {
  if (!quiet.enabled) return null;
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minutes(quiet.start) * 60_000, end = minutes(quiet.end) * 60_000;
  const dayStart = Math.floor((timestamp + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS;
  const elapsed = timestamp - dayStart;
  if (start < end) return elapsed >= start && elapsed < end ? dayStart + end : null;
  if (elapsed >= start) return dayStart + DAY_MS + end;
  return elapsed < end ? dayStart + end : null;
}

function validStoredMessage(message) {
  if (!message || !UUID.test(message.id || '') || typeof message.text !== 'string' || message.text.length > 1000 || !['local', 'codex','api'].includes(message.source)) return false;
  if (message.countsForBackoff !== undefined && typeof message.countsForBackoff !== 'boolean') return false;
  if (message.deliveryEpoch !== undefined && (!Number.isSafeInteger(message.deliveryEpoch) || message.deliveryEpoch < 0)) return false;
  return !['deliveredAt', 'suppressedAt'].some(key => message[key] !== undefined && (typeof message[key] !== 'string' || !Number.isFinite(Date.parse(message[key]))));
}

/**
 * Host scheduling and UI inbox only. `generate` is one bounded call owned by
 * the portable app host; this module has no LLM, screenshot or tools API.
 * Inject the official Cordis timeout as schedule(callback, milliseconds).
 */
export function createProactiveRuntime({ root, generate, canRun = () => true, getCompanionSettings = async () => DEFAULT_COMPANION, getProactiveBudget = async () => ({ blocked: false }), schedule = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds); timer.unref?.(); return () => clearTimeout(timer);
}, now = () => Date.now(), random = Math.random } = {}) {
  if (!path.isAbsolute(root || '') || typeof generate !== 'function' || typeof canRun !== 'function' || typeof getCompanionSettings !== 'function' || typeof getProactiveBudget !== 'function' || typeof schedule !== 'function' || typeof now !== 'function' || typeof random !== 'function') throw fail('BAD_PROACTIVE_CONFIG');
  const file = path.join(root, 'data', 'proactive.json');
  let state;
  let queue = Promise.resolve();
  let started = false;
  let closed = false;
  let cancellation;
  let epoch = 0;
  let scheduleEpoch = 0;
  let active = null;
  let lastPollAt = null;
  let lastInboxAt = null;
  let uiBusy = false;
  let typing = false;
  let lastLocalIndex = -1;
  let companion = normalizedCompanion(DEFAULT_COMPANION);
  let companionFingerprint = null;
  let companionAvailable = true;
  let budget = { blocked: false, reason: null, nextAllowedAt: null, dailyTokenLimit: 0 };
  let budgetFingerprint = null;
  const enqueue = operation => {
    const pending = queue.then(operation);
    queue = pending.catch(() => {});
    return pending;
  };
  const iso = timestamp => new Date(timestamp).toISOString();
  const online = () => lastPollAt !== null && now() - lastPollAt >= 0 && now() - lastPollAt <= HEARTBEAT_MS;
  const randomUnit = () => { const value = random(); return Number.isFinite(value) ? Math.max(0, Math.min(0.999999999999, value)) : 0; };
  const clearTimer = () => { scheduleEpoch++; cancellation?.(); cancellation = undefined; };
  const mayRun = async () => { try { return !!(await canRun()); } catch { return false; } };
  async function readBudget() {
    let next;
    try {
      const value = await getProactiveBudget();
      if (!value || typeof value.blocked !== 'boolean') throw fail('BAD_USAGE_GATE');
      const reason = ['token_budget', 'usage_unknown', 'usage_unavailable'].includes(value.reason) ? value.reason : value.blocked ? 'usage_unavailable' : null;
      const until = typeof value.nextAllowedAt === 'string' && Number.isFinite(Date.parse(value.nextAllowedAt)) && Date.parse(value.nextAllowedAt) > now() ? value.nextAllowedAt : null;
      next = { ...value, reason, nextAllowedAt: until };
    } catch { next = { blocked: true, reason: 'usage_unavailable', nextAllowedAt: null }; }
    const fingerprint = JSON.stringify([next.blocked, next.reason, next.nextAllowedAt, next.dailyTokenLimit]);
    const changed = budgetFingerprint !== null && fingerprint !== budgetFingerprint;
    budget = next; budgetFingerprint = fingerprint;
    return changed;
  }

  async function persist() {
    const directory = path.dirname(file);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('PROACTIVE_STORAGE_UNSAFE');
    const temporary = `${file}.${randomUUID()}.tmp`;
    state.updatedAt = iso(now());
    try {
      await fs.writeFile(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
      await fs.rename(temporary, file);
      await fs.chmod(file, 0o600);
    } catch { throw fail('PROACTIVE_STORAGE_FAILED'); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function load() {
    if (state) return;
    try {
      const info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024) throw fail('PROACTIVE_STORAGE_UNSAFE');
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      const policy = validateProactivePolicy(value.policy);
      if (value.version !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(value.day) ||
          !['aiAttempts', 'aiSucceeded', 'localSent'].every(key => Number.isSafeInteger(value[key]) && value[key] >= 0) ||
          !Number.isFinite(value.lastAiAttemptAt) || value.lastAiAttemptAt < 0 ||
          (value.unansweredCount !== undefined && (!Number.isSafeInteger(value.unansweredCount) || value.unansweredCount < 0)) ||
          (value.deliveryEpoch !== undefined && (!Number.isSafeInteger(value.deliveryEpoch) || value.deliveryEpoch < 0)) ||
          (value.lastUserAt != null && (typeof value.lastUserAt !== 'string' || !Number.isFinite(Date.parse(value.lastUserAt)))) ||
          !value.usage || !Object.keys(blankUsage()).every(key => Number.isFinite(value.usage[key]) && value.usage[key] >= 0) ||
          !Array.isArray(value.messages) || value.messages.length > 100 || value.messages.some(message => !validStoredMessage(message))) throw fail('PROACTIVE_STORAGE_INVALID');
      state = { ...value, policy, unansweredCount: value.unansweredCount ?? 0, lastUserAt: value.lastUserAt ?? null, deliveryEpoch: value.deliveryEpoch ?? 0 };
    } catch (error) {
      if (error.code !== 'ENOENT') throw fail('PROACTIVE_STORAGE_UNAVAILABLE');
      state = { version: 1, policy: { ...DEFAULT_PROACTIVE_POLICY }, createdAt: iso(now()), updatedAt: iso(now()), day: shanghaiDay(now()), aiAttempts: 0, aiSucceeded: 0, localSent: 0, usage: blankUsage(), lastAiAttemptAt: 0, nextAt: null, reason: 'disabled', lastError: null, messages: [], unansweredCount: 0, lastUserAt: null, deliveryEpoch: 0 };
    }
  }
  function rollDay() {
    const day = shanghaiDay(now());
    if (state.day === day) return false;
    state.day = day; state.aiAttempts = 0; state.aiSucceeded = 0; state.localSent = 0; state.usage = blankUsage();
    return true;
  }
  function invalidateDelivery(reason) {
    epoch++; state.deliveryEpoch++; clearTimer(); state.nextAt = null;
    if (active) active.controller.abort(fail(reason));
  }
  async function readCompanion() {
    try {
      const raw = await getCompanionSettings();
      const value = normalizedCompanion(raw);
      // Unused companion settings still invalidate a pending reply when changed
      // (for example clearing recent topics); their contents never enter prompts.
      const fingerprint = JSON.stringify({ runtime: value, tone: raw.preferences?.tone ?? null, recentTopics: raw.recentTopics ?? null });
      const canonical = encoded => {
        const decoded = JSON.parse(encoded);
        if (!(Date.parse(decoded.runtime.focusUntil) > now())) decoded.runtime.focusUntil = null;
        return JSON.stringify(decoded);
      };
      // The settings store may omit an expired focus. Its natural expiration
      // must not postpone an already planned post-focus reply a second time.
      const changed = !companionAvailable || (companionFingerprint !== null && canonical(companionFingerprint) !== canonical(fingerprint));
      companion = value; companionFingerprint = fingerprint; companionAvailable = true;
      if (changed) invalidateDelivery('PROACTIVE_SETTINGS_CHANGED');
      return changed;
    } catch {
      const changed = companionAvailable;
      companionAvailable = false;
      if (changed) invalidateDelivery('PROACTIVE_SETTINGS_UNAVAILABLE');
      state.reason = 'settings_unavailable'; state.lastError = 'COMPANION_SETTINGS_UNAVAILABLE';
      return changed;
    }
  }
  function restrictions(timestamp = now()) {
    const quietUntil = quietAt(timestamp, companion.quiet);
    const focusTime = companion.focusUntil ? Date.parse(companion.focusUntil) : 0;
    const focusActive = focusTime > timestamp;
    let until = Math.max(quietUntil || 0, focusActive ? focusTime : 0);
    // A focus period can end inside the next quiet window. Join the two so the
    // next deadline starts after all currently contiguous restrictions end.
    if (until) until = Math.max(until, quietAt(until, companion.quiet) || 0);
    return { quietActive: quietUntil !== null, focusActive, focusUntil: focusActive ? iso(focusTime) : null, nextAllowedAt: until ? iso(until) : null, reason: focusActive ? 'focus' : quietUntil !== null ? 'quiet_hours' : null };
  }
  function intervals() {
    const { backoff } = companion;
    const multiplier = backoff.enabled ? Math.min(backoff.maxMultiplier, 2 ** Math.min(30, Math.floor(state.unansweredCount / backoff.afterUnanswered))) : 1;
    return { backoffMultiplier: multiplier,
      effectiveMinIntervalSeconds: backoff.enabled ? Math.min(state.policy.minIntervalSeconds * multiplier, Math.max(state.policy.minIntervalSeconds, backoff.maxIntervalSeconds)) : state.policy.minIntervalSeconds,
      effectiveMaxIntervalSeconds: backoff.enabled ? Math.min(state.policy.maxIntervalSeconds * multiplier, Math.max(state.policy.maxIntervalSeconds, backoff.maxIntervalSeconds)) : state.policy.maxIntervalSeconds };
  }
  function snapshotStatus() {
    const restriction = restrictions();
    return {
      enabled: state.policy.enabled, mode: state.policy.mode, nextAt: state.nextAt,
      uiOnline: online(), uiBusy, typing, generating: !!active,
      day: state.day, timezone: 'Asia/Shanghai', aiUsedToday: state.aiAttempts,
      aiSucceededToday: state.aiSucceeded, localMessagesToday: state.localSent,
      dailyAiLimit: state.policy.dailyAiLimit, dailyAiUnlimited: state.policy.dailyAiLimit === 0,
      aiRemainingToday: state.policy.dailyAiLimit === 0 ? null : Math.max(0, state.policy.dailyAiLimit - state.aiAttempts),
      usage: copy(state.usage), reason: !state.policy.enabled ? 'disabled' : !online() ? 'ui_offline' : !companionAvailable ? 'settings_unavailable' : restriction.reason || (budget.blocked ? budget.reason : state.reason), lastError: state.lastError,
      quietActive: restriction.quietActive, focusActive: restriction.focusActive, focusUntil: restriction.focusUntil, nextAllowedAt: restriction.nextAllowedAt,
      unansweredCount: state.unansweredCount, lastUserAt: state.lastUserAt, ...intervals(),
      tokenBudgetPaused: budget.blocked, tokenBudgetReason: budget.reason, dailyTokenLimit: budget.dailyTokenLimit ?? 0, recordedTokensToday: budget.usedTokens ?? null, remainingRecordedTokens: budget.remainingTokens ?? null,
    };
  }
  async function armNext() {
    clearTimer();
    await readCompanion();
    await readBudget();
    if (!started || closed || !state.policy.enabled || !online() || active || !companionAvailable) {
      state.nextAt = null;
      if (!state.policy.enabled) state.reason = 'disabled';
      else if (!online()) state.reason = 'ui_offline';
      else if (!companionAvailable) state.reason = 'settings_unavailable';
      await persist(); return;
    }
    if (budget.blocked && !budget.nextAllowedAt) { state.nextAt = null; state.reason = budget.reason; await persist(); return; }
    const { effectiveMinIntervalSeconds: minIntervalSeconds, effectiveMaxIntervalSeconds: maxIntervalSeconds } = intervals();
    const seconds = minIntervalSeconds + Math.floor(randomUnit() * (maxIntervalSeconds - minIntervalSeconds + 1));
    const restriction = restrictions();
    let deadline = Math.max(now(), Date.parse(restriction.nextAllowedAt) || 0, budget.blocked ? Date.parse(budget.nextAllowedAt) || 0 : 0) + seconds * 1000;
    // Also avoid choosing an otherwise normal deadline inside a future night.
    const futureRestriction = restrictions(deadline);
    if (futureRestriction.nextAllowedAt) {
      // The original interval has already elapsed at this point. Applying a
      // long base interval again can repeatedly land inside the next night.
      const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
      const awakeWindow = ((minutes(companion.quiet.start) - minutes(companion.quiet.end) + 1440) % 1440) * 60_000;
      const jitter = (60 + Math.floor(randomUnit() * 541)) * 1000;
      deadline = Date.parse(futureRestriction.nextAllowedAt) + Math.min(jitter, companion.quiet.enabled ? awakeWindow - 1 : jitter);
    }
    if (restriction.reason) state.reason = restriction.reason;
    else if (budget.blocked) state.reason = budget.reason;
    else if (['ui_offline', 'quiet_hours', 'focus', 'interrupted', 'disabled', 'settings_unavailable', 'token_budget', 'usage_unknown', 'usage_unavailable'].includes(state.reason)) state.reason = 'ready';
    state.nextAt = iso(deadline);
    await persist();
    scheduleDeadline(deadline);
  }
  function scheduleDeadline(deadline) {
    const scheduledEpoch = epoch;
    const scheduledTimer = scheduleEpoch;
    // A distant persisted focus time must never overflow the host's timer into
    // a 1 ms wakeup loop. Recheck at most daily until the true deadline is near.
    cancellation = schedule(() => fire({ expectedEpoch: scheduledEpoch, expectedScheduleEpoch: scheduledTimer, expectedDeadline: deadline }).catch(() => {}), Math.min(Math.max(0, deadline - now()), DAY_MS));
  }
  function addUsage(usage) { if (usage) for (const key of Object.keys(state.usage)) state.usage[key] += usage[key] || 0; }

  async function fire({ expectedEpoch = epoch, expectedScheduleEpoch, expectedDeadline, preview = false } = {}) {
    let job;
    let refusal;
    await enqueue(async () => {
      await load(); rollDay();
      if (closed || (!preview && !started) || expectedEpoch !== epoch || (expectedScheduleEpoch !== undefined && expectedScheduleEpoch !== scheduleEpoch) || active) { refusal = 'PROACTIVE_BUSY'; return; }
      if (!preview && !state.policy.enabled) { refusal = 'PROACTIVE_DISABLED'; return; }
      clearTimer(); state.nextAt = null;
      const settingsChanged = await readCompanion();
      await readBudget();
      if (!companionAvailable) { await armNext(); refusal = 'PROACTIVE_SETTINGS_UNAVAILABLE'; return; }
      if (settingsChanged && !preview) { await armNext(); refusal = 'PROACTIVE_SETTINGS_CHANGED'; return; }
      if (!online()) { state.reason = 'ui_offline'; await persist(); refusal = 'PROACTIVE_UI_OFFLINE'; return; }
      if (budget.blocked) { state.reason = budget.reason; await armNext(); refusal = budget.reason === 'usage_unavailable' ? 'PROACTIVE_USAGE_UNAVAILABLE' : 'PROACTIVE_TOKEN_BUDGET'; return; }
      if (!preview && Number.isFinite(expectedDeadline) && now() < expectedDeadline) {
        state.nextAt = iso(expectedDeadline); await persist(); scheduleDeadline(expectedDeadline);
        refusal = 'PROACTIVE_NOT_DUE'; return;
      }
      const restriction = restrictions();
      if (!preview && restriction.reason) { state.reason = restriction.reason; await armNext(); refusal = restriction.reason === 'focus' ? 'PROACTIVE_FOCUS' : 'PROACTIVE_QUIET_HOURS'; return; }
      if (uiBusy || typing || !(await mayRun())) {
        state.reason = uiBusy || typing ? 'user_busy' : 'work_busy'; await armNext(); refusal = 'PROACTIVE_BUSY'; return;
      }
      const useAi = state.policy.mode === 'ai' || state.lastAiAttemptAt === 0 || now() - state.lastAiAttemptAt >= ECONOMY_AI_INTERVAL_MS;
      if (useAi && state.policy.dailyAiLimit !== 0 && state.aiAttempts >= state.policy.dailyAiLimit && state.policy.mode === 'ai') {
        state.reason = 'daily_limit'; await armNext(); refusal = 'PROACTIVE_DAILY_LIMIT'; return;
      }
      const ai = useAi && (state.policy.dailyAiLimit === 0 || state.aiAttempts < state.policy.dailyAiLimit);
      const controller = new AbortController();
      let settle;
      const done = new Promise(resolve => { settle = resolve; });
      job = { controller, epoch, deliveryEpoch: state.deliveryEpoch, preview, ai, day: state.day, attemptedAt: iso(now()), done, settle, preferredName: companion.preferences.preferredName,
        recentMessages: state.messages.slice(-5).map(message => ({ text: message.text.slice(0, 800), source: message.source })) };
      active = job;
      state.reason = ai ? 'generating' : 'local_message'; state.lastError = null;
      if (ai) { state.aiAttempts++; state.lastAiAttemptAt = now(); }
      // Commit attempt count before dispatch; failures and cancellation still
      // consume an attempt and cannot be made free by restarting the host.
      try { await persist(); } catch (error) { active = null; job.settle(); job = undefined; throw error; }
    });
    if (!job) { if (preview) throw fail(refusal || 'PROACTIVE_BUSY'); return null; }
    const work = (async () => {
      let value, failure;
      try {
        job.controller.signal.throwIfAborted();
        if (job.ai) {
          value = await generate({ signal: job.controller.signal, recentMessages: copy(job.recentMessages) });
          const usage = normalizedUsage(value?.usage);
          if (!['codex','api'].includes(value?.source) || typeof value.text !== 'string' || !value.text.trim() || !usage || value.modelCalls !== 1) throw fail('PROACTIVE_RESULT_INVALID');
          value = { text: value.text.trim().slice(0, 800), source: value.source, model: typeof value.model === 'string' ? value.model.slice(0, 80) : undefined, usage };
        } else {
          let index = Math.floor(randomUnit() * localMessages.length);
          if (index === lastLocalIndex) index = (index + 1) % localMessages.length;
          lastLocalIndex = index;
          value = { text: localMessages[index].replaceAll('老板', () => job.preferredName), source: 'local', model: 'local' };
        }
      } catch (error) { failure = error; }
      return enqueue(async () => {
        rollDay();
        await readCompanion();
        const restriction = restrictions();
        const busy = uiBusy || typing || !(await mayRun());
        const blocked = !companionAvailable || (!job.preview && restriction.reason) || busy;
        const interrupted = job.controller.signal.aborted || job.epoch !== epoch || closed || !online() || blocked;
        const usage = normalizedUsage(value?.usage) || normalizedUsage(failure?.partial?.usage);
        if (job.day === state.day) addUsage(usage);
        state.lastAttempt = { at: job.attemptedAt, day: job.day, ai: job.ai, usage, status: interrupted ? 'interrupted' : failure ? 'failed' : 'completed' };
        let message = null;
        if (!interrupted && !failure && value) {
          message = { id: randomUUID(), at: iso(now()), budgetDay: job.day, countsForBackoff: !job.preview, deliveryEpoch: job.deliveryEpoch, ...value };
          state.messages.push(message); state.messages = state.messages.slice(-100);
          if (job.day === state.day) { if (job.ai) state.aiSucceeded++; else state.localSent++; }
          state.reason = 'ready'; state.lastError = null;
        } else if (!interrupted) { state.reason = 'generation_failed'; state.lastError = safeCode(failure); }
        else state.reason = !state.policy.enabled ? 'disabled' : !companionAvailable ? 'settings_unavailable' : !job.preview && restriction.reason ? restriction.reason : busy ? (uiBusy || typing ? 'user_busy' : 'work_busy') : 'interrupted';
        if (active === job) active = null;
        await armNext();
        if (preview && !message) throw fail(interrupted ? 'PROACTIVE_INTERRUPTED' : state.lastError || 'PROACTIVE_GENERATION_FAILED');
        return message;
      });
    })();
    // The settlement promise exists from reservation onward. A foreground
    // interrupt cannot return during the queue-to-dispatch microtask gap.
    try { return await work; }
    finally { job.settle(); }
  }

  async function cancelCurrent(reason, { interaction = false, refresh = false } = {}) {
    let waiting;
    await enqueue(async () => {
      await load(); epoch++; clearTimer(); state.nextAt = null;
      if (refresh) await readCompanion();
      if (interaction || refresh) state.deliveryEpoch++;
      if (interaction) { state.unansweredCount = 0; state.lastUserAt = iso(now()); }
      if (active) { active.controller.abort(fail(reason)); waiting = active.done; }
      state.reason = state.policy.enabled ? 'interrupted' : 'disabled';
      await persist();
    });
    await waiting?.catch(() => {});
  }

  return {
    // Migration must see the persisted day before status/start rolls it forward.
    usageMigrationSnapshot() { return enqueue(async () => { await load(); return {day:state.day,usage:copy(state.usage),aiAttempts:state.aiAttempts}; }); },
    async start() {
      return enqueue(async () => {
        if (closed) throw fail('PROACTIVE_CLOSED');
        await load(); rollDay(); started = true; epoch++;
        // A stored deadline is informative only; never replay a missed wakeup.
        state.nextAt = null; await armNext(); return { policy: copy(state.policy), status: snapshotStatus() };
      });
    },
    settings() { return enqueue(async () => { await load(); return copy(state.policy); }); },
    status() { return enqueue(async () => { await load(); const changed = rollDay(); const companionChanged = await readCompanion(); const budgetChanged = await readBudget(); if (companionChanged || budgetChanged) await armNext(); else if (changed) await persist(); return snapshotStatus(); }); },
    async configure(value) {
      const policy = validateProactivePolicy(value);
      let waiting;
      await enqueue(async () => {
        if (closed) throw fail('PROACTIVE_CLOSED');
        await load(); rollDay(); invalidateDelivery('PROACTIVE_SETTINGS_CHANGED');
        if (active) waiting = active.done;
        const previousPolicy = state.policy;
        state.policy = policy; state.nextAt = null; state.reason = policy.enabled ? 'ready' : 'disabled';
        try { await persist(); }
        catch (error) { state.policy = previousPolicy; state.reason = 'storage_error'; throw error; }
      });
      await waiting?.catch(() => {});
      return enqueue(async () => { await armNext(); return { policy: copy(state.policy), status: snapshotStatus() }; });
    },
    inbox(after, presence = {}) {
      return enqueue(async () => {
        if (closed) throw fail('PROACTIVE_CLOSED');
        await load(); let changed = rollDay();
        if (after !== undefined && after !== null && after !== '' && after !== '0' && !UUID.test(after)) throw fail('BAD_PROACTIVE_CURSOR');
        const timestamp = now();
        const continuous = lastInboxAt !== null && timestamp - lastInboxAt >= 0 && timestamp - lastInboxAt <= HEARTBEAT_MS;
        lastInboxAt = timestamp; lastPollAt = timestamp; uiBusy = presence.uiBusy === true; typing = presence.typing === true;
        changed = (await readCompanion()) || changed;
        const budgetChanged = await readBudget();
        const latest = state.messages.at(-1)?.id || '0';
        let messages = [];
        let resynchronized = !continuous;
        if (continuous && after === '0') messages = state.messages;
        else if (continuous && after) {
          const index = state.messages.findIndex(message => message.id === after);
          if (index >= 0) messages = state.messages.slice(index + 1);
          else resynchronized = true;
        }
        const restriction = restrictions(timestamp);
        const busy = uiBusy || typing || !(await mayRun());
        const blocked = !state.policy.enabled || !companionAvailable || restriction.reason || busy;
        if (blocked || resynchronized) {
          // Synchronizing or blocking is a skip, not a delayed notification or
          // evidence that the user ignored a message. Old bubbles never catch up.
          for (const message of state.messages) if (!message.deliveredAt && !message.suppressedAt) { message.suppressedAt = iso(timestamp); changed = true; }
          messages = [];
          if (blocked) state.reason = !state.policy.enabled ? 'disabled' : !companionAvailable ? 'settings_unavailable' : restriction.reason || (uiBusy || typing ? 'user_busy' : 'work_busy');
        } else {
          if (['user_busy', 'work_busy'].includes(state.reason)) { state.reason = 'ready'; changed = true; }
          messages = messages.filter(message => !message.suppressedAt && (message.deliveryEpoch ?? 0) === state.deliveryEpoch && (!state.lastUserAt || Date.parse(message.at) >= Date.parse(state.lastUserAt)));
          const previousMultiplier = intervals().backoffMultiplier;
          for (const message of messages) if (!message.deliveredAt) {
            message.deliveredAt = iso(timestamp); changed = true;
            if (message.countsForBackoff === true) state.unansweredCount = Math.min(1_000_000_000, state.unansweredCount + 1);
          }
          if (intervals().backoffMultiplier !== previousMultiplier && !active) { await armNext(); changed = false; }
        }
        if (started && state.policy.enabled && !active && (!continuous || !state.nextAt || budgetChanged)) { await armNext(); changed = false; }
        if (changed) await persist();
        return { messages: copy(messages), cursor: latest, resynchronized, status: snapshotStatus(), policy: copy(state.policy) };
      });
    },
    async preview(presence = {}) {
      await enqueue(async () => { await load(); lastPollAt = now(); uiBusy = presence.uiBusy === true; typing = presence.typing === true; });
      const message = await fire({ preview: true });
      return enqueue(async () => ({ message: copy(message), cursor: state.messages.at(-1)?.id || '0', status: snapshotStatus(), policy: copy(state.policy) }));
    },
    async interrupt() {
      await cancelCurrent('PROACTIVE_INTERRUPTED');
      return enqueue(async () => { await armNext(); return snapshotStatus(); });
    },
    async interact() {
      await cancelCurrent('PROACTIVE_USER_INTERACTION', { interaction: true });
      return enqueue(async () => { await armNext(); return snapshotStatus(); });
    },
    async refreshCompanionSettings() {
      await cancelCurrent('PROACTIVE_SETTINGS_CHANGED', { refresh: true });
      return enqueue(async () => { await armNext(); return snapshotStatus(); });
    },
    get busy() { return !!active; },
    async close() {
      if (closed) return;
      closed = true; started = false;
      await cancelCurrent('PROACTIVE_CLOSED');
      await queue;
    },
  };
}
