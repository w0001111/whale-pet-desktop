import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { appDataRoot } from './provider-config.mjs';
import {storageSecurity} from './private-storage.mjs';

export const SCREEN_INTERVAL_SECONDS = 600;
export const SCREEN_DAILY_LIMIT = 12;
export const DEFAULT_SCREEN_POLICY = Object.freeze({ minIntervalSeconds: SCREEN_INTERVAL_SECONDS, dailyLimit: SCREEN_DAILY_LIMIT });
const DEFAULT_LEDGER = path.join(appDataRoot(),'data','screen-budget.json');
const MAX_DATE_MS = 8_640_000_000_000_000;
const fail = code => Object.assign(new Error(code), { code });

export function shanghaiDay(timestamp) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validatePolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['minIntervalSeconds', 'dailyLimit'].includes(key)) ||
      !Number.isSafeInteger(value.minIntervalSeconds) || value.minIntervalSeconds < 0 || value.minIntervalSeconds > 86400 ||
      !Number.isSafeInteger(value.dailyLimit) || value.dailyLimit < 0 || value.dailyLimit > 10000) throw fail('INVALID_SCREEN_POLICY');
  return { minIntervalSeconds: value.minIntervalSeconds, dailyLimit: value.dailyLimit };
}

function validDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

async function readJSON(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw fail('INVALID_SCREEN_STORAGE');
  const handle=await storageSecurity.openRead(file);
  try{const bytes=Buffer.alloc(8193);let count=0;while(count<bytes.length){const result=await handle.read(bytes,count,bytes.length-count,count);if(!result.bytesRead)break;count+=result.bytesRead;}if(count>8192)throw fail('INVALID_SCREEN_STORAGE');return JSON.parse(bytes.subarray(0,count).toString('utf8'));}finally{await handle.close();}
}

async function writeJSON(file, value) {
  await storageSecurity.directory(path.dirname(file));
  try{const info=await fs.lstat(file);if(!info.isFile()||info.isSymbolicLink())throw fail('INVALID_SCREEN_STORAGE');}catch(error){if(error.code!=='ENOENT')throw error;}
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
    await storageSecurity.created(temporary);
    await fs.rename(temporary, file);
    storageSecurity.renamed(temporary,file);
  } finally { await fs.unlink(temporary).catch(() => {}); }
}

/**
 * One local service owns this ledger. Configuration and dispatch counters share
 * a queue, so changing a limit cannot race an image-dispatch commit. Screenshots
 * never enter either persistent file.
 */
export function createScreenBudget({ file = DEFAULT_LEDGER, policyFile = path.join(path.dirname(file), 'screen-policy.json'), now = () => Date.now() } = {}) {
  if (typeof file !== 'string' || typeof policyFile !== 'string' || path.resolve(file) === path.resolve(policyFile) || typeof now !== 'function') throw fail('INVALID_SCREEN_STORAGE');
  let operations = Promise.resolve();
  function enqueue(operation) {
    const pending = operations.then(operation);
    operations = pending.then(() => {}, () => {});
    return pending;
  }
  async function readPolicy() {
    try { return validatePolicy(await readJSON(policyFile)); }
    catch (error) {
      if (error.code === 'ENOENT') return { ...DEFAULT_SCREEN_POLICY };
      throw fail('SCREEN_POLICY_UNAVAILABLE');
    }
  }
  async function readLedger(timestamp) {
    try {
      const value = await readJSON(file);
      if (value.version !== 1 || !validDay(value.day) || !Number.isSafeInteger(value.count) || value.count < 0 ||
          !Number.isSafeInteger(value.lastSentAt) || value.lastSentAt < 0 || value.lastSentAt > MAX_DATE_MS) throw fail('INVALID_LEDGER');
      return { version: 1, day: value.day, count: value.count, lastSentAt: value.lastSentAt };
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, day: shanghaiDay(timestamp), count: 0, lastSentAt: 0 };
      throw fail('SCREEN_BUDGET_UNAVAILABLE');
    }
  }
  function describe(value, policy, timestamp) {
    const day = shanghaiDay(timestamp);
    const used = value.day === day ? value.count : 0;
    const dailyUnlimited = policy.dailyLimit === 0;
    const atDailyLimit = !dailyUnlimited && used >= policy.dailyLimit;
    const intervalAt = value.lastSentAt > 0 ? value.lastSentAt + policy.minIntervalSeconds * 1000 : 0;
    const nextMidnight = Date.parse(`${day}T00:00:00+08:00`) + 86400000;
    const allowedAt = atDailyLimit ? Math.max(nextMidnight, intervalAt) : intervalAt;
    const secondsUntilNext = Math.max(0, Math.ceil((allowedAt - timestamp) / 1000));
    const reason = atDailyLimit ? 'daily_limit' : secondsUntilNext > 0 ? 'cooldown' : 'available';
    return {
      timezone: 'Asia/Shanghai', day, limit: policy.dailyLimit, dailyUnlimited, used,
      remaining: dailyUnlimited ? null : Math.max(0, policy.dailyLimit - used),
      minIntervalSeconds: policy.minIntervalSeconds, secondsUntilNext,
      nextAllowedAt: secondsUntilNext ? new Date(allowedAt).toISOString() : null,
      allowed: reason === 'available', canSend: reason === 'available', reason,
    };
  }
  return {
    status() {
      return enqueue(async () => {
        let policy;
        const timestamp = now();
        try {
          policy = await readPolicy();
          return describe(await readLedger(timestamp), policy, timestamp);
        } catch {
          return {
            timezone: 'Asia/Shanghai', day: shanghaiDay(timestamp), limit: policy?.dailyLimit ?? null,
            dailyUnlimited: policy ? policy.dailyLimit === 0 : false, used: null, remaining: 0,
            minIntervalSeconds: policy?.minIntervalSeconds ?? null, secondsUntilNext: 0, nextAllowedAt: null,
            allowed: false, canSend: false, reason: 'storage_error',
          };
        }
      });
    },
    settings() { return enqueue(() => readPolicy()); },
    configure(value) {
      // Validate before queuing or touching either file, including unknown keys.
      let next;
      try { next = validatePolicy(value); } catch (error) { return Promise.reject(error); }
      return enqueue(async () => {
        const timestamp = now();
        // Existing damaged storage remains an explicit error, rather than being
        // silently replaced with more permissive defaults or reset counters.
        await readPolicy();
        const ledger = await readLedger(timestamp);
        await writeJSON(policyFile, next);
        return { policy: { ...next }, budget: describe(ledger, next, timestamp) };
      });
    },
    commit() {
      return enqueue(async () => {
        const timestamp = now();
        const policy = await readPolicy();
        const state = await readLedger(timestamp);
        const status = describe(state, policy, timestamp);
        if (!status.canSend) throw Object.assign(fail('SCREEN_BUDGET_REFUSED'), { screenReason: status.reason });
        if (!Number.isSafeInteger(status.used + 1)) throw fail('SCREEN_BUDGET_UNAVAILABLE');
        const next = { version: 1, day: status.day, count: status.used + 1, lastSentAt: timestamp };
        await writeJSON(file, next);
        return describe(next, policy, timestamp);
      });
    },
  };
}
