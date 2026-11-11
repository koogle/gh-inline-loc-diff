/*
 * Pure helpers shared by the content script, the service worker and the tests.
 * No DOM or chrome.* APIs in here.
 */
(function (root) {
  'use strict';

  /** Decode a git C-style quoted path ("a/foo\303\244.txt") into a JS string. */
  function unquotePath(p) {
    if (!p || p[0] !== '"' || p[p.length - 1] !== '"') return p;
    const body = p.slice(1, -1);
    const bytes = [];
    for (let i = 0; i < body.length; i++) {
      const c = body[i];
      if (c !== '\\') {
        // Non-escaped chars: encode as UTF-8 so mixing with octal bytes works.
        for (const b of new TextEncoder().encode(c)) bytes.push(b);
        continue;
      }
      const n = body[++i];
      if (n >= '0' && n <= '7') {
        const oct = body.substr(i, 3);
        bytes.push(parseInt(oct, 8));
        i += 2;
      } else {
        const map = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, '\\': 92 };
        bytes.push(map[n] !== undefined ? map[n] : n.charCodeAt(0));
      }
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }

  function stripPrefix(p) {
    p = unquotePath(p.trim());
    if (p === '/dev/null') return null;
    return p.replace(/^[ab]\//, '');
  }

  /** Path from a "diff --git a/X b/Y" line when X === Y (the common, unambiguous case). */
  function pathFromGitHeader(line) {
    const rest = line.slice('diff --git '.length);
    if (rest[0] === '"') {
      const m = rest.match(/^("(?:[^"\\]|\\.)*")\s+("(?:[^"\\]|\\.)*"|\S.*)$/);
      if (m) return stripPrefix(m[2]);
    }
    if ((rest.length - 5) % 2 === 0) {
      const len = (rest.length - 5) / 2;
      const a = rest.slice(2, 2 + len);
      const b = rest.slice(len + 5);
      if (a === b && rest.startsWith('a/') && rest.slice(len + 2, len + 5) === ' b/') return b;
    }
    const idx = rest.lastIndexOf(' b/');
    return idx >= 0 ? rest.slice(idx + 3) : rest;
  }

  /**
   * Parse a unified git diff (as served by github.com/.../pull/N.diff) into
   * per-file stats: [{ path, oldPath, additions, deletions, status, binary }].
   */
  function parseUnifiedDiff(text) {
    const files = [];
    let cur = null;
    let inHunk = false;
    const lines = text.split('\n');

    const finish = () => {
      if (!cur) return;
      cur.path = cur.newPath || cur.headerPath || cur.oldPathHdr;
      cur.oldPath = cur.renameFrom || (cur.oldPathHdr && cur.oldPathHdr !== cur.path ? cur.oldPathHdr : null);
      if (!cur.status) cur.status = 'modified';
      if (cur.path) {
        files.push({
          path: cur.path,
          oldPath: cur.oldPath || null,
          additions: cur.additions,
          deletions: cur.deletions,
          status: cur.status,
          binary: cur.binary,
        });
      }
      cur = null;
    };

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];
      if (line.endsWith('\r')) line = line.slice(0, -1);

      if (line.startsWith('diff --git ')) {
        finish();
        cur = {
          headerPath: pathFromGitHeader(line),
          newPath: null, oldPathHdr: null, renameFrom: null,
          additions: 0, deletions: 0, status: null, binary: false,
        };
        inHunk = false;
        continue;
      }
      if (!cur) continue;

      if (inHunk) {
        const c = line[0];
        if (c === '+') { cur.additions++; continue; }
        if (c === '-') { cur.deletions++; continue; }
        if (c === ' ' || c === '\\' || line === '') continue;
        if (!line.startsWith('@@')) inHunk = false; // fall through to header parsing
      }

      if (line.startsWith('@@')) { inHunk = true; continue; }
      if (line.startsWith('--- ')) {
        const p = stripPrefix(line.slice(4));
        if (p) cur.oldPathHdr = p;
        continue;
      }
      if (line.startsWith('+++ ')) {
        const p = stripPrefix(line.slice(4));
        if (p) cur.newPath = p;
        continue;
      }
      if (line.startsWith('new file mode')) { cur.status = 'added'; continue; }
      if (line.startsWith('deleted file mode')) { cur.status = 'removed'; continue; }
      if (line.startsWith('rename from ')) { cur.renameFrom = unquotePath(line.slice(12)); cur.status = cur.status || 'renamed'; continue; }
      if (line.startsWith('rename to ')) { cur.newPath = unquotePath(line.slice(10)); cur.status = cur.status || 'renamed'; continue; }
      if (line.startsWith('copy to ')) { cur.newPath = unquotePath(line.slice(8)); cur.status = cur.status || 'copied'; continue; }
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') { cur.binary = true; continue; }
    }
    finish();
    return files;
  }

  /**
   * Build a directory tree with aggregated stats.
   * Returns { root, files: Map<path, node>, dirs: Map<path, node>, maxFile, maxDir, totals }.
   */
  function buildTree(fileList) {
    const mkDir = (name, path, parent) => ({
      name, path, parent, isDir: true, children: new Map(),
      additions: 0, deletions: 0, fileCount: 0,
    });
    const root = mkDir('', '', null);
    const files = new Map();
    const dirs = new Map([['', root]]);

    for (const f of fileList) {
      const parts = f.path.split('/').filter(Boolean);
      let dir = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts.slice(0, i + 1).join('/');
        let next = dir.children.get(parts[i]);
        if (!next || !next.isDir) {
          next = mkDir(parts[i], p, dir);
          dir.children.set(parts[i], next);
          dirs.set(p, next);
        }
        dir = next;
      }
      const leaf = {
        name: parts[parts.length - 1], path: f.path, parent: dir, isDir: false,
        additions: f.additions | 0, deletions: f.deletions | 0, fileCount: 1,
        status: f.status, oldPath: f.oldPath || null, binary: !!f.binary,
      };
      dir.children.set(leaf.name, leaf);
      files.set(f.path, leaf);
      for (let d = dir; d; d = d.parent) {
        d.additions += leaf.additions;
        d.deletions += leaf.deletions;
        d.fileCount += 1;
      }
    }

    let maxFile = 0;
    for (const f of files.values()) maxFile = Math.max(maxFile, churn(f));
    let maxDir = 0;
    for (const d of dirs.values()) if (d !== root) maxDir = Math.max(maxDir, churn(d));

    return {
      root, files, dirs, maxFile, maxDir,
      totals: { additions: root.additions, deletions: root.deletions, files: files.size },
    };
  }

  function churn(n) { return (n.additions || 0) + (n.deletions || 0); }

  /** Normalised 0..1 intensity. scale: 'log' | 'linear'. */
  function heat(value, max, scale) {
    if (!max || value <= 0) return 0;
    if (scale === 'linear') return Math.min(1, value / max);
    return Math.min(1, Math.log1p(value) / Math.log1p(max));
  }

  function formatCount(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    if (n < 1e6) return Math.round(n / 1000) + 'k';
    return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  }

  /** GitHub-style 5-block diffstat: returns e.g. ['add','add','del','neutral','neutral']. */
  function diffstatBlocks(additions, deletions, n) {
    n = n || 5;
    const total = additions + deletions;
    if (!total) return Array(n).fill('neutral');
    // Small changes don't fill every block, like GitHub does.
    const filled = Math.max(1, Math.min(n, total < n ? total : n));
    let add = Math.round((additions / total) * filled);
    if (additions > 0 && add === 0) add = 1;
    if (deletions > 0 && add === filled) add = filled - 1;
    const del = filled - add;
    return [
      ...Array(add).fill('add'),
      ...Array(del).fill('del'),
      ...Array(n - filled).fill('neutral'),
    ];
  }

  /**
   * Squarified treemap (Bruls et al.). items: [{ value }], any order.
   * Returns [{ item, x, y, w, h }].
   */
  function squarify(items, x, y, w, h) {
    const list = items.filter((it) => it.value > 0).sort((a, b) => b.value - a.value);
    const total = list.reduce((s, it) => s + it.value, 0);
    const out = [];
    if (!total || w <= 0 || h <= 0) return out;
    const scale = (w * h) / total;
    const areas = list.map((it) => it.value * scale);
    const rect = { x, y, w, h };

    const worst = (row, side) => {
      let s = 0, mx = -Infinity, mn = Infinity;
      for (const a of row) { s += a; if (a > mx) mx = a; if (a < mn) mn = a; }
      const s2 = s * s, side2 = side * side;
      return Math.max((side2 * mx) / s2, s2 / (side2 * mn));
    };
    const layoutRow = (rowIdx) => {
      const s = rowIdx.reduce((acc, i) => acc + areas[i], 0);
      if (rect.w >= rect.h) {
        const colW = s / rect.h;
        let yy = rect.y;
        for (const i of rowIdx) {
          const hh = areas[i] / colW;
          out.push({ item: list[i], x: rect.x, y: yy, w: colW, h: hh });
          yy += hh;
        }
        rect.x += colW; rect.w -= colW;
      } else {
        const rowH = s / rect.w;
        let xx = rect.x;
        for (const i of rowIdx) {
          const ww = areas[i] / rowH;
          out.push({ item: list[i], x: xx, y: rect.y, w: ww, h: rowH });
          xx += ww;
        }
        rect.y += rowH; rect.h -= rowH;
      }
    };

    let row = [];
    let i = 0;
    while (i < areas.length) {
      const side = Math.min(rect.w, rect.h);
      const rowAreas = row.map((j) => areas[j]);
      if (row.length === 0 || worst(rowAreas.concat(areas[i]), side) <= worst(rowAreas, side)) {
        row.push(i++);
      } else {
        layoutRow(row);
        row = [];
      }
    }
    if (row.length) layoutRow(row);
    return out;
  }

  /** Collapse single-child directory chains (a -> b -> c) into "a/b/c" for display. */
  function compactChildren(dirNode) {
    return [...dirNode.children.values()].map((child) => {
      let node = child;
      let label = child.name;
      while (node.isDir && node.children.size === 1) {
        const only = node.children.values().next().value;
        if (!only.isDir) break;
        node = only;
        label += '/' + only.name;
      }
      return { node, label };
    });
  }

  const api = {
    unquotePath, parseUnifiedDiff, buildTree, churn, heat,
    formatCount, diffstatBlocks, squarify, compactChildren,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LocDiff = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
