/*
 * Content script: decorates GitHub's diff file tree with +/- line counts and a
 * churn heatmap, and offers a treemap "hotspots" panel for the whole change.
 */
(() => {
  'use strict';
  const L = globalThis.LocDiff;
  if (!L || globalThis.__locdiffLoaded) return;
  globalThis.__locdiffLoaded = true;

  const NS = 'locdiff';
  const DEFAULTS = { badges: true, heatmap: true, heatStyle: 'tint', scale: 'log', panelButton: true, inlineHeatmap: true };

  let settings = { ...DEFAULTS };
  let state = freshState(null);
  let resolveCache = new WeakMap(); // treeitem element -> { sig, node }
  let pathToItem = new Map(); // file path -> tree item element (for navigation)
  let scheduled = false;
  let panelColorMode = 'heat';

  function freshState(key) {
    return { key, info: null, status: 'idle', error: null, source: null, model: null, hashToPath: new Map(), pathToHash: new Map() };
  }

  /* ------------------------------------------------------------------ routing */

  function pageInfo(loc) {
    const parts = loc.pathname.split('/').filter(Boolean);
    if (parts.length < 4) return null;
    const [owner, repo, section, ...rest] = parts;
    if (section === 'pull' && /^\d+$/.test(rest[0])) {
      const number = rest[0];
      if (rest[1] === 'files' || rest[1] === 'changes') {
        // /pull/N/files/<sha> or /pull/N/files/a..b shows a subset; fall back to the whole PR.
        return { kind: 'pull', owner, repo, number };
      }
      if (rest[1] === 'commits' && /^[0-9a-f]{7,40}$/i.test(rest[2] || '')) {
        return { kind: 'commit', owner, repo, sha: rest[2] };
      }
      return null;
    }
    if (section === 'commit' && /^[0-9a-f]{7,40}$/i.test(rest[0] || '')) {
      return { kind: 'commit', owner, repo, sha: rest[0] };
    }
    if (section === 'compare' && rest.length) {
      return { kind: 'compare', owner, repo, spec: decodeURIComponent(rest.join('/')) };
    }
    return null;
  }

  /* ------------------------------------------------------------------ data */

  async function sha256Hex(s) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function load(info, force) {
    const key = state.key;
    state.status = 'loading';
    state.info = info;
    renderButton();
    let res;
    try {
      res = await chrome.runtime.sendMessage({ type: 'locdiff:fetch', info, force: !!force });
    } catch (e) {
      res = { ok: false, error: `extension error: ${e.message || e}` };
    }
    if (state.key !== key) return; // navigated away meanwhile
    if (!res || !res.ok) {
      state.status = 'error';
      state.error = (res && res.error) || 'unknown error';
      renderButton();
      renderPanel();
      return;
    }
    const model = L.buildTree(res.files);
    const hashToPath = new Map();
    const pathToHash = new Map();
    await Promise.all(res.files.map(async (f) => {
      const h = await sha256Hex(f.path);
      hashToPath.set(h, f.path);
      pathToHash.set(f.path, h);
    }));
    if (state.key !== key) return;
    Object.assign(state, { status: 'ready', model, hashToPath, pathToHash, source: res.source, error: null });
    resolveCache = new WeakMap();
    schedule();
    renderPanel();
  }

  /* ------------------------------------------------------------------ tree resolution */

  const LABEL_SELECTORS = [
    '.ActionList-item-label',
    '.PRIVATE_TreeView-item-content-text',
    '[class*="TreeView-item-content-text"]',
    '[class*="TreeView-module__TreeViewItemContentText"]',
    '[class*="TreeViewItemContentText"]',
    '[class*="TreeView-item-content"] > span:not([class*="visual" i]):not([aria-hidden])',
  ].join(',');

  // Flat (virtualised) trees put every item side by side and express nesting via aria-level.
  let levelParent = new WeakMap();
  function indexLevels(items) {
    levelParent = new WeakMap();
    const stack = [];
    for (const li of items) {
      const level = parseInt(li.getAttribute('aria-level'), 10);
      if (!level) continue;
      stack.length = level - 1;
      if (level > 1 && stack[level - 2]) levelParent.set(li, stack[level - 2]);
      stack[level - 1] = li;
    }
  }

  /** The row element of a tree item (excludes its nested sub-tree). */
  function rowOf(li) {
    // GitHub's classic tree: <li> holds a hidden <span data-filterable-item-text hidden> before the real row.
    const known = li.querySelector(':scope > .ActionList-content, :scope > [class*="TreeView-item-container"], :scope > [class*="TreeViewItemContainer"]');
    if (known) return known;
    for (const child of li.children) {
      if (child.getAttribute('role') === 'group' || child.tagName === 'UL') continue;
      if (child.classList.contains(`${NS}-badge`)) continue;
      if (child.hidden || child.hasAttribute('data-filterable-item-text') || child.tagName === 'TEMPLATE') continue;
      return child;
    }
    return li;
  }

  function labelElOf(row) {
    return row.querySelector(LABEL_SELECTORS);
  }

  function textOf(el) {
    let s = '';
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) s += c.nodeValue;
        else if (c.nodeType === 1) {
          const cls = c.classList;
          if (cls.contains(`${NS}-badge`) || cls.contains('sr-only') || cls.contains('VisuallyHidden')) continue;
          if (c.tagName === 'svg' || c.getAttribute('aria-hidden') === 'true') continue;
          walk(c);
        }
      }
    };
    walk(el);
    return s.replace(/\s+/g, ' ').trim();
  }

  function labelOf(li) {
    const row = rowOf(li);
    const el = labelElOf(row);
    return (el ? textOf(el) : textOf(row)).replace(/^\/+|\/+$/g, '');
  }

  function isDirItem(li) {
    const type = li.getAttribute('data-tree-entry-type');
    if (type) return type !== 'file';
    return li.hasAttribute('aria-expanded') || !!li.querySelector(':scope > [role="group"], :scope > ul');
  }

  function parentItem(li) {
    const p = li.parentElement && li.parentElement.closest('[role="treeitem"]');
    if (p && p !== li) return p;
    return levelParent.get(li) || null;
  }

  function ancestryPath(li) {
    const labels = [];
    for (let n = li; n; n = parentItem(n)) labels.unshift(labelOf(n));
    return labels.filter(Boolean).join('/');
  }

  function hashFrom(str) {
    const m = str && str.match(/diff-([0-9a-f]{64})/);
    return m ? m[1] : null;
  }

  function lookup(path, wantDir) {
    const { files, dirs } = state.model;
    if (!path) return null;
    if (wantDir) return dirs.get(path) || null;
    return files.get(path) || null;
  }

  function suffixLookup(path, wantDir) {
    const map = wantDir ? state.model.dirs : state.model.files;
    let found = null;
    for (const [p, node] of map) {
      if (p === path || p.endsWith('/' + path)) {
        if (found) return null; // ambiguous
        found = node;
      }
    }
    return found;
  }

  function resolveItem(li) {
    const dir = isDirItem(li);
    const row = rowOf(li);
    const link = row.matches('a[href]') ? row : row.querySelector('a[href]');
    const sig = `${dir}|${li.id}|${link ? link.getAttribute('href') : ''}|${ancestryPath(li)}`;
    const cached = resolveCache.get(li);
    if (cached && cached.sig === sig) return cached.node;

    let node = null;
    if (!dir) {
      const h = hashFrom(link && link.getAttribute('href')) || hashFrom(li.id);
      if (h && state.hashToPath.has(h)) node = lookup(state.hashToPath.get(h), false);
    }
    if (!node) {
      for (const attr of ['data-path', 'data-file-path', 'data-tree-path']) {
        const v = li.getAttribute(attr) || row.getAttribute(attr);
        if (v && (node = lookup(v.replace(/^\/+/, ''), dir))) break;
      }
    }
    if (!node && li.id) {
      const id = li.id.replace(/-item$/, '');
      node = lookup(id, dir) || lookup(decodeURIComponent(id), dir);
    }
    if (!node) {
      const p = ancestryPath(li);
      node = lookup(p, dir) || (p && suffixLookup(p, dir));
    }
    if (!node) {
      // Last resort: the bare label, if it names exactly one changed file/folder.
      const label = labelOf(li);
      if (label) node = suffixLookup(label, dir);
    }
    resolveCache.set(li, { sig, node });
    return node;
  }

  /* ------------------------------------------------------------------ decoration */

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function badgeText(node) {
    return `+${L.formatCount(node.additions)} −${L.formatCount(node.deletions)}`;
  }

  function decorate() {
    const items = document.querySelectorAll('file-tree [role="treeitem"], [role="tree"] [role="treeitem"]');
    const { maxFile, maxDir } = state.model;
    pathToItem = new Map();
    indexLevels(items);
    let resolved = 0;
    for (const li of items) {
      const node = resolveItem(li);
      const row = rowOf(li);
      if (!node) { undecorate(li, row); continue; }
      resolved++;
      if (!node.isDir && !pathToItem.has(node.path)) pathToItem.set(node.path, li);

      // --- badge
      const labelEl = labelElOf(row);
      const host = (labelEl && labelEl.parentElement) || row;
      // GitHub puts the added/modified/removed icon in the trailing slot; sit right before it.
      const trailing = host.querySelector(':scope > .ActionList-item-visual--trailing, :scope > [class*="TrailingVisual"], :scope > [class*="trailing-visual"]');
      let badge = row.querySelector(`.${NS}-badge`);
      if (settings.badges) {
        const text = badgeText(node);
        if (!badge) {
          badge = el('span', `${NS}-badge`);
          badge.append(el('span', `${NS}-add`), el('span', `${NS}-del`));
        }
        if (trailing) {
          if (trailing.firstElementChild !== badge) trailing.prepend(badge);
          badge.classList.add(`${NS}-badge--in-trailing`);
        } else if (badge.parentElement !== host) {
          host.appendChild(badge);
        }
        const [a, d] = badge.children;
        const at = `+${L.formatCount(node.additions)}`;
        const dt = `−${L.formatCount(node.deletions)}`;
        if (a.textContent !== at) a.textContent = at;
        if (d.textContent !== dt) d.textContent = dt;
        const title = `${node.isDir ? `${node.fileCount} files, ` : ''}${node.additions} additions, ${node.deletions} deletions`;
        if (badge.title !== title) badge.title = title;
        badge.dataset.text = text;
      } else if (badge) {
        badge.remove();
      }

      // --- heat
      if (settings.heatmap) {
        const t = L.heat(L.churn(node), node.isDir ? maxDir : maxFile, settings.scale).toFixed(3);
        if (!row.classList.contains(`${NS}-heat`)) row.classList.add(`${NS}-heat`);
        row.classList.toggle(`${NS}-heat--bar`, settings.heatStyle === 'bar');
        row.classList.toggle(`${NS}-heat--dir`, node.isDir);
        if (row.style.getPropertyValue('--locdiff-heat') !== t) row.style.setProperty('--locdiff-heat', t);
      } else if (row.classList.contains(`${NS}-heat`)) {
        clearHeat(row);
      }
    }
    // Diagnostics for when GitHub changes its markup: shows in the page's DevTools console.
    const diag = `${items.length}/${resolved}`;
    if (diag !== lastDiag) {
      lastDiag = diag;
      console.debug(`[gh-inline-loc-diff] file tree items: ${items.length}, matched to changed files/folders: ${resolved}, changed files: ${state.model.files.size}`);
    }
  }
  let lastDiag = '';

  function clearHeat(row) {
    row.classList.remove(`${NS}-heat`, `${NS}-heat--bar`, `${NS}-heat--dir`);
    row.style.removeProperty('--locdiff-heat');
  }

  function undecorate(li, row) {
    row = row || rowOf(li);
    row.querySelectorAll(`.${NS}-badge`).forEach((b) => b.remove());
    if (row.classList.contains(`${NS}-heat`)) clearHeat(row);
  }

  function undecorateAll() {
    document.querySelectorAll(`.${NS}-badge`).forEach((b) => b.remove());
    document.querySelectorAll(`.${NS}-heat`).forEach(clearHeat);
    document.querySelectorAll(`.${NS}-file-heat`).forEach((h) => {
      h.classList.remove(`${NS}-file-heat`);
      h.style.removeProperty('--locdiff-heat');
    });
  }

  /* ------------------------------------------------------------------ floating button + panel */

  let button = null;
  let panel = null;

  function renderButton() {
    const active = !!state.key && settings.panelButton && !(inline && inline.isConnected);
    if (!active) { if (button) { button.remove(); button = null; } return; }
    if (!button) {
      button = el('button', `${NS}-fab`);
      button.type = 'button';
      button.addEventListener('click', togglePanel);
      document.body.appendChild(button);
    }
    let text = 'LOC heatmap';
    let title = 'Show change heatmap (Alt+Shift+H)';
    if (state.status === 'loading') text = 'LOC: loading…';
    if (state.status === 'error') { text = 'LOC: error'; title = state.error; }
    if (state.status === 'ready') {
      const t = state.model.totals;
      text = `+${L.formatCount(t.additions)} −${L.formatCount(t.deletions)} · heatmap`;
    }
    if (button.textContent !== text) button.textContent = text;
    button.title = title;
    button.classList.toggle(`${NS}-fab--error`, state.status === 'error');
  }

  function togglePanel() {
    if (panel) { panel.remove(); panel = null; return; }
    panel = el('div', `${NS}-panel`);
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Change heatmap');
    document.body.appendChild(panel);
    renderPanel();
  }

  function navigateTo(path) {
    const li = pathToItem.get(path);
    const row = li && rowOf(li);
    const target = row && (row.matches('a, button') ? row : row.querySelector('a, button'));
    if (target) { target.click(); return; }
    const hash = state.pathToHash.get(path);
    const anchor = (hash && document.getElementById(`diff-${hash}`))
      || document.querySelector(`[data-tagsearch-path="${CSS.escape(path)}"]`);
    if (anchor) { anchor.scrollIntoView({ block: 'start' }); return; }
    if (hash) location.hash = `diff-${hash}`;
  }

  function heatColor(t) {
    // pale yellow -> orange -> deep red
    const hue = 52 - 50 * t;
    const light = 90 - 45 * t;
    return `hsl(${hue.toFixed(1)} 95% ${light.toFixed(1)}%)`;
  }

  function ratioColor(node) {
    const total = L.churn(node);
    if (!total) return 'hsl(0 0% 80%)';
    const r = node.additions / total; // 0 = only deletions, 1 = only additions
    return `hsl(${(r * 130).toFixed(0)} 65% 55%)`;
  }

  function renderPanel() {
    renderInline();
    if (!panel) return;
    panel.textContent = '';
    const header = el('div', `${NS}-panel-header`);
    header.append(el('strong', null, 'Change heatmap'));
    const close = el('button', `${NS}-icon-btn`, '×');
    close.type = 'button';
    close.title = 'Close (Esc)';
    close.addEventListener('click', togglePanel);
    header.append(close);
    panel.append(header);
    fillHeatmap(panel, { compact: false });
  }

  /** Render summary, treemap and hotspot lists into `box`. */
  function fillHeatmap(box, { compact }) {
    if (state.status === 'loading' || state.status === 'idle') {
      box.append(el('p', `${NS}-muted`, 'Loading line stats…'));
      return;
    }
    if (state.status === 'error') {
      box.append(el('p', `${NS}-error`, state.error));
      const p = el('p', `${NS}-muted`, 'For private repositories or API rate limits, add a GitHub token in the ');
      const a = el('a', null, 'extension options');
      a.href = '#';
      a.addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'locdiff:openOptions' }); });
      p.append(a, document.createTextNode('.'));
      const retry = el('button', `${NS}-btn`, 'Retry');
      retry.type = 'button';
      retry.addEventListener('click', () => load(state.info, true));
      box.append(p, retry);
      return;
    }

    const { totals, root, maxFile } = state.model;
    if (!compact) {
      const summary = el('div', `${NS}-summary`);
      summary.append(
        el('span', `${NS}-add`, `+${totals.additions.toLocaleString()}`),
        el('span', `${NS}-del`, `−${totals.deletions.toLocaleString()}`),
        el('span', `${NS}-muted`, `in ${totals.files.toLocaleString()} file${totals.files === 1 ? '' : 's'}`),
        blocksEl(totals.additions, totals.deletions),
      );
      box.append(summary);
    }

    // color-mode toggle
    const modes = el('div', `${NS}-seg`);
    for (const [mode, label] of [['heat', 'Churn'], ['ratio', 'Added vs deleted']]) {
      const b = el('button', mode === panelColorMode ? 'is-active' : '', label);
      b.type = 'button';
      b.addEventListener('click', () => { panelColorMode = mode; renderPanel(); });
      modes.append(b);
    }
    box.append(modes);

    // treemap
    const map = el('div', `${NS}-treemap`);
    box.append(map);
    const W = map.clientWidth || (compact ? 280 : 440);
    const H = compact ? Math.round(Math.min(220, Math.max(140, W * 0.6))) : 320;
    map.style.height = `${H}px`;
    drawTreemap(map, root, 0, 0, W, H, 0, maxFile);

    // hotspot lists
    // Skip pass-through directories (only child is another directory) - they duplicate their child.
    const dirs = [...state.model.dirs.values()].filter((d) => d !== root
      && !(d.children.size === 1 && d.children.values().next().value.isDir));
    const files = [...state.model.files.values()];
    const n = compact ? 5 : 8;
    box.append(hotList('Hottest directories', dirs, false, n));
    box.append(hotList('Hottest files', files, true, n));
    if (!compact) {
      box.append(el('p', `${NS}-muted ${NS}-foot`, `Source: ${state.source === 'api' ? 'GitHub REST API' : '.diff'} · Alt+Shift+H toggles this panel`));
    }
  }

  /* ------------------------------------------------------------------ inline section in the diff view */

  let inline = null; // <details> placed above GitHub's file tree
  let inlineOpen = false; // collapsed by default so the file list stays on top
  let inlineWidth = 0;
  const inlineResize = new ResizeObserver(() => {
    if (inline && inline.open && Math.abs(inline.clientWidth - inlineWidth) > 8) renderInline();
  });

  function fileTreeHost() {
    for (const li of pathToItem.values()) {
      if (!li.isConnected) continue;
      const tree = li.closest('file-tree') || li.closest('[role="tree"]');
      if (tree && tree.parentElement) return tree;
    }
    return null;
  }

  /** Make sure the heatmap section sits right above the file tree. Returns true if placed. */
  function ensureInline() {
    const host = settings.inlineHeatmap && state.status === 'ready' ? fileTreeHost() : null;
    if (!host) {
      if (inline) { inline.remove(); inline = null; inlineResize.disconnect(); }
      return false;
    }
    if (!inline) {
      inline = el('details', `${NS}-inline`);
      inline.open = inlineOpen;
      inline.addEventListener('toggle', () => { inlineOpen = inline.open; try { chrome.storage.local.set({ inlineOpen }); } catch (_) { /* ignore */ } renderInline(); });
      inlineResize.observe(inline);
    }
    if (host.previousElementSibling !== inline) {
      host.before(inline);
      renderInline();
    }
    return true;
  }

  function renderInline() {
    if (!inline || !inline.isConnected) return;
    inline.textContent = '';
    const summary = el('summary', `${NS}-inline-summary`);
    summary.append(el('span', `${NS}-inline-title`, 'Change heatmap'));
    if (state.status === 'ready') {
      const t = state.model.totals;
      summary.append(
        el('span', `${NS}-add`, `+${L.formatCount(t.additions)}`),
        el('span', `${NS}-del`, `−${L.formatCount(t.deletions)}`),
        blocksEl(t.additions, t.deletions),
      );
    }
    inline.append(summary);
    if (!inline.open) return;
    const body = el('div', `${NS}-inline-body`);
    inline.append(body);
    fillHeatmap(body, { compact: true });
    inlineWidth = inline.clientWidth;
  }

  /* ------------------------------------------------------------------ heat stripe on diff file headers */

  function decorateDiffHeaders() {
    const { maxFile } = state.model;
    for (const [path, hash] of state.pathToHash) {
      const file = document.getElementById(`diff-${hash}`)
        || document.querySelector(`.file[data-tagsearch-path="${CSS.escape(path)}"]`);
      if (!file) continue;
      const header = file.querySelector('.file-header, [class*="DiffFileHeader"], [class*="diff-file-header"]')
        || file.firstElementChild;
      if (!header) continue;
      if (!settings.heatmap) {
        if (header.classList.contains(`${NS}-file-heat`)) {
          header.classList.remove(`${NS}-file-heat`);
          header.style.removeProperty('--locdiff-heat');
        }
        continue;
      }
      const node = state.model.files.get(path);
      const t = L.heat(L.churn(node), maxFile, settings.scale).toFixed(3);
      if (!header.classList.contains(`${NS}-file-heat`)) header.classList.add(`${NS}-file-heat`);
      if (header.style.getPropertyValue('--locdiff-heat') !== t) header.style.setProperty('--locdiff-heat', t);
    }
  }

  function blocksEl(a, d) {
    const wrap = el('span', `${NS}-blocks`);
    for (const kind of L.diffstatBlocks(a, d, 5)) wrap.append(el('span', `${NS}-block ${NS}-block--${kind}`));
    return wrap;
  }

  function hotList(title, nodes, clickable, n) {
    const section = el('div', `${NS}-hot`);
    section.append(el('h4', null, title));
    const top = nodes.filter((n) => L.churn(n) > 0).sort((a, b) => L.churn(b) - L.churn(a)).slice(0, n || 8);
    const max = top.length ? L.churn(top[0]) : 1;
    const list = el('ol');
    for (const n of top) {
      const li = el('li');
      const name = el(clickable ? 'button' : 'span', `${NS}-hot-name`, n.path + (n.isDir ? '/' : ''));
      name.title = n.path;
      if (clickable) { name.type = 'button'; name.addEventListener('click', () => navigateTo(n.path)); }
      const bar = el('span', `${NS}-hot-bar`);
      const addW = (n.additions / max) * 100;
      const delW = (n.deletions / max) * 100;
      bar.append(el('span', `${NS}-hot-bar-add`), el('span', `${NS}-hot-bar-del`));
      bar.children[0].style.width = `${addW}%`;
      bar.children[1].style.width = `${delW}%`;
      const stats = el('span', `${NS}-hot-stats`);
      stats.append(el('span', `${NS}-add`, `+${L.formatCount(n.additions)}`), el('span', `${NS}-del`, `−${L.formatCount(n.deletions)}`));
      li.append(name, stats, bar);
      list.append(li);
    }
    if (!top.length) section.append(el('p', `${NS}-muted`, 'No line changes.'));
    else section.append(list);
    return section;
  }

  function drawTreemap(container, dirNode, x, y, w, h, depth, maxFile) {
    const children = L.compactChildren(dirNode).map((c) => ({ ...c, value: Math.max(1, L.churn(c.node)) }));
    for (const r of L.squarify(children, x, y, w, h)) {
      const { node, label } = r.item;
      if (node.isDir) {
        const showHeader = r.w > 48 && r.h > 34;
        const box = el('div', `${NS}-tm-dir`);
        place(box, r);
        box.title = `${node.path}/ — ${node.fileCount} files, +${node.additions} −${node.deletions}`;
        if (showHeader) box.append(el('span', `${NS}-tm-dir-label`, label));
        container.append(box);
        const pad = 2;
        const top = showHeader ? 15 : pad;
        if (r.w - 2 * pad > 2 && r.h - top - pad > 2) {
          drawTreemap(container, node, r.x + pad, r.y + top, r.w - 2 * pad, r.h - top - pad, depth + 1, maxFile);
        }
      } else {
        const cell = el('div', `${NS}-tm-file`);
        cell.tabIndex = 0;
        cell.setAttribute('role', 'button');
        cell.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); navigateTo(node.path); } });
        place(cell, r);
        const t = L.heat(L.churn(node), maxFile, settings.scale);
        cell.style.background = panelColorMode === 'ratio' ? ratioColor(node) : heatColor(t);
        if (panelColorMode === 'heat' && t > 0.65) cell.classList.add(`${NS}-tm-file--dark`);
        cell.title = `${node.path}\n+${node.additions} −${node.deletions}${node.status ? ` (${node.status})` : ''}`;
        if (r.w > 36 && r.h > 14) cell.textContent = label;
        cell.addEventListener('click', () => navigateTo(node.path));
        container.append(cell);
      }
    }
  }

  function place(e, r) {
    e.style.left = `${r.x}px`;
    e.style.top = `${r.y}px`;
    e.style.width = `${Math.max(0, r.w)}px`;
    e.style.height = `${Math.max(0, r.h)}px`;
  }

  /* ------------------------------------------------------------------ main loop */

  function pass() {
    scheduled = false;
    const info = pageInfo(location);
    const key = info ? JSON.stringify(info) : null;
    if (key !== state.key) {
      undecorateAll();
      if (panel) { panel.remove(); panel = null; }
      if (inline) { inline.remove(); inline = null; inlineResize.disconnect(); }
      state = freshState(key);
      resolveCache = new WeakMap();
      if (info) load(info);
    }
    observer.disconnect();
    try {
      if (state.status === 'ready') { decorate(); decorateDiffHeaders(); }
      ensureInline();
    } finally { observe(); }
    renderButton();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(pass, 150);
  }

  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      const t = m.target;
      if (t.nodeType === 1 && t.closest && t.closest(`.${NS}-panel, .${NS}-fab, .${NS}-badge, .${NS}-inline`)) continue;
      schedule();
      return;
    }
  });
  function observe() {
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  document.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && (e.key === 'H' || e.key === 'h' || e.code === 'KeyH') && state.key) {
      e.preventDefault();
      if (inline && inline.isConnected) {
        inline.open = !inline.open;
        if (inline.open) inline.scrollIntoView({ block: 'nearest' });
      } else togglePanel();
    } else if (e.key === 'Escape' && panel) {
      togglePanel();
    }
  });
  for (const ev of ['turbo:load', 'turbo:render', 'pjax:end', 'popstate', 'hashchange']) {
    window.addEventListener(ev, schedule);
    document.addEventListener(ev, schedule);
  }

  try {
    chrome.storage.local.get({ inlineOpen: false }, (v) => {
      inlineOpen = v.inlineOpen === true;
      if (inline) inline.open = inlineOpen;
    });
  } catch (_) { /* ignore */ }
  chrome.storage.sync.get(DEFAULTS, (s) => {
    settings = { ...DEFAULTS, ...s };
    observe();
    pass();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    for (const [k, v] of Object.entries(changes)) if (k in DEFAULTS) settings[k] = v.newValue;
    if ('token' in changes && state.info) { load(state.info, true); }
    schedule();
    renderPanel();
  });

  // Exposed for the test harness only.
  globalThis.__locdiff = { pageInfo, get state() { return state; }, pass };
})();
