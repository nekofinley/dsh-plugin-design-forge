/**
 * Standalone end-to-end test for dsh-plugin-design-forge.
 * Runs the real plugin `apply()` against a fake ctx whose `web.fetch` serves
 * local fixtures (a crafted design-system page + a real local HTML file),
 * then drives both tools' execute() directly. No network, no harness.
 *
 * Usage: node test/run.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { apply, __internals } from '../lib/index.js';

// ---------------------------------------------------------------------------
// Fixture: a crafted page with a rich design system
// ---------------------------------------------------------------------------

const FIXTURES = new Map();

FIXTURES.set('https://design.test/', `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<title>Acme Design System</title>
<meta name="description" content="A crafted fixture">
<meta property="og:site_name" content="Acme">
<meta property="og:image" content="/og.png">
<meta name="theme-color" content="#5b5bd6">
<link rel="icon" href="/favicon.ico">
<link rel="stylesheet" href="/assets/main.css">
<link rel="stylesheet" href="/assets/fonts.css">
<link rel="stylesheet" href="/assets/broken.css">
<style>
  :root {
    --color-bg: #ffffff;
    --color-fg: #101828;
    --color-brand: #5b5bd6;
    --color-brand-soft: rgb(91 91 214 / 0.12);
    --radius-card: 12px;
    --shadow-card: 0 1px 2px rgba(16, 24, 40, 0.06), 0 1px 3px rgba(16, 24, 40, 0.1);
    --font-sans: "Inter", system-ui, sans-serif;
  }
  [data-theme="dark"] {
    --color-bg: #0c111d;
    --color-fg: #f2f4f7;
    --color-brand: #7a7af0;
  }
  @media (prefers-color-scheme: dark) {
    :root { --color-bg: #0c111d; }
  }
  body {
    background: var(--color-bg);
    color: var(--color-fg);
    font-family: "Inter", system-ui, sans-serif;
    font-size: 16px;
    line-height: 1.6;
    margin: 0;
  }
  h1 { font-size: 2.25rem; font-weight: 700; letter-spacing: -0.02em; }
  p  { font-size: 0.875rem; font-weight: 400; margin: 0 0 16px; }
  .card {
    background: #fff;
    border-radius: 12px;
    box-shadow: 0 1px 2px rgba(16, 24, 40, 0.06);
    padding: 24px 32px;
    gap: 8px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }
  .hero {
    background: linear-gradient(135deg, #5b5bd6 0%, #ad1a72 100%);
    max-width: 1200px;
    padding: 96px 0;
  }
  .btn { border-radius: 8px; padding: 10px 16px; color: #5b5bd6; }
  .footer { color: whitesmoke; background: #101828; }
  @media (min-width: 768px) { .card { padding: 32px; } }
  @media (min-width: 1280px) { .hero { max-width: 1440px; } }
</style>
</head>
<body style="color:#101828;padding:0 16px">
  <h1 style="font-size:36px">Hello</h1>
</body>
</html>`);

FIXTURES.set('https://design.test/assets/main.css', `@import url("https://design.test/assets/tokens.css");
/* don't panic } { tricky -- comment content must not break the parser */
.container { max-width: 1152px; margin: 0 auto; }
:root { --space-unit: 4px; --color-link: hsl(220 90% 55%); --text-lg: 20px; }
a { color: var(--color-link); text-decoration-thickness: 1px; }
h2 { font-family: var(--font-sans); }
.big { font-size: var(--text-lg); }
.grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; padding: 0 24px; }
.button-primary {
  background: #5b5bd6;
  color: #fff;
  border-radius: 9999px;
  box-shadow: 0 4px 12px rgba(91, 91, 214, 0.4);
  animation: pulse 2s ease-in-out infinite;
}
.after-comment { box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1); }
.badge { border-radius: 6px; padding: 2px 8px; }
@keyframes pulse { from { opacity: 1; } to { opacity: 0.6; } }`);

FIXTURES.set('https://design.test/assets/tokens.css', `:root {
  --ds-color-primary: #5b5bd6;
  --ds-color-danger: oklch(0.6 0.2 25);
  --ds-radius-full: 9999px;
}`);

FIXTURES.set('https://design.test/assets/fonts.css', `@font-face {
  font-family: "Inter";
  font-style: normal;
  font-weight: 400 700;
  src: url("/fonts/inter.woff2") format("woff2");
}
@font-face {
  font-family: "IBM Plex Mono";
  font-weight: 500;
  src: url("/fonts/plx.woff2") format("woff2");
}
code, pre { font-family: "IBM Plex Mono", ui-monospace, monospace; font-size: 14px; }`);

// A CSS served with a non-text content type (must be skipped gracefully).
FIXTURES.set('https://design.test/assets/broken.css', 'ignored');

// A second, unrelated site: used by the design_discover tests.
FIXTURES.set('https://acme-two.test/', `<!doctype html>
<html lang="en">
<head><title>Two</title>
<style>
  :root { --brand: #ff5500; }
  body { background: #0b0b0b; color: #fafafa; font-family: Georgia, serif; font-size: 15px; }
  .panel { border-radius: 10px; padding: 12px; box-shadow: 0 2px 8px #00000080; }
</style>
</head>
<body><h1>Two</h1></body>
</html>`);

// ---------------------------------------------------------------------------
// Fake ctx + ordered check harness
// ---------------------------------------------------------------------------

const registered = { tools: [], sections: [] };
const fetchLog = [];

let webFetch = async (request) => {
  const url = request.url;
  fetchLog.push(url);
  const content = FIXTURES.get(url);
  if (url.endsWith('broken.css')) {
    return { url, statusCode: 200, body: { kind: 'binary-not-text', content: null } };
  }
  if (content === undefined) {
    return { url, statusCode: 404, body: { kind: 'text', content: 'not found' } };
  }
  const kind = url.endsWith('.css') ? 'text' : 'html';
  return { url, statusCode: 200, body: { kind, content } };
};

// Replaced per-test by the design_discover checks; empty by default.
let webSearch = async () => ({ truncated: false, sources: [] });
const searchLog = [];

const ctx = {
  web: {
    fetch: (request, signal) => webFetch(request, signal),
    search: (request, signal) => {
      searchLog.push(request);
      return webSearch(request, signal);
    },
  },
  systemPrompt: { section: (section) => registered.sections.push(section) },
  tools: { register: (definition) => registered.tools.push(definition) },
};

const results = [];
class Skip extends Error {}

/**
 * Mirrors the harness tool-output contract: an own property whose value is
 * `undefined` is not lossless JSON and makes the whole call fail.
 */
function assertLossless(value, path = 'out') {
  if (value === undefined) throw new Error(`${path} is undefined (not lossless JSON)`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLossless(item, `${path}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) assertLossless(item, `${path}.${key}`);
  }
}

