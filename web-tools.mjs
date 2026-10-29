import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

export const AGENT_LIMITS = Object.freeze({
  modelCalls: 8, toolCalls: 12, durationMs: 180_000, outputTokens: 900,
  inputChars: 60_000, contextChars: 48_000, toolTextChars: 10_000, totalTokens: 24_000,
});
const REQUEST_LIMITS = Object.freeze({ bytes: 1024 * 1024, timeoutMs: 12_000, redirects: 3 });
const TERMINAL = new Set(['completed', 'budget_exhausted', 'failed', 'stopped', 'interrupted']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function fail(code, message = code) { return Object.assign(new Error(message), { code }); }
function safeError(error) {
  // Never persist upstream auth/provider responses, headers, or credentials.
  const code = typeof error?.code === 'string' && /^[A-Z_]{2,60}$/.test(error.code) ? error.code : 'AGENT_OPERATION_FAILED';
  const descriptions = {
    URL_BLOCKED: '网址不是允许访问的公开 HTTP/HTTPS 网页。', DNS_BLOCKED: '该域名解析到了非公开网络，已阻止。',
    DNS_FAILED: '无法解析网页域名。', WEB_TIMEOUT: '网页读取超过 12 秒。', WEB_TOO_LARGE: '网页超过 1 MiB，已停止读取。',
    WEB_HTTP_ERROR: '网页服务器返回错误状态。', WEB_NETWORK_ERROR: '网页连接失败。', WEB_CONTENT_TYPE: '这个链接不是支持的文本网页。',
    WEB_REDIRECT_LIMIT: '网页重定向次数过多。', WEB_ENCODING: '网页使用了不支持的压缩编码。',
    SEARCH_UNAVAILABLE: '公开搜索暂时不可用；可以把要阅读的公开网址交给我。',
    BAD_TOOL_ARGUMENTS: '工具参数无效。', UNKNOWN_TOOL: '仅支持只读网页和公开搜索工具。',
    MODEL_FAILED: '模型调用未成功。', MODEL_RESPONSE_INVALID: '模型返回格式不受支持。',
    TASK_TIMEOUT: '任务达到时间上限。', INPUT_LIMIT: '任务达到总输入文本上限。',
    MODEL_LIMIT: '任务达到模型调用上限。', TOOL_LIMIT: '任务达到网页工具调用上限。',
    TOTAL_TOKEN_LIMIT: '任务累计实际 token 用量达到阈值，已停止后续调用。',
    USAGE_UNAVAILABLE: '模型没有返回可核对的用量，已停止后续调用。',
    TASK_STOPPED: '任务已由你停止。', STORAGE_FAILED: '任务记录保存失败，已停止任务。',
  };
  return { code, message: descriptions[code] || '操作未完成，请查看任务记录或重试。' };
}
function throwAborted(signal) { if (signal?.aborted) throw signal.reason || fail('TASK_STOPPED'); }
function abortable(promise, signal) {
  throwAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || fail('TASK_STOPPED'));
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
  });
}

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return parts.reduce((n, octet) => n * 256 + octet, 0);
}
export function isPublicAddress(address) {
  if (isIP(address) === 4) {
    const n = ipv4Number(address);
    const ranges = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
    ];
    return !ranges.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(ipv4Number(base) / 2 ** (32 - bits)));
  }
  if (isIP(address) === 6) {
    // Only ordinary global unicast; reject mapped IPv4, NAT64, ULA, link-local,
    // multicast, documentation, Teredo and 6to4 transition addresses.
    if (address.includes('%') || address.includes('.')) return false;
    const halves = address.toLowerCase().split('::');
    if (halves.length > 2) return false;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const words = halves.length === 2 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
    if (words.length !== 8) return false;
    const [a, b] = words.map(v => parseInt(v, 16));
    return a >= 0x2000 && a < 0x3fff && a !== 0x2002 &&
      !(a === 0x2001 && (b < 0x0200 || b === 0x0db8));
  }
  return false;
}
export function publicWebUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) throw fail('URL_BLOCKED');
  let url;
  try { url = new URL(raw); } catch { throw fail('URL_BLOCKED'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && url.port !== (url.protocol === 'https:' ? '443' : '80')) ||
      !host || host === 'localhost' || /\.(localhost|local|internal|home|lan)$/.test(host) ||
      (isIP(host) ? !isPublicAddress(host) : !host.includes('.'))) throw fail('URL_BLOCKED');
  url.hash = '';
  return url;
}

