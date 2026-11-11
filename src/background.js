/* Service worker: fetches per-file line stats for a PR / commit / compare view. */
importScripts('diffstat.js');

const L = self.LocDiff;
const CACHE_MS = 30 * 1000;
const cache = new Map(); // key -> { at, result }

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return undefined;
  if (msg.type === 'locdiff:fetch') {
    load(msg.info, !!msg.force).then(
      (result) => sendResponse(result),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) }),
    );
    return true; // async response
  }
  if (msg.type === 'locdiff:openOptions') {
    chrome.runtime.openOptionsPage();
  }
  return undefined;
});

async function load(info, force) {
  if (!info || !info.owner || !info.repo) throw new Error('Unsupported page');
  const key = JSON.stringify(info);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const { token } = await chrome.storage.sync.get({ token: '' });
  const strategies = token ? [viaApi, viaDiff] : [viaDiff, viaApi];
  const errors = [];
  for (const strategy of strategies) {
    try {
      const files = await strategy(info, token);
      const result = { ok: true, files, source: strategy === viaApi ? 'api' : 'diff' };
      cache.set(key, { at: Date.now(), result });
      if (cache.size > 50) cache.delete(cache.keys().next().value);
      return result;
    } catch (e) {
      errors.push(`${strategy === viaApi ? 'API' : '.diff'}: ${e.message || e}`);
    }
  }
  throw new Error(errors.join(' | '));
}

/* ---------- strategy 1: github.com/…/{pull/N,commit/SHA,compare/X}.diff (uses your session) ---------- */

function diffUrl(info) {
  const base = `https://github.com/${info.owner}/${info.repo}`;
  if (info.kind === 'pull') return `${base}/pull/${info.number}.diff`;
  if (info.kind === 'commit') return `${base}/commit/${info.sha}.diff`;
  if (info.kind === 'compare') return `${base}/compare/${info.spec}.diff`;
  throw new Error('unknown page kind');
}

async function viaDiff(info) {
  const res = await fetch(diffUrl(info), { credentials: 'include', redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const head = text.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    throw new Error('got an HTML page instead of a diff (not signed in?)');
  }
  const files = L.parseUnifiedDiff(text);
  if (!files.length && text.trim()) throw new Error('could not parse diff');
  return files;
}

/* ---------- strategy 2: REST API (optional token for private repos / higher rate limit) ---------- */

async function api(path, token) {
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`https://api.github.com${path}`, { headers, credentials: 'omit' });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).message || ''; } catch (_) { /* ignore */ }
    throw new Error(`HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
  }
  return res.json();
}

const mapApiFile = (f) => ({
  path: f.filename,
  oldPath: f.previous_filename || null,
  additions: f.additions | 0,
  deletions: f.deletions | 0,
  status: f.status,
  binary: !f.patch && f.changes === 0 && f.status !== 'renamed',
});

async function viaApi(info, token) {
  const repo = `/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}`;
  const out = [];
  if (info.kind === 'pull') {
    for (let page = 1; page <= 30; page++) {
      const batch = await api(`${repo}/pulls/${info.number}/files?per_page=100&page=${page}`, token);
      out.push(...batch.map(mapApiFile));
      if (batch.length < 100) break;
    }
    return out;
  }
  if (info.kind === 'commit') {
    for (let page = 1; page <= 30; page++) {
      const data = await api(`${repo}/commits/${info.sha}?per_page=100&page=${page}`, token);
      const batch = data.files || [];
      out.push(...batch.map(mapApiFile));
      if (batch.length < 100) break;
    }
    return out;
  }
  if (info.kind === 'compare') {
    if (!/\.\.\.?/.test(info.spec)) throw new Error('compare range must be base...head');
    const data = await api(`${repo}/compare/${info.spec.split('/').map(encodeURIComponent).join('/')}`, token);
    return (data.files || []).map(mapApiFile);
  }
  throw new Error('unknown page kind');
}

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