async function check(label, fn) {
  try {
    await fn();
    results.push(`PASS ${label}`);
  } catch (error) {
    if (error instanceof Skip) {
      results.push(`SKIP ${label}: ${error.message}`);
      return;
    }
    results.push(`FAIL ${label}: ${error.message}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'df-test-'));
apply(ctx, { storeDir });

await check('apply registers three tools', () => {
  assert.deepEqual(registered.tools.map((t) => t.name).sort(), ['design_capture', 'design_discover', 'design_library']);
});
await check('apply registers prompt section at 2155', () => {
  assert.equal(registered.sections.length, 1);
  assert.equal(registered.sections[0].order, 2155);
  assert.match(registered.sections[0].text, /design_library \{ action: "list" \}/);
  assert.match(registered.sections[0].text, /design_discover \{ query: "\.\.\." \}/);
});
const capture = registered.tools.find((t) => t.name === 'design_capture');
const library = registered.tools.find((t) => t.name === 'design_library');
const discover = registered.tools.find((t) => t.name === 'design_discover');

// 2. design_capture end-to-end
let summary;
await check('design_capture executes and returns a summary', async () => {
  summary = await capture.execute({ url: 'https://design.test', name: 'Acme', notes: 'crisp SaaS look' }, {});
  assert.equal(summary.ok, true);
  assert.equal(summary.id, 'acme');
  assert.equal(summary.url, 'https://design.test/');
});
const entry = JSON.parse(fs.readFileSync(path.join(storeDir, 'entries', 'acme.json'), 'utf8'));

await check('palette includes brand + neutrals with counts', () => {
  const values = entry.analysis.palette.map((c) => c.value);
  assert.ok(values.includes('#5b5bd6'), `brand color missing: ${values.join(', ')}`);
  assert.ok(values.includes('#101828'));
  assert.ok(values.includes('#ffffff'));
  const brand = entry.analysis.palette.find((c) => c.value === '#5b5bd6');
  assert.ok(brand.count >= 3, `brand count ${brand.count}`);
  assert.ok(entry.analysis.palette.every((c) => ['light', 'mid', 'dark'].includes(c.lum)));
});
await check('hsl normalized into palette', () => {
  const values = entry.analysis.palette.map((c) => c.value);
  // hsl(220 90% 55%) per the canonical HSL→RGB algorithm.
  assert.ok(values.includes('#256af4'), `hsl(220 90% 55%) → #256af4 missing: ${values.join(', ')}`);
});
await check('oklch token captured raw', () => {
  assert.equal(entry.tokens.light['--ds-color-danger'], 'oklch(0.6 0.2 25)');
});
await check('fonts: Inter + IBM Plex Mono with stacks', () => {
  const families = entry.analysis.fonts.map((f) => f.family);
  assert.ok(families.includes('Inter'), families.join(', '));
  assert.ok(families.includes('IBM Plex Mono'));
  const inter = entry.analysis.fonts.find((f) => f.family === 'Inter');
  assert.match(inter.stack, /system-ui/);
  assert.ok(entry.analysis.fontFaces.some((f) => f.family === 'Inter'));
});
await check('type scale sorted ascending', () => {
  const sizes = entry.analysis.fontSizes.map((s) => Number.parseFloat(s.value));
  const sorted = [...sizes].sort((a, b) => a - b);
  assert.deepEqual(sizes, sorted);
  assert.ok(sizes.includes(16), '16px base');
  assert.ok(sizes.includes(36), '36px from inline style');
});
await check('font weights captured', () => {
  const weights = entry.analysis.fontWeights.map((w) => w.value);
  assert.ok(weights.includes('700'));
  assert.ok(weights.includes('400'));
});
await check('spacing scale captured', () => {
  const spacings = entry.analysis.spacings.map((s) => s.value);
  assert.ok(spacings.includes('24px'), spacings.join(', '));
  assert.ok(spacings.includes('32px'));
  assert.ok(spacings.includes('96px'));
});
await check('radii captured (8px, 12px, 9999px)', () => {
  const radii = entry.analysis.radii.map((s) => s.value);
  assert.ok(radii.includes('8px'), radii.join(', '));
  assert.ok(radii.includes('12px'));
  assert.ok(radii.includes('9999px'));
});
await check('shadows captured with full strings', () => {
  assert.ok(entry.analysis.shadows.some((s) => s.value.includes('rgba(16, 24, 40, 0.06)')));
});
await check('gradient captured', () => {
  assert.ok(entry.analysis.gradients.some((g) => g.value.includes('linear-gradient(135deg, #5b5bd6 0%, #ad1a72 100%)')));
});
await check('motion: duration + easing', () => {
  assert.ok(entry.analysis.durations.some((d) => d.value === '200ms'), entry.analysis.durations.map((d) => d.value).join(','));
  assert.ok(entry.analysis.durations.some((d) => d.value === '2000ms'));
  assert.ok(entry.analysis.easings.some((e) => e.value.startsWith('cubic-bezier(')));
});
await check('var() resolved: font size + family from tokens', () => {
  const sizes = entry.analysis.fontSizes.map((s) => s.value);
  assert.ok(sizes.includes('20px'), `20px (var --text-lg) missing: ${sizes.join(', ')}`);
  assert.ok(entry.analysis.fonts.some((f) => f.family === 'Inter'), 'Inter via var(--font-sans)');
});
await check('comments with quotes/braces leave values clean', () => {
  for (const s of entry.analysis.shadows) {
    assert.ok(!s.value.includes('}'), `polluted shadow: ${s.value}`);
  }
  assert.ok(entry.analysis.shadows.some((x) => x.value === '0 2px 4px rgba(0, 0, 0, 0.1)'), 'rule after comment parsed');
});
await check('breakpoints 768/1280 + containers 1152/1200/1440', () => {
  const bp = entry.analysis.breakpoints.map((b) => b.value);
  assert.ok(bp.includes('768px'), bp.join(', '));
  assert.ok(bp.includes('1280px'));
  const cw = entry.analysis.containerWidths.map((b) => b.value);
  assert.ok(cw.includes('1200px'), cw.join(', '));
  assert.ok(cw.includes('1440px'));
});
await check('light + dark tokens separated', () => {
  assert.equal(entry.tokens.light['--color-brand'], '#5b5bd6');
  assert.equal(entry.tokens.dark['--color-bg'], '#0c111d');
  assert.equal(entry.tokens.light['--ds-color-primary'], '#5b5bd6');
  assert.ok(Object.keys(entry.tokens.light).length >= 5);
});
await check('meta extracted', () => {
  assert.equal(entry.meta.siteName, 'Acme');
  assert.equal(entry.meta.title, 'Acme Design System');
  assert.equal(entry.meta.themeColor, '#5b5bd6');
  assert.equal(entry.meta.favicon, 'https://design.test/favicon.ico');
});
await check('stats reflect sheets + skipped broken css', () => {
  assert.equal(entry.stats.styleBlocks, 1);
  assert.equal(entry.stats.stylesheetsUsed, 3);
  assert.ok(entry.stats.declarations > 40);
  const broken = entry.sources.find((s) => s.url.endsWith('broken.css'));
  assert.ok(broken && broken.error);
  const imported = entry.sources.find((s) => s.kind === 'stylesheet(@import)');
  assert.ok(imported, '@import followed');
});
await check('tokensCss ready to paste', () => {
  assert.match(entry.tokensCss, /:root \{/);
  assert.match(entry.tokensCss, /--color-brand: #5b5bd6;/);
  assert.match(entry.tokensCss, /\[data-theme="dark"\] \{/);
  assert.match(entry.tokensCss, /--df-color-1: #/);
});

// 3. design_library actions
await check('library list', async () => {
  const out = await library.execute({ action: 'list' }, {});
  assert.equal(out.total, 1);
  assert.equal(out.entries[0].id, 'acme');
  assert.ok(out.entries[0].palette.length > 0);
});
await check('library search by color', async () => {
  const out = await library.execute({ action: 'search', query: '#5b5bd6' }, {});
  assert.equal(out.total, 1);
});
await check('library search miss', async () => {
  const out = await library.execute({ action: 'search', query: 'zzz-not-there' }, {});
  assert.equal(out.total, 0);
});
await check('library export tokens', async () => {
  const out = await library.execute({ action: 'export', id: 'acme', format: 'tokens' }, {});
  assert.match(out.content, /--color-brand: #5b5bd6;/);
});
await check('library export spec', async () => {
  const out = await library.execute({ action: 'export', id: 'acme', format: 'spec' }, {});
  assert.match(out.content, /# Design spec — Acme/);
  assert.match(out.content, /\| `#5b5bd6` \|/);
  assert.match(out.content, /## Typography/);
});
await check('library get full entry', async () => {
  const out = await library.execute({ action: 'get', id: 'acme' }, {});
  assert.equal(out.entry.stats.declarations, entry.stats.declarations);
});
await check('library delete + list empty', async () => {
  await library.execute({ action: 'delete', id: 'acme' }, {});
  const out = await library.execute({ action: 'list' }, {});
  assert.equal(out.total, 0);
  assert.match(out.hint, /library is empty/);
});
await check('library get unknown id errors clearly', async () => {
  await assert.rejects(() => library.execute({ action: 'get', id: 'nope' }, {}), /no entry "nope"/);
});

// 3b. design_discover — search → filter → batch capture
await check('rankCandidates drops platforms/assets/docs and keeps one per host', () => {
  const ranked = __internals.rankCandidates([
    { url: 'https://www.youtube.com/watch?v=1', title: 'talk' },
    { url: 'https://github.com/a/b', title: 'repo' },
    { url: 'https://acme.test/files/whitepaper.pdf', title: 'pdf' },
    { url: 'https://acme.test/docs/getting-started', title: 'docs' },
    { url: 'https://acme.test/', title: 'home' },
    { url: 'https://www.acme.test/?utm_source=news', title: 'home again' },
    { url: 'https://bravo.test/pricing', title: 'pricing' },
  ], 5);
  assert.deepEqual(ranked.map((c) => c.url), ['https://acme.test/', 'https://bravo.test/pricing']);
  assert.ok(__internals.isNonDesignHost('m.youtube.com'));
  assert.ok(!__internals.isNonDesignHost('box.com'));
});

await check('rankCandidates strips tracking params and demotes listing pages', () => {
  const ranked = __internals.rankCandidates([
    { url: 'https://shop.test/marketplace/templates/pretty', title: 'template' },
    { url: 'https://real.test/?_bhlid=deadbeef&utm_source=x&keep=1', title: 'real' },
  ], 5);
  assert.deepEqual(ranked.map((c) => c.url), ['https://real.test/?keep=1', 'https://shop.test/marketplace/templates/pretty']);
});

await check('design_discover searches, filters and captures keepers', async () => {
  webSearch = async (request) => {
    assert.equal(request.maxResults, 12, 'default maxResults');
    return {
      truncated: false,
      sources: [
        { url: 'https://www.youtube.com/watch?v=abc', title: 'A talk' },
        { url: 'https://design.test/docs/getting-started', title: 'Docs' },
        { url: 'https://design.test/', title: 'Acme — design system' },
        { url: 'https://www.design.test/?utm_source=news', title: 'Acme again' },
        { url: 'https://acme-two.test/', title: 'Two' },
        { url: 'https://example.com/files/whitepaper.pdf', title: 'PDF' },
        { url: 'https://github.com/some/repo', title: 'Repo' },
      ],
    };
  };
  const out = await discover.execute({ query: 'acme design', limit: 2 }, {});
  assertLossless(out);
  assert.equal(out.ok, true);
  assert.equal(out.searched, true);
  assert.equal(searchLog.at(-1).query, 'acme design');
  assert.equal(out.captured.length, 2, JSON.stringify(out.failures));
  assert.deepEqual(out.captured.map((c) => c.url), ['https://design.test/', 'https://acme-two.test/']);
  assert.ok(out.captured.every((c) => c.palette.length > 0), 'each digest carries a palette');
  assert.ok(out.captured.every((c) => c.fonts.length > 0), 'each digest carries fonts');
  assert.match(out.hint, /acme, acme-two/);
  assert.equal(out.failures.length, 0);
  // ids come from the brand name / host label, never the full page title
  assert.deepEqual(out.captured.map((c) => c.id), ['acme', 'acme-two']);
});

await check('design_discover entries land in the library with provenance notes', async () => {
  const out = await library.execute({ action: 'search', query: 'discovered: acme design' }, {});
  assert.equal(out.total, 2, 'notes record the discovery query');
});

await check('design_discover captures explicit urls without searching', async () => {
  const before = searchLog.length;
  const out = await discover.execute({ urls: ['https://acme-two.test/'], refresh: true }, {});
  assertLossless(out, 'urls-branch output');
  assert.equal(searchLog.length, before, 'no search when urls are given');
  assert.equal(out.searched, false);
  assert.equal(out.captured.length, 1);
  assert.equal(out.captured[0].id, 'acme-two', 'refresh overwrites the existing id');
});

await check('design_discover records per-site failures and keeps the rest', async () => {
  webSearch = async () => ({
    truncated: false,
    sources: [
      { url: 'https://missing.test/', title: 'Missing' },
      { url: 'https://acme-two.test/', title: 'Two' },
    ],
  });
  const out = await discover.execute({ query: 'mixed bag', limit: 2, refresh: true }, {});
  assert.equal(out.captured.length, 1);
  assert.equal(out.failures.length, 1);
  assert.match(out.failures[0].error, /HTTP 404/);
});

await check('design_discover degrades cleanly when search is unavailable', async () => {
  webSearch = async () => { throw new Error('WEB_PROVIDER_UNAVAILABLE'); };
  const out = await discover.execute({ query: 'anything' }, {});
  assert.equal(out.ok, false);
  assert.match(out.error, /search failed.*WEB_PROVIDER_UNAVAILABLE/);
  assert.match(out.hint, /urls/);
});

await check('design_discover reports when every candidate is filtered out', async () => {
  webSearch = async () => ({
    truncated: false,
    sources: [{ url: 'https://youtube.com/x' }, { url: 'https://x.com/y' }, { url: 'https://a.test/b.pdf' }],
  });
  const out = await discover.execute({ query: 'nothing usable' }, {});
  assert.equal(out.ok, false);
  assert.match(out.error, /no capture-worthy candidate/);
});

await check('design_discover needs a query or urls', async () => {
  await assert.rejects(() => discover.execute({}, {}), /query is required/);
});
await check('capture id prefers brand over a long page title', async () => {
  FIXTURES.set('https://long-title.test/', `<!doctype html>
<html><head><title>Ora: Issue tracking that is simple, effective and good looking | Ora</title>
<style>body { color: #222; background: #fff; }</style></head><body>ok</body></html>`);
  const out = await capture.execute({ url: 'https://long-title.test/' }, {});
  assert.equal(out.id, 'long-title', `expected the host label, got "${out.id}"`);
  const withBrand = await capture.execute({ url: 'https://long-title.test/', name: 'Ora', refresh: false }, {});
  assert.equal(withBrand.id, 'ora', 'an explicit name still wins');
});

await check('capture without url errors', async () => {
  await assert.rejects(() => capture.execute({}, {}), /url is required/);
});
await check('capture non-HTML errors clearly', async () => {
  FIXTURES.set('https://design.test/plain', '# just text');
  webFetch = async (request) => request.url.endsWith('/plain')
    ? { url: request.url, statusCode: 200, body: { kind: 'text', content: FIXTURES.get(request.url) } }
    : { url: request.url, statusCode: 200, body: { kind: 'html', content: FIXTURES.get(request.url) } };
  await assert.rejects(() => capture.execute({ url: 'https://design.test/plain' }, {}), /not HTML/);
});
await check('capture error page surfaces status', async () => {
  webFetch = async (request) => ({ url: request.url, statusCode: 503, body: { kind: 'text', content: 'down' } });
  await assert.rejects(() => capture.execute({ url: 'https://design.test/' }, {}), /HTTP 503/);
});

// 4. Real-world HTML file through a local HTTP server
await check('real HTML file capture (local server)', async () => {
  const htmlPath = 'D:/UserData/Documents/deepseek-harness/default-workspace/dse_wenyan_handbook_sc.html';
  if (!fs.existsSync(htmlPath)) {
    throw new Skip('optional local fixture not found');
  }
  const real = fs.readFileSync(htmlPath, 'utf8');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': req.url.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
    res.end(req.url === '/' ? real : 'body{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    webFetch = async (request, signal) => {
      const res = await fetch(request.url, { signal });
      const text = await res.text();
      return { url: request.url, statusCode: res.status, body: { kind: (res.headers.get('content-type') ?? '').includes('css') ? 'text' : 'html', content: text } };
    };
    const out = await capture.execute({ url: `http://127.0.0.1:${port}/`, name: 'wenyan-handbook' }, {});
    assert.equal(out.ok, true);
    assert.ok(out.stats.declarations > 0, `declarations ${out.stats.declarations}`);
    results.push(`  real-file: ${out.stats.declarations} decls, palette ${out.palette.slice(0, 4).map((c) => c.value).join(' ')}, fonts ${out.fonts.map((f) => f.family).join(', ') || '—'}, tokens ${JSON.stringify(out.tokens)}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

console.log(results.join('\n'));
console.log(`\nfetch log (${fetchLog.length} urls):`, [...new Set(fetchLog)].join(' | '));
fs.rmSync(storeDir, { recursive: true, force: true });
process.exit(process.exitCode ?? 0);
