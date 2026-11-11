const test = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/diffstat.js');

const DIFF = [
  'diff --git a/src/app.js b/src/app.js',
  'index 1111111..2222222 100644',
  '--- a/src/app.js',
  '+++ b/src/app.js',
  '@@ -1,4 +1,5 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  '--- not a header, a removed line starting with dashes',
  '+++ an added line starting with pluses',
  ' end',
  '\\ No newline at end of file',
  'diff --git a/docs/new file.md b/docs/new file.md',
  'new file mode 100644',
  'index 0000000..3333333',
  '--- /dev/null',
  '+++ b/docs/new file.md',
  '@@ -0,0 +1,2 @@',
  '+# Title',
  '+',
  'diff --git a/old/gone.txt b/old/gone.txt',
  'deleted file mode 100644',
  '--- a/old/gone.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/lib/a.js b/lib/b.js',
  'similarity index 90%',
  'rename from lib/a.js',
  'rename to lib/b.js',
  'diff --git a/img/logo.png b/img/logo.png',
  'index 4444444..5555555 100644',
  'Binary files a/img/logo.png and b/img/logo.png differ',
  'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
  '--- "a/caf\\303\\251.txt"',
  '+++ "b/caf\\303\\251.txt"',
  '@@ -1 +1 @@',
  '-x',
  '+y',
  '',
].join('\n');

test('parseUnifiedDiff counts lines per file', () => {
  const files = L.parseUnifiedDiff(DIFF);
  const by = Object.fromEntries(files.map((f) => [f.path, f]));
  assert.deepEqual(Object.keys(by), ['src/app.js', 'docs/new file.md', 'old/gone.txt', 'lib/b.js', 'img/logo.png', 'café.txt']);
  assert.equal(by['src/app.js'].additions, 3);
  assert.equal(by['src/app.js'].deletions, 2);
  assert.equal(by['docs/new file.md'].status, 'added');
  assert.equal(by['docs/new file.md'].additions, 2);
  assert.equal(by['old/gone.txt'].status, 'removed');
  assert.equal(by['old/gone.txt'].deletions, 1);
  assert.equal(by['lib/b.js'].status, 'renamed');
  assert.equal(by['lib/b.js'].oldPath, 'lib/a.js');
  assert.equal(by['img/logo.png'].binary, true);
  assert.equal(by['café.txt'].additions, 1);
});

test('parseUnifiedDiff handles CRLF', () => {
  const files = L.parseUnifiedDiff(DIFF.replace(/\n/g, '\r\n'));
  assert.equal(files[0].additions, 3);
});

test('buildTree aggregates directories', () => {
  const m = L.buildTree([
    { path: 'a/b/x.js', additions: 10, deletions: 2 },
    { path: 'a/b/y.js', additions: 1, deletions: 1 },
    { path: 'a/z.js', additions: 0, deletions: 5 },
    { path: 'README.md', additions: 3, deletions: 0 },
  ]);
  assert.equal(m.dirs.get('a').additions, 11);
  assert.equal(m.dirs.get('a').deletions, 8);
  assert.equal(m.dirs.get('a').fileCount, 3);
  assert.equal(m.dirs.get('a/b').fileCount, 2);
  assert.deepEqual(m.totals, { additions: 14, deletions: 8, files: 4 });
  assert.equal(m.maxFile, 12);
  assert.equal(m.maxDir, 19);
});

test('compactChildren collapses single-child chains', () => {
  const m = L.buildTree([{ path: 'a/b/c/x.js', additions: 1, deletions: 0 }, { path: 'r.md', additions: 1, deletions: 0 }]);
  const labels = L.compactChildren(m.root).map((c) => c.label).sort();
  assert.deepEqual(labels, ['a/b/c', 'r.md']);
});

test('heat is monotonic and bounded', () => {
  assert.equal(L.heat(0, 100, 'log'), 0);
  assert.equal(L.heat(100, 100, 'log'), 1);
  assert.ok(L.heat(10, 100, 'log') > L.heat(10, 100, 'linear'));
  assert.equal(L.heat(500, 100, 'linear'), 1);
});

test('squarify fills the rectangle exactly', () => {
  const items = [6, 6, 4, 3, 2, 2, 1].map((value) => ({ value }));
  const rects = L.squarify(items, 0, 0, 600, 400);
  assert.equal(rects.length, items.length);
  const area = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(area - 600 * 400) < 1e-6);
  for (const r of rects) {
    assert.ok(r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 600 + 1e-6 && r.y + r.h <= 400 + 1e-6);
    assert.ok(Math.abs(r.w * r.h - (r.item.value / 24) * 240000) < 1e-6);
  }
});

test('formatCount and diffstatBlocks', () => {
  assert.equal(L.formatCount(999), '999');
  assert.equal(L.formatCount(1234), '1.2k');
  assert.equal(L.formatCount(45000), '45k');
  assert.deepEqual(L.diffstatBlocks(0, 0), ['neutral', 'neutral', 'neutral', 'neutral', 'neutral']);
  assert.deepEqual(L.diffstatBlocks(2, 0), ['add', 'add', 'neutral', 'neutral', 'neutral']);
  assert.deepEqual(L.diffstatBlocks(100, 1), ['add', 'add', 'add', 'add', 'del']);
});
