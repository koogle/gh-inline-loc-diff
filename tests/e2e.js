// Loads the unpacked extension in Chromium against a mocked github.com PR page.
// Run: node tests/e2e.js [screenshot.png]
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const fx = (f) => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'locdiff-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium',
    args: ['--headless=new', `--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: { width: 1100, height: 760 },
  });
  const html = fx('pr-files.html').replace(/HASH_([^"]+)/g, (_, p) => sha(p));
  await ctx.route('https://github.com/**', (route) => {
    const url = route.request().url();
    if (url.endsWith('/pull/1.diff')) return route.fulfill({ status: 200, contentType: 'text/plain', body: fx('pr.diff') });
    return route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  // Extension service worker requests may bypass page routing: stub fetch in the worker too.
  await sw.evaluate((diff) => {
    const orig = self.fetch;
    self.fetch = (url, opts) => (String(url).endsWith('/pull/1.diff')
      ? Promise.resolve(new Response(diff, { status: 200 }))
      : orig(url, opts));
  }, fx('pr.diff'));

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('https://github.com/o/r/pull/1/files');
  await page.waitForSelector('.locdiff-badge', { timeout: 10000 });
  await page.waitForTimeout(400);

  const badges = await page.$$eval('[role="treeitem"]', (items) => items.map((li) => {
    const row = [...li.children].find((c) => c.tagName !== 'UL' && !c.hidden);
    const b = row.querySelector('.locdiff-badge');
    if (b && !b.offsetParent) return { label: 'HIDDEN BADGE', badge: null, heat: '' };
    const label = row.querySelector('.ActionList-item-label, .PRIVATE_TreeView-item-content-text, [class*="TreeViewItemContentText"]');
    return { label: label.firstChild.textContent.trim(), badge: b ? [...b.children].filter((c) => !c.hidden).map((c) => c.textContent).join('') : null, add: row.style.getPropertyValue('--locdiff-add'), heat: row.style.getPropertyValue('--locdiff-heat') };
  }));
  console.table(badges);

  const expect = {
    src: '+122−31', 'lib/util': '+120−30', 'math.js': '+120−30', 'app.js': '+2−1',
    'README.md': '+1', 'guide.md': '+9', docs: '+9', 'src/lib/util': '+120−30',
  };
  let fail = 0;
  for (const b of badges) {
    if (expect[b.label] !== b.badge) { fail++; console.error('MISMATCH', b, 'expected', expect[b.label]); }
  }

  // Heatmap is embedded right above the (first) file tree, so no floating button. Starts collapsed.
  await page.click('.locdiff-inline-summary');
  await page.waitForSelector('.locdiff-inline .locdiff-tm-file');
  const inline = await page.evaluate(() => {
    const box = document.querySelector('.locdiff-inline');
    return {
      beforeTree: box.nextElementSibling && box.nextElementSibling.tagName.toLowerCase(),
      cells: box.querySelectorAll('.locdiff-tm-file').length,
      summary: box.querySelector('summary').textContent,
      fab: !!document.querySelector('.locdiff-fab'),
      headers: [...document.querySelectorAll('.file-header')].map((h) => h.style.getPropertyValue('--locdiff-heat')),
    };
  });
  console.log(inline);
  if (inline.beforeTree !== 'file-tree' || inline.cells !== 4 || inline.fab) fail++;
  if (inline.headers.some((h) => !h)) fail++;
  if (process.argv[2]) await page.screenshot({ path: process.argv[2] });

  // Clicking a treemap cell navigates to the file (tree link -> #diff-<hash>).
  await page.click('.locdiff-inline .locdiff-hot-name >> text=src/app.js');
  const hash = await page.evaluate(() => location.hash);
  if (hash !== '#diff-' + crypto.createHash('sha256').update('src/app.js').digest('hex')) { fail++; console.error('nav hash', hash); }

  // Open/closed state persists across a reload.
  await page.waitForTimeout(300);
  await page.reload();
  await page.waitForSelector('.locdiff-inline');
  await page.waitForTimeout(300);
  if (!(await page.$eval('.locdiff-inline', (d) => d.open))) { fail++; console.error('open state not persisted'); }
  if (errors.length) { fail++; console.error('page errors', errors); }
  await ctx.close();
  console.log(fail ? `FAILED (${fail})` : 'OK');
  process.exit(fail ? 1 : 0);
})();
