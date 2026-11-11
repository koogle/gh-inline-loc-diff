# GitHub Inline LOC Diff

A Chrome extension (Manifest V3) for GitHub's diff views (pull request **Files changed**, single commits, and compare pages). It adds:

- **Inline line counts in the file-tree sidebar**: every file shows `+added −deleted`. Every folder shows the total for everything under it, so you can see where the change went without expanding folders.
- **A heatmap in the sidebar**: rows are tinted from pale yellow to deep red by churn (additions + deletions), so the hottest parts of the change stand out. Files and folders are scaled separately.
- **A treemap panel** (floating button in the bottom-right corner, or <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd>). It shows the whole change as a nested treemap where area = churn and colour = heat, or added-vs-deleted ratio. Below it are the hottest directories and files. Click a file to jump to its diff.

## Install (unpacked)

1. Clone this repository.
2. Open `chrome://extensions` and turn on **Developer mode**.
3. Click **Load unpacked** and select the repository folder (the one that contains `manifest.json`).
4. Open any pull request's *Files changed* tab.

To change settings, click the toolbar icon. The options are badges on/off, heatmap on/off, tint vs. bar style, log vs. linear scale, the floating button, and an optional token.

## How it gets the numbers

GitHub's file tree doesn't contain line counts, so the extension fetches them itself through the service worker:

1. **Default:** `https://github.com/<owner>/<repo>/pull/<n>.diff` (or `commit/<sha>.diff`, `compare/<range>.diff`) with your normal github.com session, parsed locally. No token needed, and it works for private repos you can see.
2. **With a token** set in the options, or as a fallback: the REST API (`pulls/<n>/files`, paginated up to 3000 files). This is useful when GitHub refuses to render a very large `.diff`.

Tree rows are matched to files by GitHub's `#diff-<sha256(path)>` anchors. If a row has no anchor, the extension uses the item id, then the path rebuilt from the tree's nesting (including compacted `a/b/c` folder labels). This means it works with both the classic ActionList tree and the newer React TreeView. A `MutationObserver` re-applies the decorations as GitHub navigates (Turbo/React), lazy-loads, or expands folders.

## Development

```
src/diffstat.js    pure helpers: diff parser, tree aggregation, heat scale, squarified treemap
src/background.js  service worker: .diff / REST API fetching, small cache
src/content.js     sidebar decoration, floating button and treemap panel
src/content.css    styles (uses GitHub's Primer CSS variables, so light and dark themes both work)
src/options.*      options page
```

```bash
npm test                 # unit tests for the parser / aggregation / treemap (node --test)
node tests/e2e.js out.png  # loads the unpacked extension in Chromium against a mocked PR page
```

`tests/e2e.js` needs Playwright with a full Chromium build, because headless-shell can't load extensions.

GitHub changes its DOM often. If badges stop showing up, the selectors to check are `LABEL_SELECTORS` and `rowOf()` in `src/content.js`.
