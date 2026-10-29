import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { shanghaiDay } from './screen-policy.mjs';

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 30;
const MAX_SEEN = 100_000;
const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const KINDS = ['chat', 'proactive', 'task'];
const STATUSES = ['completed', 'failed', 'cancelled'];
const USAGE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'];
const COUNT_KEYS = ['modelCalls', 'requests', 'unknownUsageAttempts', 'unknownModelCallAttempts', 'unclassifiedRequests', ...STATUSES];
const fail = code => Object.assign(new Error(code), { code });
const clone = value => structuredClone(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const emptyUsage = () => Object.fromEntries(USAGE_KEYS.map(key => [key, 0]));
const emptyCounts = () => ({ usage: emptyUsage(), ...Object.fromEntries(COUNT_KEYS.map(key => [key, 0])) });
const emptyDay = () => ({ ...emptyCounts(), byKind: Object.fromEntries(KINDS.map(kind => [kind, emptyCounts()])) });
const startOfDay = day => Date.parse(`${day}T00:00:00+08:00`);
const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(startOfDay(day)) && shanghaiDay(startOfDay(day)) === day;
const validDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const coverageText = '仅统计本桌宠已记录的模型请求和已报告 token，不是 OpenAI/Codex 账户总用量或账户剩余额度。本功能启用前的普通聊天和任务可能未统计；单次响应可越过阈值，预算暂停后续主动消息，不是硬计费封顶。';

function policyOf(value) {
  if (!object(value) || Object.keys(value).some(key => key !== 'dailyTokenLimit') || !integer(value.dailyTokenLimit) || value.dailyTokenLimit > 1_000_000_000_000) throw fail('INVALID_USAGE_POLICY');
  return { dailyTokenLimit: value.dailyTokenLimit };
}
function usageOf(value) {
  if (value === undefined || value === null) return null;
  if (!object(value) || !USAGE_KEYS.some(key => Object.hasOwn(value, key))) return null;
  const usage = emptyUsage();
  for (const key of USAGE_KEYS) {
    if (value[key] !== undefined && !integer(value[key])) return null;
    usage[key] = value[key] ?? 0;
  }
  usage.totalTokens = Math.max(usage.totalTokens, usage.input + usage.output + usage.cacheRead + usage.cacheWrite);
  return USAGE_KEYS.every(key => integer(usage[key])) ? usage : null;
}
function validCounts(value, aggregate = false) {
  return object(value) && Object.keys(value).every(key => [...COUNT_KEYS, 'usage', ...(aggregate ? ['byKind'] : [])].includes(key)) && COUNT_KEYS.every(key => integer(value[key])) && object(value.usage) && Object.keys(value.usage).every(key => USAGE_KEYS.includes(key)) && USAGE_KEYS.every(key => integer(value.usage[key])) &&
    value.requests === value.unclassifiedRequests + STATUSES.reduce((sum, status) => sum + value[status], 0) && value.unknownUsageAttempts <= value.requests && value.unknownModelCallAttempts <= value.requests;
}
function add(target, entry) {
  target.requests += entry.requests;
  target.modelCalls += entry.modelCalls;
  target.unknownUsageAttempts += entry.unknownUsageAttempts;
  target.unknownModelCallAttempts += entry.unknownModelCallAttempts;
  target.unclassifiedRequests += entry.unclassifiedRequests;
  for (const key of STATUSES) target[key] += entry[key];
  for (const key of USAGE_KEYS) target.usage[key] += entry.usage[key];
  if (!validCounts(target, Object.hasOwn(target, 'byKind'))) throw fail('USAGE_LEDGER_CAPACITY');
}
function validateLedger(value) {
  if (!object(value) || Object.keys(value).some(key => !['version', 'createdAt', 'updatedAt', 'days', 'seen', 'seed'].includes(key)) || value.version !== 1 || !validDate(value.createdAt) || !validDate(value.updatedAt) || !object(value.days) || Object.keys(value.days).length > RETENTION_DAYS ||
      !object(value.seen) || Object.keys(value.seen).length > MAX_SEEN ||
      Object.entries(value.seen).some(([id, day]) => !/^[a-f0-9]{64}$/.test(id) || !validDay(day)) ||
      !object(value.seed) || typeof value.seed.applied !== 'boolean') throw fail('INVALID_USAGE_LEDGER');
  for (const [day, entry] of Object.entries(value.days)) {
    if (!validDay(day) || !validCounts(entry, true) || !object(entry.byKind) || Object.keys(entry.byKind).some(key => !KINDS.includes(key)) || !KINDS.every(kind => validCounts(entry.byKind[kind]))) throw fail('INVALID_USAGE_LEDGER');
    for (const key of COUNT_KEYS) if (entry[key] !== KINDS.reduce((sum, kind) => sum + entry.byKind[kind][key], 0)) throw fail('INVALID_USAGE_LEDGER');
    for (const key of USAGE_KEYS) if (entry.usage[key] !== KINDS.reduce((sum, kind) => sum + entry.byKind[kind].usage[key], 0)) throw fail('INVALID_USAGE_LEDGER');
  }
  const seedKeys = value.seed.applied ? ['applied', 'source', 'day', 'at', 'aiAttempts', 'usage'] : ['applied'];
  if (Object.keys(value.seed).some(key => !seedKeys.includes(key)) || (value.seed.applied && (value.seed.source !== 'proactive_v1_reported_aggregate' || !validDay(value.seed.day) || !validDate(value.seed.at) || !integer(value.seed.aiAttempts) || !usageOf(value.seed.usage)))) throw fail('INVALID_USAGE_LEDGER');
  return value;
}

/** Local reported-use accounting only. This module never dispatches a model. */
export function createUsageBudget({ root, now = () => Date.now() } = {}) {
  if (!path.isAbsolute(root || '') || typeof now !== 'function') throw fail('INVALID_USAGE_STORAGE');
  const directory = path.join(root, 'data');
  const policyFile = path.join(directory, 'usage-policy.json');
  const ledgerFile = path.join(directory, 'usage-ledger.json');
  let queue = Promise.resolve();
  let initialized = false;
  let policy = { dailyTokenLimit: 0 };
  let ledger;
  let available = false;
  let pending = new Map();
  let pendingSeed = null;
  let retryPolicyWrite = false;
  let retryLedgerWrite = false;
  const timestamp = () => {
    const value = now(); const result = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(result) || !Number.isFinite(new Date(result).getTime())) throw fail('INVALID_USAGE_CLOCK');
    return result;
  };
  const enqueue = operation => {
    const result = queue.then(operation); queue = result.catch(() => {}); return result;
  };
  async function checkDirectory() {
    const rootInfo = await fs.lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('UNSAFE_USAGE_STORAGE');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('UNSAFE_USAGE_STORAGE');
  }
  async function read(file, limit) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > limit) throw fail('INVALID_USAGE_STORAGE');
      return JSON.parse(await handle.readFile('utf8'));
    } finally { await handle.close(); }
  }
  async function write(file, value, limit) {
    try {
      await checkDirectory();
      try { const info = await fs.lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw fail('UNSAFE_USAGE_STORAGE'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const bytes = JSON.stringify(value, null, 2) + '\n';
      if (Buffer.byteLength(bytes) > limit) throw fail('USAGE_LEDGER_CAPACITY');
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.unlink(temporary).catch(() => {}); }
      if (file === policyFile) retryPolicyWrite = false;
      else retryLedgerWrite = false;
    } catch (error) {
      if (file === policyFile) retryPolicyWrite = true;
      else retryLedgerWrite = true;
      throw error;
    }
  }
  function prune(value, at) {
    const earliest = shanghaiDay(startOfDay(shanghaiDay(at)) - (RETENTION_DAYS - 1) * DAY_MS);
    let changed = false;
    for (const [day] of Object.entries(value.days)) if (day < earliest) { delete value.days[day]; changed = true; }
    for (const [id, day] of Object.entries(value.seen)) if (day < earliest) { delete value.seen[id]; changed = true; }
    return changed;
  }
  function apply(value, entry) {
    const hash = createHash('sha256').update(entry.id).digest('hex');
    if (Object.hasOwn(value.seen, hash)) return 'duplicate';
    const earliest = shanghaiDay(startOfDay(shanghaiDay(timestamp())) - (RETENTION_DAYS - 1) * DAY_MS);
    if (entry.day < earliest) return 'expired';
    if (Object.keys(value.seen).length >= MAX_SEEN) throw fail('USAGE_LEDGER_CAPACITY');
    const counts = { ...emptyCounts(), requests: 1, modelCalls: entry.modelCalls ?? 0, unknownModelCallAttempts: entry.modelCalls === undefined ? 1 : 0, unknownUsageAttempts: entry.usageIncomplete || (!entry.knownZeroUsage && (!entry.usage || entry.usage.totalTokens <= 0)) ? 1 : 0, [entry.status]: 1, usage: entry.usage || emptyUsage() };
    const day = value.days[entry.day] ??= emptyDay();
    add(day, counts); add(day.byKind[entry.kind], counts); value.seen[hash] = entry.day;
    return 'recorded';
  }
  async function persistLedger(value) {
    value.updatedAt = new Date(timestamp()).toISOString();
    validateLedger(value);
    await write(ledgerFile, value, MAX_LEDGER_BYTES);
    ledger = value;
  }
  function applySeed(value, seed) {
    if (value.seed.applied) return false;
    value.seed = { applied: true, source: 'proactive_v1_reported_aggregate', day: seed.day, at: new Date(timestamp()).toISOString(), aiAttempts: seed.aiAttempts, usage: seed.usage };
    const earliest = shanghaiDay(startOfDay(shanghaiDay(timestamp())) - (RETENTION_DAYS - 1) * DAY_MS);
    if (seed.day >= earliest) {
      // The old aggregate reports attempts, not completion statuses or exact
      // dispatched model-call counts. Preserve that distinction during import.
      const counts = { ...emptyCounts(), requests: seed.aiAttempts, unclassifiedRequests: seed.aiAttempts, unknownModelCallAttempts: seed.aiAttempts, usage: seed.usage, unknownUsageAttempts: seed.aiAttempts > 0 && seed.usage.totalTokens <= 0 ? seed.aiAttempts : 0 };
      const day = value.days[seed.day] ??= emptyDay(); add(day, counts); add(day.byKind.proactive, counts);
    }
    return true;
  }
  async function load() {
    try {
      await checkDirectory();
      const [policyResult, ledgerResult] = await Promise.allSettled([read(policyFile, 16_384), read(ledgerFile, MAX_LEDGER_BYTES)]);
      const missingPolicy = policyResult.status === 'rejected' && policyResult.reason?.code === 'ENOENT';
      const missingLedger = ledgerResult.status === 'rejected' && ledgerResult.reason?.code === 'ENOENT';
      if (missingPolicy && missingLedger && !initialized) {
        const at = new Date(timestamp()).toISOString();
        const fresh = { version: 1, createdAt: at, updatedAt: at, days: {}, seen: {}, seed: { applied: false } };
        await write(policyFile, { dailyTokenLimit: 0 }, 16_384);
        await persistLedger(fresh); policy = { dailyTokenLimit: 0 };
      } else {
        if (policyResult.status !== 'fulfilled' || ledgerResult.status !== 'fulfilled') throw fail('USAGE_STORAGE_UNAVAILABLE');
        const loadedPolicy = policyOf(policyResult.value), loadedLedger = validateLedger(ledgerResult.value);
        policy = loadedPolicy; ledger = loadedLedger;
      }
      initialized = true;
      const next = clone(ledger); let changed = prune(next, timestamp());
      if (pendingSeed) changed = applySeed(next, pendingSeed) || changed;
      for (const entry of pending.values()) { if (apply(next, entry) === 'recorded') changed = true; }
      if (retryPolicyWrite) await write(policyFile, policy, 16_384);
      if (changed || retryLedgerWrite) await persistLedger(next);
      pending.clear(); pendingSeed = null; available = true; return true;
    } catch { available = false; return false; }
  }
  function gate() {
    const at = timestamp(), day = shanghaiDay(at);
    const today = ledger?.days[day] || emptyDay();
    const limit = policy.dailyTokenLimit;
    const reason = !available || pending.size || pendingSeed ? 'usage_unavailable' : limit > 0 && today.unknownUsageAttempts > 0 ? 'usage_unknown' : limit > 0 && today.usage.totalTokens >= limit ? 'token_budget' : null;
    return { blocked: reason !== null, reason, nextAllowedAt: reason === 'token_budget' || reason === 'usage_unknown' ? new Date(startOfDay(day) + DAY_MS).toISOString() : null,
      dailyTokenLimit: limit, usedTokens: today.usage.totalTokens, remainingTokens: limit === 0 ? null : Math.max(0, limit - today.usage.totalTokens) };
  }
  function describe() {
    const at = timestamp(), day = shanghaiDay(at), today = clone(ledger?.days[day] || emptyDay());
    const history = Array.from({ length: RETENTION_DAYS }, (_, index) => {
      const date = shanghaiDay(startOfDay(day) - index * DAY_MS);
      return { day: date, ...clone(ledger?.days[date] || emptyDay()) };
    });
    return { available: available && pending.size === 0 && pendingSeed === null, policy: clone(policy), day, timezone: 'Asia/Shanghai', today, history,
      gate: gate(), coverage: { scope: 'desktop_pet_reported_usage', since: ledger?.createdAt ?? null, note: coverageText, includesAccountTotal: false, proactiveSeed: ledger?.seed?.applied ? clone(ledger.seed) : null },
      ...(!available || pending.size || pendingSeed ? { diagnostic: { code: 'USAGE_STORAGE_UNAVAILABLE', message: '用量账本暂不可用，后续主动消息已暂停；显式聊天和任务仍可完成。' } } : {}) };
  }
  const get = () => enqueue(async () => { await load(); return describe(); });
  return {
    get, snapshot: get,
    proactiveGate() { return enqueue(async () => { await load(); return gate(); }); },
    configure(value) {
      const nextPolicy = policyOf(value);
      return enqueue(async () => {
        if (!(await load())) throw fail('USAGE_STORAGE_UNAVAILABLE');
        try { await write(policyFile, nextPolicy, 16_384); policy = nextPolicy; available = true; return describe(); }
        catch { available = false; throw fail('USAGE_STORAGE_UNAVAILABLE'); }
      });
    },
    record(value) {
      if (!object(value) || typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value.id) || !KINDS.includes(value.kind) || !STATUSES.includes(value.status) ||
          (value.modelCalls !== undefined && !integer(value.modelCalls)) || (value.usageIncomplete !== undefined && typeof value.usageIncomplete !== 'boolean')) throw fail('INVALID_USAGE_RECORD');
      const at = value.at instanceof Date ? value.at.getTime() : typeof value.at === 'number' ? value.at : Date.parse(value.at);
      if (!Number.isFinite(at) || at > timestamp() + 300_000) throw fail('INVALID_USAGE_RECORD');
      const knownZeroUsage = value.modelCalls === 0 && object(value.usage) && USAGE_KEYS.every(key => value.usage[key] === 0) && value.usageIncomplete !== true;
      const entry = { id: value.id, kind: value.kind, day: shanghaiDay(at), status: value.status, usage: usageOf(value.usage), modelCalls: value.modelCalls, usageIncomplete: value.usageIncomplete === true, knownZeroUsage };
      return enqueue(async () => {
        if (!(await load())) { if (!pending.has(entry.id)) pending.set(entry.id, entry); return { recorded: false, duplicate: false, day: entry.day, reason: 'usage_unavailable' }; }
        try {
          const next = clone(ledger), result = apply(next, entry);
          if (result === 'recorded') await persistLedger(next);
          return { recorded: result === 'recorded', duplicate: result === 'duplicate', expired: result === 'expired', day: entry.day, gate: gate() };
        } catch { available = false; if (!pending.has(entry.id)) pending.set(entry.id, entry); return { recorded: false, duplicate: false, day: entry.day, reason: 'usage_unavailable' }; }
      });
    },
    seedProactive(value) {
      const usage = usageOf(value?.usage);
      if (!object(value) || !validDay(value.day) || !usage || !integer(value.aiAttempts)) throw fail('INVALID_USAGE_SEED');
      return enqueue(async () => {
        if (!(await load())) { pendingSeed ??= { day: value.day, usage, aiAttempts: value.aiAttempts }; return { seeded: false, reason: 'usage_unavailable' }; }
        if (ledger.seed.applied) return { seeded: false, alreadySeeded: true, snapshot: describe() };
        const next = clone(ledger); applySeed(next, { day: value.day, usage, aiAttempts: value.aiAttempts });
        try { await persistLedger(next); return { seeded: true, snapshot: describe() }; }
        catch { available = false; pendingSeed ??= { day: value.day, usage, aiAttempts: value.aiAttempts }; return { seeded: false, reason: 'usage_unavailable' }; }
      });
    },
  };
}

export function parseUsageCommand(text) {
  if (typeof text !== 'string') return null;
  const command = text.trim();
  if (/^(?:用量统计|今日用量|用量面板|预算设置)$/.test(command)) return { type: 'status' };
  if (/^(?:关闭\s*token\s*预算|预算不限)$/i.test(command)) return { type: 'configure', patch: { dailyTokenLimit: 0 } };
  const match = command.match(/^(?:每日\s*token\s*预算\s*(\d+)|每天\s*预算\s*(\d+)\s*token)$/i);
  if (!match) return null;
  const dailyTokenLimit = Number(match[1] ?? match[2]);
  return integer(dailyTokenLimit) && dailyTokenLimit <= 1_000_000_000_000 ? { type: 'configure', patch: { dailyTokenLimit } } : null;
}