function isFakeIp(address) {
  return isIP(address) === 4 && Math.floor(ipv4Number(address) / 2 ** 17) === Math.floor(ipv4Number('198.18.0.0') / 2 ** 17);
}
async function resolvePublic(url, lookup, signal, dnsFallback) {
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (isIP(hostname)) addresses = [{ address: hostname, family: isIP(hostname) }];
  else {
    try { addresses = await abortable(lookup(hostname, { all: true, verbatim: true }), signal); }
    catch (error) { throwAborted(signal); throw fail('DNS_FAILED'); }
  }
  // Some macOS VPNs synthesize only 198.18/15 answers. Never connect to that
  // benchmark/private range: resolve the public name through a fixed public
  // DoH endpoint, then apply the same public-address check and connection pin.
  // Mixed or other private DNS answers remain an immediate rejection.
  if (addresses?.length && addresses.every(a => isFakeIp(a.address)) && dnsFallback) {
    try { addresses = await abortable(dnsFallback(hostname, signal), signal); }
    catch { throwAborted(signal); throw fail('DNS_FAILED'); }
  }
  if (!addresses?.length || addresses.some(a => !isPublicAddress(a.address))) throw fail('DNS_BLOCKED');
  return addresses.find(a => a.family === 4) || addresses[0];
}

function requestOnce(url, address, signal, limits, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const req = transport.request(url, {
      method: 'GET', signal, family: address.family, autoSelectFamily: false, rejectUnauthorized: true, agent: false,
      // Pin the connection to the address just validated, preventing DNS rebinding.
      lookup(_host, opts, callback) {
        if (opts?.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      ...(url.protocol === 'https:' && !isIP(hostname) ? { servername: hostname } : {}),
      headers: { 'User-Agent': 'DesktopWhalePet-ReadOnlyAgent/1.0', Accept: 'text/html,text/plain,application/xhtml+xml,application/rss+xml,application/xml,application/json;q=0.8', ...extraHeaders },
    }, res => {
      const status = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        // Redirect bodies are not evidence and may be an unbounded stream.
        res.destroy();
        resolve({ status, location: res.headers.location, headers: res.headers, body: '' });
        return;
      }
      if (status < 200 || status >= 300) { res.destroy(); reject(fail('WEB_HTTP_ERROR')); return; }
      const kind = String(res.headers['content-type'] || '').toLowerCase();
      if (!/^(text\/|application\/(?:xhtml\+xml|rss\+xml|atom\+xml|xml|json|dns-json)(?:;|$))/.test(kind)) {
        res.destroy(); reject(fail('WEB_CONTENT_TYPE')); return;
      }
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') {
        res.destroy(); reject(fail('WEB_ENCODING')); return;
      }
      if (Number(res.headers['content-length'] || 0) > limits.bytes) { res.destroy(); reject(fail('WEB_TOO_LARGE')); return; }
      const chunks = [];
      let bytes = 0;
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > limits.bytes) { res.destroy(fail('WEB_TOO_LARGE')); return; }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', error => reject(signal.aborted ? signal.reason : error.code === 'WEB_TOO_LARGE' ? error : fail('WEB_NETWORK_ERROR')));
    req.end();
  });
}

async function resolvePublicOverHttps(hostname, signal) {
  const url = new URL('https://cloudflare-dns.com/dns-query');
  url.searchParams.set('name', hostname);
  url.searchParams.set('type', 'A');
  // Fixed public IP, TLS SNI and certificate verification for the official
  // resolver hostname; no system DNS or proxy credentials are consulted.
  const response = await requestOnce(url, { address: '1.1.1.1', family: 4 }, signal,
    { ...REQUEST_LIMITS, bytes: 64 * 1024 }, { Accept: 'application/dns-json' });
  if (response.status !== 200) throw fail('DNS_FAILED');
  let payload;
  try { payload = JSON.parse(response.body); } catch { throw fail('DNS_FAILED'); }
  if (payload.Status !== 0 || !Array.isArray(payload.Answer)) throw fail('DNS_FAILED');
  return payload.Answer.filter(answer => answer.type === 1).map(answer => ({ address: answer.data, family: 4 }));
}

// Injection exists solely for deterministic tests. Production uses the pinned
// native transport above and still validates every redirect and DNS result.
export function createWebReader({ lookup = dnsLookup, request = requestOnce, requestLimits = {},
  dnsFallback = lookup === dnsLookup ? resolvePublicOverHttps : undefined } = {}) {
  const limits = Object.fromEntries(Object.entries(REQUEST_LIMITS).map(([key, value]) => [key, Math.min(value, Math.max(1, requestLimits[key] || value))]));
  return async function read(raw, { signal } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(fail('WEB_TIMEOUT')), limits.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      let url = publicWebUrl(raw);
      for (let redirects = 0; redirects <= limits.redirects; redirects++) {
        throwAborted(combined);
        const address = await resolvePublic(url, lookup, combined, dnsFallback);
        const response = await abortable(request(url, address, combined, limits), combined);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects >= limits.redirects || !response.location) throw fail('WEB_REDIRECT_LIMIT');
          url = publicWebUrl(new URL(response.location, url).href);
          continue;
        }
        if (Buffer.byteLength(response.body || '', 'utf8') > limits.bytes) throw fail('WEB_TOO_LARGE');
        return { ...response, sourceUrl: url.href };
      }
      throw fail('WEB_REDIRECT_LIMIT');
    } finally { clearTimeout(timer); }
  };
}

