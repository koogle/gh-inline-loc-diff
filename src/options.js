const DEFAULTS = { badges: true, heatmap: true, heatStyle: 'tint', scale: 'log', panelButton: true, inlineHeatmap: true, token: '' };
const $ = (id) => document.getElementById(id);
let timer;

function flash(msg) {
  $('status').textContent = msg;
  clearTimeout(timer);
  timer = setTimeout(() => { $('status').textContent = ''; }, 1500);
}

chrome.storage.sync.get(DEFAULTS, (s) => {
  for (const [k, v] of Object.entries(s)) {
    const input = $(k);
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!v; else input.value = v;
  }
});

for (const k of Object.keys(DEFAULTS)) {
  const input = $(k);
  input.addEventListener('change', () => {
    const value = input.type === 'checkbox' ? input.checked : input.value.trim();
    chrome.storage.sync.set({ [k]: value }, () => flash('Saved'));
  });
}