function decodeEntities(value) {
  const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
    if (entity.startsWith('#')) {
      const n = parseInt(entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1), entity[1]?.toLowerCase() === 'x' ? 16 : 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '';
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}
function plainText(html) {
  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote)>|<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')).replace(/[\t\r ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
export function extractPage(response, maxText = AGENT_LIMITS.toolTextChars) {
  const body = response.body || '';
  const type = String(response.headers?.['content-type'] || 'text/html');
  const html = /html/i.test(type);
  const fullText = html ? plainText(body) : body.trim();
  const title = html ? plainText(body.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] || '').slice(0, 300) : '';
  const links = [];
  if (html) {
    const seen = new Set();
    for (const match of body.matchAll(/<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a\s*>/gi)) {
      if (links.length >= 20) break;
      try {
        const href = publicWebUrl(new URL(decodeEntities(match[1] ?? match[2] ?? match[3]), response.sourceUrl).href).href;
        if (seen.has(href)) continue;
        seen.add(href);
        links.push({ title: plainText(match[4]).slice(0, 150), url: href, visited: false });
      } catch { /* Not a permitted public web URL. */ }
    }
  }
  return {
    sourceUrl: response.sourceUrl, fetched: true, title, text: fullText.slice(0, maxText), links,
    truncated: fullText.length > maxText, note: fullText.length < 80 ? '页面可提取正文很少，可能需要 JavaScript 或登录；不能据此推断未读取内容。' : undefined,
  };
}

export const AGENT_TOOLS = Object.freeze([
  { name: 'read_web', description: '只读抓取一个公开 HTTP/HTTPS 网页。返回真实读取的来源URL、标题、正文和未访问的链接。不执行JavaScript，不登录，不发帖。',
    parameters: { type: 'object', properties: { url: { type: 'string', description: '公开网页的绝对URL', maxLength: 2048 } }, required: ['url'], additionalProperties: false } },
  { name: 'search_web', description: '读取公开搜索引擎的实际搜索结果。搜索摘要只证明搜索页已读取，若需正文必须再调用read_web。失败时不要编造搜索结果。',
    parameters: { type: 'object', properties: { query: { type: 'string', maxLength: 300 } }, required: ['query'], additionalProperties: false } },
]);

export function createReadOnlyWebTools({ reader = createWebReader(), maxText = AGENT_LIMITS.toolTextChars } = {}) {
  return async function execute(name, args, { signal } = {}) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('BAD_TOOL_ARGUMENTS');
    if (name === 'read_web') {
      if (Object.keys(args).some(key => key !== 'url') || typeof args.url !== 'string') throw fail('BAD_TOOL_ARGUMENTS');
      return extractPage(await reader(args.url, { signal }), maxText);
    }
    if (name === 'search_web') {
      if (Object.keys(args).some(key => key !== 'query') || typeof args.query !== 'string' || !args.query.trim() || args.query.length > 300) throw fail('BAD_TOOL_ARGUMENTS');
      const url = new URL('https://www.bing.com/search');
      url.searchParams.set('format', 'rss');
      url.searchParams.set('q', args.query.trim());
      const response = await reader(url.href, { signal });
      const results = [];
      for (const match of response.body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
        const field = key => decodeEntities(match[1].match(new RegExp(`<${key}\\b[^>]*>([\\s\\S]*?)<\\/${key}>`, 'i'))?.[1]?.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1') || '').trim();
        try {
          const target = publicWebUrl(field('link')).href;
          results.push({ title: plainText(field('title')).slice(0, 240), url: target, snippet: plainText(field('description')).slice(0, 800), visited: false });
        } catch { /* Skip unsupported search links. */ }
        if (results.length >= 8) break;
      }
      if (!results.length) throw fail('SEARCH_UNAVAILABLE');
      return { sourceUrl: response.sourceUrl, fetched: true, query: args.query.trim(), results, note: '仅已读取搜索结果页；结果目标网页正文尚未访问。' };
    }
    throw fail('UNKNOWN_TOOL');
  };
}

