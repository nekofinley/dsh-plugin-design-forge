/**
 * dsh-plugin-design-forge — a DeepSeek Harness design library.
 *
 * Captures the *real* design of excellent websites — palette, typography
 * stacks and scale, spacing rhythm, radii, shadows, gradients, motion, media
 * breakpoints, and the site's own CSS custom-property tokens — into a
 * persistent local library, then makes agents apply those designs
 * automatically:
 *
 *   - `design_capture`  fetches a URL through the harness `ctx.web` seam (so
 *     the user's configured fetch provider — including the SOCKS proxy router
 *     — is used), parses the HTML's inline styles and every reachable
 *     stylesheet, distills design tokens, and stores one JSON entry plus a
 *     ready-to-paste `tokens.css` under the store directory.
 *   - `design_library`  lists / searches / reads / deletes / exports entries
 *     (tokens.css, raw JSON, or a Markdown design spec).
 *   - a system-prompt section teaches every agent to check the library first
 *     whenever it builds a website, app UI, dashboard, email, poster, slide
 *     deck, or document typography — and to capture new sites the user
 *     praises — so captured designs are reused instead of reinvented.
 *
 * Plugin shape mirrors the first-party DSH plugins: named exports `name`,
 * `inject`, `Config`, `apply(ctx, config)`. Only Node built-ins plus
 * @deepseek-ai/schemastery (for the Config schema / config editor).
 *
 * All analysis is dependency-free and deliberately tolerant: a purpose-built
 * brace/paren-aware CSS walker (handles @media/@supports/@layer nesting, CSS
 * nesting, @font-face, custom properties, dark-theme selector conventions),
 * regex HTML extraction, and frequency-ranked token distillation.
 *
 * @module dsh-plugin-design-forge
 * @version 1.0.6 (spec unit fix, generic font fallbacks)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import z from '@deepseek-ai/schemastery';

/** Cordis plugin name used by loader diagnostics. */
export const name = 'design-forge';

/** Services this plugin requires from the host composition. */
export const inject = ['web', 'systemPrompt', 'tools'];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIG = {
  storeDir: '', // '' → ~/.dsh/storages/design-forge
  maxStylesheets: 24,
  hardMaxSheets: 40,
  maxImportsPerSheet: 4,
  maxStylesheetBytes: 600_000,
  maxTotalCssBytes: 2_500_000,
  fetchConcurrency: 4,
  maxTokenProps: 80,
  promptSection: true,
};

/**
 * The plugin Config schema (feeds the config editor; every field falls back
 * to DEFAULT_CONFIG when omitted from the patch row).
 */
export const Config = z.object({
  storeDir: z.string().default(''),
  maxStylesheets: z.natural().max(32).default(24),
  hardMaxSheets: z.natural().max(96).default(40),
  maxImportsPerSheet: z.natural().max(16).default(4),
  maxStylesheetBytes: z.natural().default(600_000),
  maxTotalCssBytes: z.natural().default(2_500_000),
  fetchConcurrency: z.natural().max(8).default(4),
  maxTokenProps: z.natural().max(200).default(80),
  promptSection: z.boolean().default(true),
});

/** Merge patch-row config over defaults; loud failures at load. */
function normalizeConfig(raw) {
  const merged = { ...DEFAULT_CONFIG, ...(raw ?? {}) };
  const config = {
    storeDir: typeof merged.storeDir === 'string' ? merged.storeDir : '',
    maxStylesheets: clampInt(merged.maxStylesheets, 1, 32, DEFAULT_CONFIG.maxStylesheets),
    hardMaxSheets: clampInt(merged.hardMaxSheets, 4, 96, DEFAULT_CONFIG.hardMaxSheets),
    maxImportsPerSheet: clampInt(merged.maxImportsPerSheet, 0, 16, DEFAULT_CONFIG.maxImportsPerSheet),
    maxStylesheetBytes: clampInt(merged.maxStylesheetBytes, 10_000, 20_000_000, DEFAULT_CONFIG.maxStylesheetBytes),
    maxTotalCssBytes: clampInt(merged.maxTotalCssBytes, 50_000, 50_000_000, DEFAULT_CONFIG.maxTotalCssBytes),
    fetchConcurrency: clampInt(merged.fetchConcurrency, 1, 8, DEFAULT_CONFIG.fetchConcurrency),
    maxTokenProps: clampInt(merged.maxTokenProps, 10, 200, DEFAULT_CONFIG.maxTokenProps),
    promptSection: merged.promptSection !== false,
  };
  return config;
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

const nowIso = () => new Date().toISOString();

/** Collapse whitespace runs (incl. newlines) into single spaces. */
function collapseWs(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function stripImportant(value) {
  return collapseWs(String(value ?? '').replace(/!important\s*$/i, ''));
}

/** File-safe slug for entry ids. */
function slugify(input, fallback = 'site') {
  const slug = String(input ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || fallback;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function normalizeUrl(input) {
  let raw = String(input ?? '').trim();
  if (!raw) throw new Error('url is required');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`invalid URL: ${input}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`unsupported URL scheme "${url.protocol}" (only http/https)`);
  }
  if (url.username || url.password) throw new Error('credentials in URLs are not allowed');
  if (raw.length > 2048) throw new Error('URL exceeds 2048 characters');
  return url;
}

/** Defensive argument readers (raw register() means args arrive unvalidated). */
function asString(value, { max = 500 } = {}) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function asBool(value) {
  return value === true;
}

function asEnum(value, allowed) {
  return typeof value === 'string' && allowed.includes(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Color handling
// ---------------------------------------------------------------------------

/** Curated CSS named colors most likely to appear in real palettes. */
const NAMED_COLOR_MAP = {
  white: '#ffffff', black: '#000000', gray: '#808080', grey: '#808080',
  silver: '#c0c0c0', red: '#ff0000', crimson: '#dc143c', firebrick: '#b22222',
  orange: '#ffa500', darkorange: '#ff8c00', coral: '#ff7f50', tomato: '#ff6347',
  salmon: '#fa8072', gold: '#ffd700', yellow: '#ffff00', khaki: '#f0e68c',
  lime: '#00ff00', limegreen: '#32cd32', green: '#008000', darkgreen: '#006400',
  teal: '#008080', turquoise: '#40e0d0', cyan: '#00ffff', aqua: '#00ffff',
  skyblue: '#87ceeb', steelblue: '#4682b4', royalblue: '#4169e1', blue: '#0000ff',
  navy: '#000080', midnightblue: '#191970', indigo: '#4b0082', slateblue: '#6a5acd',
  purple: '#800080', rebeccapurple: '#663399', violet: '#ee82ee', magenta: '#ff00ff',
  fuchsia: '#ff00ff', pink: '#ffc0cb', hotpink: '#ff69b4', brown: '#a52a2a',
  sienna: '#a0522d', chocolate: '#d2691e', beige: '#f5f5dc', ivory: '#fffff0',
  snow: '#fffafa', whitesmoke: '#f5f5f5', ghostwhite: '#f8f8ff', seashell: '#fff5ee',
  linen: '#faf0e6', lightgray: '#d3d3d3', lightgrey: '#d3d3d3', darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9', dimgray: '#696969', dimgrey: '#696969', slategrey: '#708090',
  slategray: '#708090', lightslategrey: '#778899', lightslategray: '#778899',
  orangered: '#ff4500', springgreen: '#00ff7f', mediumseagreen: '#3cb371',
  seagreen: '#2e8b57', lightblue: '#add8e6', lightcyan: '#e0ffff', lavender: '#e6e6fa',
  thistle: '#d8bfd8', plum: '#dda0dd', orchid: '#da70d6', maroon: '#800000',
  olive: '#808000', chartreuse: '#7fff00', forestgreen: '#228b22', sandybrown: '#f4a460',
};

// Longest-first so "whitesmoke" wins over "white" at the same index.
const NAMED_COLOR_KEYS = Object.keys(NAMED_COLOR_MAP).sort((a, b) => b.length - a.length);
const NAMED_RE = new RegExp(`\\b(${NAMED_COLOR_KEYS.join('|')})\\b`, 'gi');
const HEX_RE = /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/gi;
const COLOR_FN_RE = /\b(rgba?|hsla?|hwb|oklch|oklab|olab|lch|lab|color|color-mix|light-dark)\s*\(/gi;

/** Expand #abc / #abcd to the long form; lowercase everything. */
function normalizeHex(hex) {
  let h = hex.toLowerCase();
  if (h.length === 4) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  else if (h.length === 5) h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}${h[4]}${h[4]}`;
  return h;
}

/** Parse one numeric component: 12, 12.5, 50%, 0.5 alpha contexts. */
function parseNumComponent(token, scale = 255) {
  const t = String(token).trim();
  if (t.endsWith('%')) {
    const pct = Number.parseFloat(t);
    if (!Number.isFinite(pct)) return null;
    return Math.round((pct / 100) * scale);
  }
  const n = Number.parseFloat(t);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function rgbToHex(r, g, b) {
  const clamp = (v) => Math.max(0, Math.min(255, v | 0));
  return `#${[r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('')}`;
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const sat = Math.max(0, Math.min(1, s));
  const lig = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = lig - c / 2;
  let [r, g, b] = [0, 0, 0];
  if (hue < 60) [r, g, b] = [c, x, 0];
  else if (hue < 120) [r, g, b] = [x, c, 0];
  else if (hue < 180) [r, g, b] = [0, c, x];
  else if (hue < 240) [r, g, b] = [0, x, c];
  else if (hue < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * Canonicalize any captured color literal to a stable key: opaque values
 * become #rrggbb, translucent ones keep a normalized rgba() form, exotic
 * color spaces (oklch, color-mix, …) are kept as collapsed raw strings.
 */
function normalizeColor(raw) {
  const input = collapseWs(raw);
  const lower = input.toLowerCase();
  if (lower === 'transparent' || lower === 'currentcolor') return lower;
  if (lower.startsWith('#')) return normalizeHex(lower);

  const fn = /^([a-z-]+)\s*\((.*)\)$/i.exec(lower);
  if (!fn) return lower;
  const [, name, innerRaw] = fn;
  const inner = collapseWs(innerRaw).replace(/\//g, ' / ');

  if (name === 'rgb' || name === 'rgba') {
    const parts = inner.split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const r = parseNumComponent(parts[0]);
      const g = parseNumComponent(parts[1]);
      const b = parseNumComponent(parts[2]);
      if (r === null || g === null || b === null) return lower;
      let alpha = 1;
      if (parts.length >= 4) {
        const a = Number.parseFloat(parts[3]);
        if (Number.isFinite(a)) alpha = parts[3].endsWith('%') ? a / 100 : a;
      }
      return alpha >= 1 ? rgbToHex(r, g, b) : `rgba(${r}, ${g}, ${b}, ${roundTo3(alpha)})`;
    }
    return lower;
  }
  if (name === 'hsl' || name === 'hsla') {
    const parts = inner.split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const h = Number.parseFloat(parts[0]);
      const s = Number.parseFloat(parts[1]) / 100;
      const l = Number.parseFloat(parts[2]) / 100;
      if ([h, s, l].every(Number.isFinite)) {
        const [r, g, b] = hslToRgb(h, s, l);
        let alpha = 1;
        if (parts.length >= 4) {
          const a = Number.parseFloat(parts[3]);
          if (Number.isFinite(a)) alpha = parts[3].endsWith('%') ? a / 100 : a;
        }
        return alpha >= 1 ? rgbToHex(r, g, b) : `rgba(${r}, ${g}, ${b}, ${roundTo3(alpha)})`;
      }
    }
    return lower;
  }
  // oklch/oklab/lch/lab/hwb/color()/color-mix()/light-dark(): keep raw.
  return lower;
}

function roundTo3(n) {
  return Math.round(n * 1000) / 1000;
}

function hexLuminance(hex) {
  const m = /^#([0-9a-f]{6})$/.exec(hex);
  if (!m) return null;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function luminanceClass(color) {
  const lum = hexLuminance(color);
  if (lum === null) return 'mid';
  return lum > 0.6 ? 'light' : lum < 0.25 ? 'dark' : 'mid';
}

function isTranslucent(color) {
  if (/^rgba\(/.test(color)) return true;
  return /^#[0-9a-f]{8}$/.test(color) && parseInt(color.slice(7), 16) < 255;
}

/** Extract and normalize every color literal from one CSS value. */
function extractColors(value, out) {
  const text = String(value ?? '');
  for (const match of text.matchAll(HEX_RE)) {
    bump(out, normalizeHex(match[0]));
  }
  for (const match of text.matchAll(COLOR_FN_RE)) {
    const open = match.index + match[0].length - 1;
    const close = matchParen(text, open);
    if (close > open) {
      const raw = text.slice(match.index, close + 1);
      // light-dark() and color-mix() resolve differently per theme; keep raw.
      bump(out, normalizeColor(raw));
    }
  }
  for (const match of text.matchAll(NAMED_RE)) {
    bump(out, NAMED_COLOR_MAP[match[1].toLowerCase()]);
  }
  const lower = text.toLowerCase();
  if (/\btransparent\b/.test(lower)) bump(out, 'transparent');
  if (/\bcurrentcolor\b/.test(lower)) bump(out, 'currentcolor');
}

/** Index of the paren balancing the one at `open`, or -1. */
function matchParen(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Tolerant CSS walker
// ---------------------------------------------------------------------------

/** Index of the brace matching the '{' at `open` (string-aware), or end. */
function matchBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length - 1; // tolerate unclosed blocks
}

/** Parse "prop: value" segments; custom properties keep raw values. */
function parseDeclarations(body) {
  const decls = [];
  let start = 0;
  let depth = 0;
  let quote = null;
  for (let i = 0; i <= body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ';' || i === body.length) {
      if (depth === 0) {
        const segment = body.slice(start, i);
        const colon = findTopLevelColon(segment);
        if (colon > 0) {
          const prop = segment.slice(0, colon).trim().toLowerCase().replace(/^[*_\s]+/, '');
          const value = segment.slice(colon + 1).trim();
          if (prop && value && value !== 'inherit' && value !== 'initial' && value !== 'unset') {
            decls.push({ prop, value });
          }
        }
        start = i + 1;
      }
    }
  }
  return decls;
}

function findTopLevelColon(segment) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ':' && depth === 0) return i;
  }
  return -1;
}

/**
 * Remove /* … *​/ comments while respecting string literals. Comments may
 * contain quotes ("don't") and braces; leaving them in desynchronizes the
 * brace/paren walkers, so every CSS text is stripped exactly once here.
 */
function stripCssComments(css) {
  if (!css.includes('/*')) return css;
  let out = '';
  let i = 0;
  const n = css.length;
  while (i < n) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const end = skipString(css, i);
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      i = close === -1 ? n : close + 2;
      out += ' ';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Index just past a string literal starting at `open` (the quote itself). */
function skipString(text, open) {
  const quote = text[open];
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

/**
 * Walk one CSS text and emit (selectorChain, decls, atPath) for every style
 * rule, plus @font-face rules; tolerates nesting, unclosed blocks, and
 * unknown at-rules. `visit` receives { chain, decls, atPath }.
 */
function walkCss(cssText, visit, atPath = '') {
  const css = atPath === '' ? stripCssComments(cssText) : cssText;
  const n = css.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    const ch = css[i];
    if (ch !== '{') {
      i++;
      continue;
    }
    // The prelude may swallow file-head statement at-rules (@charset, @layer,
    // @import): the true prelude is what follows the last top-level ';'.
    const rawPrelude = collapseWs(css.slice(start, i));
    const semiIdx = rawPrelude.lastIndexOf(';');
    const prelude = semiIdx >= 0 ? rawPrelude.slice(semiIdx + 1).trim() : rawPrelude;
    const close = matchBrace(css, i);
    // `close` is the index OF the closing brace — exclude it from the body.
    const body = css.slice(i + 1, close);
    if (prelude.startsWith('@')) {
      const atName = (/^@([-a-zA-Z]+)/.exec(prelude)?.[1] ?? '').toLowerCase();
      const nextAt = atPath ? `${atPath} ; ${prelude}` : prelude;
      if (atName === 'font-face') {
        const decls = parseDeclarations(body);
        if (decls.length > 0) visit({ chain: ['@font-face'], decls, atPath });
      } else {
        // @media/@supports/@layer/@container/@scope/@keyframes/unknown → recurse
        walkCss(body, visit, nextAt);
      }
    } else if (prelude) {
      handleStyleBody(body, [prelude], atPath, visit);
    }
    i = close + 1;
    start = i;
  }
}

/** Style-rule body: declarations at this level, nested rules recurse. */
function handleStyleBody(body, chain, atPath, visit) {
  const decls = [];
  let start = 0;
  let i = 0;
  let depth = 0;
  let quote = null;
  while (i < body.length) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === '{' && depth === 0) {
      // CSS nesting: prelude before the brace opens a child rule.
      const nestedPrelude = collapseWs(body.slice(start, i));
      const close = matchBrace(body, i);
      if (nestedPrelude) {
        handleStyleBody(body.slice(i + 1, close), [...chain, nestedPrelude], atPath, visit);
      }
      i = close + 1;
      start = i;
      continue;
    } else if (ch === ';' && depth === 0) {
      const segment = body.slice(start, i);
      pushDeclaration(segment, decls);
      i++;
      start = i;
      continue;
    }
    i++;
  }
  pushDeclaration(body.slice(start), decls);
  if (decls.length > 0) visit({ chain, decls, atPath });
}

function pushDeclaration(segment, decls) {
  const colon = findTopLevelColon(segment);
  if (colon <= 0) return;
  const prop = segment.slice(0, colon).trim().toLowerCase().replace(/^[*_\s]+/, '');
  const value = segment.slice(colon + 1).trim();
  if (prop && value) decls.push({ prop, value });
}

// ---------------------------------------------------------------------------
// Analysis collector
// ---------------------------------------------------------------------------

const DARK_SELECTOR_RE = /(\.dark\b|\[data-theme=["']?dark|\[data-color-mode=["']?dark|\[data-bs-theme=["']?dark|\[data-mode=["']?dark|\[data-appearance=["']?dark|\[data-color-scheme=["']?dark|\.theme-dark|\.dark-theme|\.color-scheme--dark)/i;
const DARK_MEDIA_RE = /prefers-color-scheme\s*:\s*dark/i;
const GENERIC_FAMILIES = /^(sans-serif|serif|monospace|cursive|fantasy|system-ui|-apple-system|ui-sans-serif|ui-serif|ui-monospace|ui-rounded)$/i;

function createCollector(maxTokenProps) {
  return {
    maxTokenProps,
    colors: new Map(),
    fonts: new Map(),
    fontSizes: new Map(),
    fontWeights: new Map(),
    lineHeights: new Map(),
    letterSpacings: new Map(),
    spacings: new Map(),
    radii: new Map(),
    shadows: new Map(),
    gradients: new Map(),
    durations: new Map(),
    easings: new Map(),
    breakpoints: new Map(),
    containerWidths: new Map(),
    tokensLight: new Map(),
    tokensDark: new Map(),
    // font-family / font-size / font-weight declarations that reference
    // var(…): resolved once all token sheets are collected (resolvePendingVars).
    pendingFonts: [],
    pendingSizes: [],
    pendingWeights: [],
    declarations: 0,
    fontFaces: [],
  };
}

function bump(map, key, weight = 1) {
  if (!key) return;
  map.set(key, (map.get(key) ?? 0) + weight);
}

/** True when the rule sits in a dark-theme context. */
function isDarkContext(chain, atPath) {
  return (
    DARK_MEDIA_RE.test(atPath) ||
    (Array.isArray(chain) && chain.some((sel) => DARK_SELECTOR_RE.test(sel)))
  );
}

const SPACING_PROPS = /^(padding|margin|gap|row-gap|column-gap|padding-top|padding-right|padding-bottom|padding-left|margin-top|margin-right|margin-bottom|margin-left)$/;
const NUM_UNIT_RE = /(-?\d*\.?\d+)(px|rem|em)(?![a-z%])/gi;

function collectValueNumbers(map, value, maxPx = 4096) {
  if (!value) return;
  if (/^\s*0\s*$/.test(value)) {
    bump(map, '0px');
    return;
  }
  for (const match of value.matchAll(NUM_UNIT_RE)) {
    const n = Number.parseFloat(match[1]);
    if (!Number.isFinite(n)) continue;
    const px = match[2] === 'px' ? n : n * 16;
    if (px > 0 && px < maxPx) bump(map, `${round1(px)}px`);
  }
}

const DURATION_RE = /(\d*\.?\d+)(ms|s)\b/gi;
const EASING_RE = /(cubic-bezier\([^)]*\)|steps\([^)]*\)|linear\b|ease-in-out\b|ease-in\b|ease-out\b|ease\b)/gi;

/** Replace var(--x, fallback) references from a {--name: value} map. */
function resolveVars(value, varMap, depth = 3) {
  if (depth <= 0 || !value.includes('var(')) return value;
  let out = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/gi, (whole, name, fallback) => {
    const resolved = varMap[name];
    if (resolved !== undefined && !resolved.includes('var(')) return resolved;
    if (resolved !== undefined) return resolveVars(resolved, varMap, depth - 1);
    if (fallback !== undefined) return fallback.trim();
    return whole;
  });
  // Colors referenced through chains like var(--a) → var(--b): one more pass.
  if (out.includes('var(') && out !== value) out = resolveVars(out, varMap, depth - 1);
  return out;
}

/** Feed the collected var()-deferred font declarations through the token map. */
function resolvePendingVars(collector) {
  if (collector.pendingFonts.length === 0 && collector.pendingSizes.length === 0 && collector.pendingWeights.length === 0) return;
  const varMap = { ...Object.fromEntries(collector.tokensLight), ...Object.fromEntries(collector.tokensDark) };
  const fonts = collector.pendingFonts;
  const sizes = collector.pendingSizes;
  const weights = collector.pendingWeights;
  collector.pendingFonts = [];
  collector.pendingSizes = [];
  collector.pendingWeights = [];
  for (const value of fonts) {
    const resolved = resolveVars(value, varMap);
    if (!resolved.includes('var(')) feedDeclaration(collector, { prop: 'font-family', value: resolved }, false);
  }
  for (const value of sizes) {
    const resolved = resolveVars(value, varMap);
    if (!resolved.includes('var(')) feedDeclaration(collector, { prop: 'font-size', value: resolved }, false);
  }
  for (const value of weights) {
    const resolved = resolveVars(value, varMap);
    if (!resolved.includes('var(')) feedDeclaration(collector, { prop: 'font-weight', value: resolved }, false);
  }
}

function feedDeclaration(collector, { prop, value }, dark, resolved = false) {
  collector.declarations++;
  const raw = stripImportant(value).replace(/[{}]/g, '');

  // Custom properties → theme token maps (dark contexts separated).
  if (prop.startsWith('--')) {
    // Collected uncapped; buildCapture applies maxTokenProps at selection
    // time, preferring core design tokens over component-scoped ones.
    const target = dark ? collector.tokensDark : collector.tokensLight;
    if (!target.has(prop)) target.set(prop, collapseWs(value).slice(0, 200));
    extractColors(raw, collector.colors);
    return;
  }

  if (prop === 'font-family') {
    if (raw.includes('var(')) {
      // e.g. font-family: var(--font-sans) — resolve after tokens are in.
      collector.pendingFonts.push(value);
      return;
    }
    const stack = raw.replace(/['"]/g, '').replace(/\s+/g, ' ').trim();
    if (stack && !/^(inherit|initial|unset)$/i.test(stack)) {
      const first = stack.split(',')[0]?.trim() || stack;
      const key = first.toLowerCase();
      const existing = collector.fonts.get(key);
      if (existing) existing.count++;
      else collector.fonts.set(key, { family: first, stack: stack.slice(0, 160), count: 1, genericOnly: GENERIC_FAMILIES.test(key) });
    }
    return;
  }
  if (prop === 'font-size') {
    if (raw.includes('var(')) {
      collector.pendingSizes.push(value);
      return;
    }
    const m = /^(\d*\.?\d+)(px|rem|em|pt)/.exec(raw);
    if (m) {
      const px = m[2] === 'px' ? Number(m[1]) : m[2] === 'pt' ? Number(m[1]) * 1.3333 : Number(m[1]) * 16;
      if (px >= 8 && px <= 96) bump(collector.fontSizes, `${round1(px)}px`);
    }
    return;
  }
  if (prop === 'font-weight') {
    if (raw.includes('var(')) {
      collector.pendingWeights.push(value);
      return;
    }
    const m = /^(\d{1,3})\b/.exec(raw);
    if (m) {
      const w = Number(m[1]);
      if (w >= 100 && w <= 900) bump(collector.fontWeights, String(w));
    } else if (/^bold\b/.test(raw)) bump(collector.fontWeights, '700');
    else if (/^normal\b/.test(raw)) bump(collector.fontWeights, '400');
    return;
  }
  if (prop === 'line-height') {
    const m = /^(\d*\.?\d+)(px|rem|em)?$/.exec(raw);
    if (m) bump(collector.lineHeights, m[2] ? `${round1(m[2] === 'px' ? Number(m[1]) : Number(m[1]) * 16)}px` : m[1]);
    return;
  }
  if (prop === 'letter-spacing') {
    collectValueNumbers(collector.letterSpacings, raw);
    return;
  }
  if (SPACING_PROPS.test(prop)) {
    collectValueNumbers(collector.spacings, raw);
    return;
  }
  if (prop.startsWith('border') && prop.includes('radius')) {
    // Pill radii (9999px) are a real design convention — allow huge values.
    collectValueNumbers(collector.radii, raw, 100_000);
    if (/%/.test(raw)) bump(collector.radii, '50%');
    return;
  }
  if (prop === 'box-shadow' || prop === 'text-shadow') {
    if (raw && raw !== 'none') bump(collector.shadows, collapseWs(raw).slice(0, 240));
    return;
  }
  if ((prop === 'background' || prop === 'background-image' || prop === 'mask-image' || prop === '-webkit-background-image') && raw.includes('gradient(')) {
    bump(collector.gradients, collapseWs(raw).slice(0, 240));
    return;
  }
  if (prop === 'transition' || prop === 'transition-duration' || prop === 'animation' || prop === 'animation-duration') {
    for (const m of raw.matchAll(DURATION_RE)) {
      const ms = m[2].toLowerCase() === 's' ? Number(m[1]) * 1000 : Number(m[1]);
      if (ms > 0 && ms <= 10_000) bump(collector.durations, `${round1(ms)}ms`);
    }
    for (const m of raw.matchAll(EASING_RE)) bump(collector.easings, collapseWs(m[1]));
    return;
  }

  // Any other property: harvest color literals.
  extractColors(raw, collector.colors);
}

function feedRule(collector, { chain, decls, atPath }) {
  const dark = isDarkContext(chain, atPath);
  if (chain.length === 1 && chain[0] === '@font-face') {
    const face = { family: undefined, weight: undefined, style: undefined };
    for (const decl of decls) {
      if (decl.prop === 'font-family') face.family = stripImportant(decl.value).replace(/['"]/g, '').slice(0, 80);
      else if (decl.prop === 'font-weight') face.weight = stripImportant(decl.value).slice(0, 24);
      else if (decl.prop === 'font-style') face.style = stripImportant(decl.value).slice(0, 24);
    }
    if (face.family && collector.fontFaces.length < 24) collector.fontFaces.push(face);
  }
  for (const decl of decls) feedDeclaration(collector, decl, dark);
}

/** Run the full analysis over the union of all captured CSS texts. */
function analyzeCssTexts(cssTexts, config) {
  const collector = createCollector(config.maxTokenProps);
  for (const css of cssTexts) walkCss(css, (rule) => feedRule(collector, rule));
  return collector;
}

/** Feed inline style="..." declarations (HTML attributes) into a collector. */
function feedInlineStyles(collector, inlineStyles) {
  for (const styleText of inlineStyles) {
    for (const segment of styleText.split(';')) {
      const colon = segment.indexOf(':');
      if (colon <= 0) continue;
      const prop = segment.slice(0, colon).trim().toLowerCase();
      const value = segment.slice(colon + 1).trim();
      if (prop && value) feedDeclaration(collector, { prop, value }, false);
    }
  }
}

function topEntries(map, limit, transform = ([value, count]) => ({ value, count })) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(transform);
}

function sortedNumericKeys(map, limit) {
  return [...map.entries()]
    .sort((a, b) => {
      const an = Number.parseFloat(a[0]);
      const bn = Number.parseFloat(b[0]);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}

/** Collapse near-duplicate numeric entries (min-width pairs like 640/641px). */
function collapseCloseEntries(entries, tolerance = 1) {
  const out = [];
  for (const entry of entries) {
    const n = Number.parseFloat(entry.value);
    const prev = out.length > 0 ? Number.parseFloat(out[out.length - 1].value) : NaN;
    if (Number.isFinite(n) && Number.isFinite(prev) && n - prev <= tolerance) continue;
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Derived tokens + generated artifacts
// ---------------------------------------------------------------------------

/** Chroma (max−min channel, 0..1) — saturated brand colors beat neutrals. */
function colorChroma(color) {
  const m = /^#([0-9a-f]{6})$/.exec(color);
  if (!m) return 0;
  const channels = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16));
  return (Math.max(...channels) - Math.min(...channels)) / 255;
}

function deriveTokens(collector) {
  const derived = {};
  // Prefer saturated, opaque, frequent colors; fall back to neutrals when a
  // site is genuinely monochrome.
  const scored = [...collector.colors.entries()]
    .filter(([value]) => !isTranslucent(value) && value !== 'transparent' && value !== 'currentcolor')
    .map(([value, count]) => ({ value, count, score: count * (1 + colorChroma(value)) }))
    .sort((a, b) => b.score - a.score);
  const saturated = scored.filter((c) => colorChroma(c.value) >= 0.05);
  const neutrals = scored.filter((c) => colorChroma(c.value) < 0.05);
  const picked = [...saturated, ...neutrals].slice(0, 8);
  picked.forEach((c, i) => {
    derived[`--df-color-${i + 1}`] = c.value;
  });
  const families = [...collector.fonts.values()].sort((a, b) => b.count - a.count);
  // Generic-keyword detection matches the reserved words, not font names
  // that merely contain them ("Berkeley Mono" is not generic monospace).
  const hasGeneric = (stack, generic) => new RegExp(`(^|[\\s,])${generic}($|[\\s,])`, 'i').test(stack);
  const sans = families.find((f) => !/mono/i.test(f.family) && !/serif/i.test(f.family));
  if (sans) derived['--df-font-sans'] = hasGeneric(sans.stack, 'sans-serif') ? sans.stack : `${sans.family}, sans-serif`;
  const serif = families.find((f) => /serif/i.test(f.family) && !/sans/i.test(f.family));
  if (serif) derived['--df-font-serif'] = hasGeneric(serif.stack, 'serif') ? serif.stack : `${serif.family}, serif`;
  const mono = families.find((f) => /mono/i.test(f.family));
  if (mono) derived['--df-font-mono'] = hasGeneric(mono.stack, 'monospace') ? mono.stack : `${mono.family}, monospace`;

  const radii = [...collector.radii.keys()].filter((k) => k.endsWith('px')).map((k) => Number.parseFloat(k)).sort((a, b) => a - b);
  if (radii.length >= 3) {
    derived['--df-radius-sm'] = `${radii[0]}px`;
    derived['--df-radius-md'] = `${radii[Math.floor(radii.length / 2)]}px`;
    derived['--df-radius-lg'] = `${radii[radii.length - 1]}px`;
  } else if (radii.length > 0) {
    radii.slice(0, 3).forEach((r, i) => {
      derived[`--df-radius-${['sm', 'md', 'lg'][i]}`] = `${r}px`;
    });
  }
  topEntries(collector.shadows, 3).forEach((s, i) => {
    derived[`--df-shadow-${i + 1}`] = s.value;
  });
  return derived;
}

function buildTokensCss(entry) {
  const { analysis, tokens, derived } = entry;
  const lines = [];
  lines.push(`/* Design tokens captured from "${entry.name}" (${entry.url})`);
  lines.push(`   by dsh-plugin-design-forge on ${entry.capturedAt}. Reuse as a design system:`);
  lines.push(`   palette ${analysis.palette.slice(0, 5).map((c) => c.value).join(' ')} | fonts ${analysis.fonts.slice(0, 2).map((f) => f.family).join(', ')} */`);
  lines.push('');
  lines.push(':root {');
  const lightEntries = Object.entries(tokens.light ?? {});
  const derivedEntries = Object.entries(derived ?? {});
  if (lightEntries.length === 0 && derivedEntries.length === 0) {
    lines.push('  /* (no custom properties found; see the analysis JSON for the distilled palette/scale) */');
  }
  for (const [k, v] of lightEntries) lines.push(`  ${k}: ${v};`);
  if (lightEntries.length > 0 && derivedEntries.length > 0) lines.push('');
  if (derivedEntries.length > 0) {
    lines.push("  /* derived from the captured palette/type/shadows (--df-* never collide with the site's own) */");
    for (const [k, v] of derivedEntries) lines.push(`  ${k}: ${v};`);
  }
  lines.push('}');
  const darkEntries = Object.entries(tokens.dark ?? {});
  if (darkEntries.length > 0) {
    lines.push('');
    lines.push('/* captured dark theme */');
    lines.push('[data-theme="dark"] {');
    for (const [k, v] of darkEntries) lines.push(`  ${k}: ${v};`);
    lines.push('}');
  }
  return lines.join('\n');
}

function buildSpecMarkdown(entry) {
  const a = entry.analysis;
  const md = [];
  md.push(`# Design spec — ${entry.name}`);
  md.push('');
  md.push(`- Source: ${entry.url}`);
  md.push(`- Captured: ${entry.capturedAt}`);
  if (entry.notes) md.push(`- Notes: ${entry.notes}`);
  if (entry.meta?.description) md.push(`- Site description: ${entry.meta.description}`);
  md.push('');
  md.push('## Palette (by frequency)');
  md.push('');
  md.push('| Color | Uses | Luminance |');
  md.push('|---|---|---|');
  for (const c of a.palette) md.push(`| \`${c.value}\` | ${c.count} | ${c.lum} |`);
  md.push('');
  md.push('## Typography');
  md.push('');
  md.push('**Font stacks**');
  md.push('');
  for (const f of a.fonts) md.push(`- **${f.family}** (${f.count}×) — \`${f.stack}\``);
  md.push('');
  md.push(`**Type scale (px, by size):** ${a.fontSizes.map((s) => s.value).join(' · ') || '—'}`);
  md.push('');
  md.push(`**Weights:** ${a.fontWeights.map((w) => w.value).join(' · ') || '—'}  **Line heights:** ${a.lineHeights.map((x) => x.value).join(' · ') || '—'}`);
  md.push('');
  md.push('## Space, radius, elevation');
  md.push('');
  md.push(`**Spacing scale:** ${a.spacings.map((s) => s.value).join(' · ') || '—'}`);
  md.push('');
  md.push(`**Radii:** ${a.radii.map((s) => s.value).join(' · ') || '—'}`);
  md.push('');
  if (a.shadows.length) {
    md.push('**Shadows**');
    md.push('');
    for (const s of a.shadows) md.push(`- \`${s.value}\` (${s.count}×)`);
    md.push('');
  }
  if (a.gradients.length) {
    md.push('**Gradients**');
    md.push('');
    for (const g of a.gradients) md.push(`- \`${g.value}\``);
    md.push('');
  }
  if (a.breakpoints.length) {
    md.push(`**Breakpoints:** ${a.breakpoints.map((b) => b.value).join(' · ')}`);
    md.push('');
  }
  if (a.containerWidths.length) {
    md.push(`**Container widths:** ${a.containerWidths.map((b) => b.value).join(' · ')}`);
    md.push('');
  }
  if (a.durations.length || a.easings.length) {
    md.push(`**Motion:** durations ${a.durations.map((d) => d.value).join(' · ') || '—'} | easings ${a.easings.map((e) => e.value).join(' · ') || '—'}`);
    md.push('');
  }
  const lightEntries = Object.entries(entry.tokens.light ?? {});
  const darkEntries = Object.entries(entry.tokens.dark ?? {});
  if (lightEntries.length || darkEntries.length || Object.keys(entry.derived).length) {
    md.push('## Ready-to-paste tokens');
    md.push('');
    md.push('```css');
    md.push(entry.tokensCss);
    md.push('```');
    md.push('');
    md.push(`Token properties: ${lightEntries.length} light, ${darkEntries.length} dark.`);
  }
  md.push('---');
  md.push('');
  md.push('_Capture scope caveat: static CSS only — hover-only, canvas, and JS-injected styles are not reflected._');
  return md.join('\n');
}

// ---------------------------------------------------------------------------
// HTML extraction
// ---------------------------------------------------------------------------

function extractMetaTags(html) {
  const meta = {};
  const linkIcons = [];
  const stylesheetHrefs = [];
  for (const tag of html.matchAll(/<(meta|link)\b[^>]*>/gi)) {
    const tagText = tag[0];
    const attrs = {};
    for (const attr of tagText.matchAll(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[attr[1].toLowerCase()] = attr[2] ?? attr[3] ?? attr[4] ?? '';
    }
    if (tag[1].toLowerCase() === 'meta') {
      const key = attrs.name ?? attrs.property ?? attrs['http-equiv'];
      if (key && attrs.content) meta[key.toLowerCase()] = attrs.content.slice(0, 300);
    } else {
      const rel = (attrs.rel ?? '').toLowerCase();
      const href = attrs.href ?? '';
      if (!href) continue;
      if (rel.includes('icon')) linkIcons.push(href);
      if (rel.includes('stylesheet') && attrs.media !== 'print') stylesheetHrefs.push(href);
    }
  }
  return { meta, linkIcons, stylesheetHrefs };
}

function extractStyleBlocks(html) {
  const blocks = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (m[1]) blocks.push(m[1]);
  }
  return blocks;
}

function extractInlineStyles(html) {
  const styles = [];
  for (const m of html.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const text = m[1] ?? m[2];
    if (text) styles.push(text);
    if (styles.length >= 400) break;
  }
  return styles;
}

// ---------------------------------------------------------------------------
// Capture pipeline
// ---------------------------------------------------------------------------

async function fetchText(ctx, url, signal) {
  const result = await ctx.web.fetch({ url }, signal);
  const kind = result?.body?.kind;
  const content = result?.body?.content;
  if (typeof content !== 'string') {
    throw new Error(`fetch returned no text content for ${url} (status ${result?.statusCode ?? '?'})`);
  }
  return { url: result.url ?? url, statusCode: result.statusCode ?? 0, kind, content };
}

async function mapPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = { ok: true, value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** Score a stylesheet URL: token-ish names and same-origin sheets first. */
function scoreSheetUrl(urlString, pageUrl) {
  let score = 0;
  try {
    const url = new URL(urlString);
    const path = (url.pathname + url.search).toLowerCase();
    if (/token|vars|variable|theme|global|base|core|design|tailwind|main\.|index|root/.test(path)) score += 6;
    if (new URL(pageUrl).host === url.host) score += 2;
  } catch {
    /* keep 0 */
  }
  return score;
}

function extractImportUrls(cssText, baseUrl, limit) {
  const urls = [];
  if (limit <= 0) return urls;
  for (const m of cssText.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
    try {
      urls.push(new URL(m[1], baseUrl).toString());
    } catch {
      /* skip malformed import */
    }
    if (urls.length >= limit) break;
  }
  return urls;
}

/** Capture one website into an analyzed entry object (no I/O here). */
async function buildCapture(ctx, config, args, exec) {
  const signal = exec?.signal;
  signal?.throwIfAborted();
  const requested = normalizeUrl(args.url);

  const doc = await fetchText(ctx, requested.toString(), signal);
  if (doc.statusCode >= 400) {
    throw new Error(`page returned HTTP ${doc.statusCode} for ${doc.url}`);
  }
  if (doc.kind !== 'html') {
    throw new Error(`content at ${doc.url} is "${doc.kind ?? 'binary'}", not HTML — design capture needs a web page`);
  }
  signal?.throwIfAborted();

  const { meta, linkIcons, stylesheetHrefs } = extractMetaTags(doc.content);
  const styleBlocks = extractStyleBlocks(doc.content);
  const inlineStyles = extractInlineStyles(doc.content);

  const sheetUrls = [];
  const seenSheets = new Set();
  for (const href of stylesheetHrefs) {
    try {
      const resolved = new URL(href, doc.url).toString();
      if (resolved.startsWith('data:')) continue;
      if (!seenSheets.has(resolved)) {
        seenSheets.add(resolved);
        sheetUrls.push(resolved);
      }
    } catch {
      /* skip malformed href */
    }
  }
  // Token-rich sheets first: hashed bundle names carry no hints, so score
  // URL keywords, then prefer same-origin, then keep document order.
  const orderedSheets = sheetUrls
    .map((url, index) => ({ url, index, score: scoreSheetUrl(url, doc.url) }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index))
    .map((c) => c.url);

  // Fetch stylesheets (+ first-level @imports) within the byte budget.
  const cssTexts = [];
  for (const block of styleBlocks) cssTexts.push(block);
  const sources = [{ url: doc.url, kind: 'document', chars: doc.content.length }];
  let budget = config.maxTotalCssBytes;
  let truncatedSheets = 0;

  const fetched = new Set(seenSheets);
  const importQueue = [];

  /** Fetch one batch of sheet URLs into cssTexts/sources; returns imports found. */
  const fetchSheetBatch = async (batch) => {
    const results = await mapPool(batch, config.fetchConcurrency, async (sheetUrl) => {
      signal?.throwIfAborted();
      return fetchText(ctx, sheetUrl, signal);
    });
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      const sheetUrl = batch[i];
      if (!result.ok) {
        sources.push({ url: sheetUrl, kind: 'stylesheet', error: String(result.error?.message ?? result.error).slice(0, 160) });
        continue;
      }
      const { content, kind } = result.value;
      if (kind !== 'text' || !content) {
        sources.push({ url: sheetUrl, kind: 'stylesheet', error: `content kind "${kind ?? 'binary'}"` });
        continue;
      }
      if (content.length > config.maxStylesheetBytes) {
        truncatedSheets++;
        sources.push({ url: sheetUrl, kind: 'stylesheet', chars: content.length, note: 'sheet exceeds per-sheet cap; first slice analyzed' });
      } else {
        sources.push({ url: sheetUrl, kind: 'stylesheet', chars: content.length });
      }
      if (content.length <= budget) {
        cssTexts.push(content);
        budget -= content.length;
        for (const importUrl of extractImportUrls(content, sheetUrl, config.maxImportsPerSheet)) {
          if (!fetched.has(importUrl)) {
            fetched.add(importUrl);
            importQueue.push(importUrl);
          }
        }
      } else {
        cssTexts.push(content.slice(0, Math.max(budget, 0)));
        budget = 0;
        truncatedSheets++;
      }
      signal?.throwIfAborted();
    }
  };

  // Round 1: the first half of the budget. Round 2 (top-up) only runs when
  // the site turned out to define few/no CSS custom properties — hashed
  // bundle CSS (Next.js etc.) hides its token sheet beyond the <link> head.
  let pool = orderedSheets;
  const round1 = pool.slice(0, Math.min(pool.length, Math.max(4, Math.ceil(config.maxStylesheets / 2))));
  await fetchSheetBatch(round1);
  pool = pool.slice(round1.length);

  // Full analysis helper (re-run per round; idempotent and cheap).
  const runAnalysis = () => {
    const next = analyzeCssTexts(cssTexts, config);
    feedInlineStyles(next, inlineStyles);
    for (const css of cssTexts) harvestAtRuleNumbers(css, next);
    resolvePendingVars(next);
    return next;
  };

  let collector = runAnalysis();
  let fetchedSheets = round1.length;
  // Keep topping up while the capture looks structurally incomplete: no/ few
  // custom properties, no resolved font stacks, or no color-ish tokens yet
  // (component tokens like --button-* don't count as a palette).
  const wantsMore = (c) =>
    c.tokensLight.size < 12 ||
    c.fonts.size === 0 ||
    ![...c.tokensLight.keys()].some((key) => /color|bg|text|brand|accent|border|surface|fill|icon/i.test(key));
  for (let round = 0; round < 6 && pool.length > 0 && wantsMore(collector); round++) {
    const remaining = Math.max(0, config.hardMaxSheets - fetchedSheets);
    if (remaining <= 0) break;
    // Re-analyze after each chunk so satisfied captures stop early.
    const batch = pool.slice(0, Math.min(remaining, 8));
    await fetchSheetBatch(batch);
    pool = pool.slice(batch.length);
    fetchedSheets += batch.length;
    collector = runAnalysis();
  }

  if (importQueue.length > 0 && budget > 0) {
    const importResults = await mapPool(importQueue, config.fetchConcurrency, async (importUrl) => {
      signal?.throwIfAborted();
      return fetchText(ctx, importUrl, signal);
    });
    for (const result of importResults) {
      if (!result.ok) continue;
      const { content, kind } = result.value;
      if (kind !== 'text' || !content || content.length > budget) continue;
      cssTexts.push(content);
      budget -= content.length;
      sources.push({ url: result.value.url, kind: 'stylesheet(@import)', chars: content.length });
    }
    collector = runAnalysis();
  }

  // Palette excludes the two non-colors that dominate raw counts.
  const palette = topEntries(collector.colors, 40)
    .filter((c) => c.value !== 'transparent' && c.value !== 'currentcolor')
    .slice(0, 24)
    .map((c) => ({ ...c, lum: luminanceClass(c.value) }));
  const analysis = {
    palette,
    fonts: topEntries(collector.fonts, 10, ([, v]) => ({ family: v.family, stack: v.stack, count: v.count, genericOnly: v.genericOnly ?? false })),
    fontSizes: sortedNumericKeys(collector.fontSizes, 20),
    fontWeights: topEntries(collector.fontWeights, 8),
    lineHeights: topEntries(collector.lineHeights, 10),
    letterSpacings: sortedNumericKeys(collector.letterSpacings, 10),
    spacings: sortedNumericKeys(collector.spacings, 24),
    radii: sortedNumericKeys(collector.radii, 16),
    shadows: topEntries(collector.shadows, 12),
    gradients: topEntries(collector.gradients, 8),
    durations: sortedNumericKeys(collector.durations, 10),
    easings: topEntries(collector.easings, 8),
    breakpoints: collapseCloseEntries(sortedNumericKeys(collector.breakpoints, 24), 1),
    containerWidths: collapseCloseEntries(sortedNumericKeys(collector.containerWidths, 12), 4),
    fontFaces: collector.fontFaces.slice(0, 12),
  };

  const tokens = {
    light: Object.fromEntries(selectTokens(collector.tokensLight, config.maxTokenProps)),
    dark: Object.fromEntries(selectTokens(collector.tokensDark, config.maxTokenProps)),
  };
  const derived = deriveTokens(collector);

  const siteName = meta['og:site_name'] ?? meta['application-name'];
  const title = meta['og:title'] ?? (/<title[^>]*>([^<]*)<\/title>/i.exec(doc.content)?.[1] ?? '').trim();
  const name = asString(args.name, { max: 80 }) ?? siteName ?? title ?? requested.hostname;
  const stats = {
    stylesheetsFound: sheetUrls.length,
    stylesheetsUsed: cssTexts.length - styleBlocks.length,
    styleBlocks: styleBlocks.length,
    inlineStyleSamples: inlineStyles.length,
    cssChars: cssTexts.reduce((sum, t) => sum + t.length, 0),
    declarations: collector.declarations,
    truncatedSheets,
  };

  return {
    entry: {
      id: '',
      name,
      url: doc.url,
      requestedUrl: requested.toString(),
      kind: asEnum(args.kind, ['web', 'app', 'doc', 'other']) ?? 'web',
      notes: asString(args.notes, { max: 500 }) ?? '',
      capturedAt: nowIso(),
      meta: {
        title: title || undefined,
        description: meta.description ?? undefined,
        siteName: siteName ?? undefined,
        ogImage: meta['og:image'] ?? undefined,
        themeColor: meta['theme-color'] ?? undefined,
        favicon: linkIcons[0] ? safeResolve(linkIcons[0], doc.url) : undefined,
      },
      analysis,
      tokens,
      derived,
      tokensCss: '',
      sources: sources.slice(0, 40),
      stats,
    },
    collector,
  };
}

function safeResolve(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}

/** Names that look like a design system's core tokens (not component-scoped). */
const CORE_TOKEN_RE = /color|bg|text|border|brand|accent|font|shadow|radius|space|spacing|surface|fill|icon|elevation|theme|palette/i;

/**
 * Apply maxTokenProps at selection time: core design tokens win over
 * component-scoped ones (--button-*, --kbd-*, …); source order preserved
 * within the picked set.
 */
function selectTokens(map, max) {
  const entries = [...map.entries()];
  if (entries.length <= max) return entries;
  const core = entries.filter(([key]) => CORE_TOKEN_RE.test(key));
  const rest = entries.filter(([key]) => !CORE_TOKEN_RE.test(key));
  const picked = new Set([...core, ...rest].slice(0, max).map(([key]) => key));
  return entries.filter(([key]) => picked.has(key));
}

/** Pull @media breakpoint widths + max-width container values out of raw CSS. */
function harvestAtRuleNumbers(css, collector) {
  for (const m of css.matchAll(/@(?:media|container)\b[^{]*?\((?:min|max)-width\s*:\s*([\d.]+)(px|rem|em)\s*\)/gi)) {
    const px = m[2].toLowerCase() === 'px' ? Number(m[1]) : Number(m[1]) * 16;
    if (px >= 200 && px <= 4096) bump(collector.breakpoints, `${round1(px)}px`);
  }
  for (const m of css.matchAll(/max-width\s*:\s*([\d.]+)(px|rem|em)\s*[;}]/g)) {
    const px = m[2].toLowerCase() === 'px' ? Number(m[1]) : Number(m[1]) * 16;
    if (px >= 320 && px <= 4096) bump(collector.containerWidths, `${round1(px)}px`);
  }
}

// ---------------------------------------------------------------------------
// Store layer (JSON files + rebuilt index)
// ---------------------------------------------------------------------------

function defaultStoreDir() {
  return path.join(os.homedir(), '.dsh', 'storages', 'design-forge');
}

function storePaths(config) {
  const root = config.storeDir ? path.resolve(config.storeDir) : defaultStoreDir();
  return { root, entries: path.join(root, 'entries'), index: path.join(root, 'index.json') };
}

function ensureStore(config) {
  const { entries } = storePaths(config);
  fs.mkdirSync(entries, { recursive: true });
}

function entryPath(config, id) {
  const { entries } = storePaths(config);
  return path.join(entries, `${id}.json`);
}

function readEntryFile(config, id) {
  try {
    return JSON.parse(fs.readFileSync(entryPath(config, id), 'utf8'));
  } catch {
    return undefined;
  }
}

function writeEntryFile(config, entry) {
  ensureStore(config);
  const file = entryPath(config, entry.id);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

function deleteEntryFile(config, id) {
  try {
    fs.unlinkSync(entryPath(config, id));
    return true;
  } catch {
    return false;
  }
}

/** Rebuild the index by scanning entry files (source of truth = the files). */
function rebuildIndex(config) {
  const { entries, index } = storePaths(config);
  const rows = [];
  let files = [];
  try {
    files = fs.readdirSync(entries).filter((f) => f.endsWith('.json') && !f.includes('.tmp-'));
  } catch {
    files = [];
  }
  for (const file of files) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(entries, file), 'utf8'));
      rows.push(indexRowFromEntry(entry));
    } catch {
      /* skip unreadable entry */
    }
  }
  rows.sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1));
  ensureStore(config);
  const tmp = `${index}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, index);
  return rows;
}

function loadIndex(config) {
  const { index } = storePaths(config);
  try {
    const rows = JSON.parse(fs.readFileSync(index, 'utf8'));
    if (Array.isArray(rows)) return rows;
  } catch {
    /* fall through to rebuild */
  }
  return rebuildIndex(config);
}

function indexRowFromEntry(entry) {
  return {
    id: entry.id,
    name: entry.name,
    url: entry.url,
    kind: entry.kind,
    notes: entry.notes,
    capturedAt: entry.capturedAt,
    palette: (entry.analysis?.palette ?? []).slice(0, 8).map((c) => ({ value: c.value, count: c.count })),
    fonts: (entry.analysis?.fonts ?? []).slice(0, 3).map((f) => ({ family: f.family, count: f.count })),
    fontSizes: (entry.analysis?.fontSizes ?? []).slice(0, 8).map((s) => s.value),
    radii: (entry.analysis?.radii ?? []).slice(0, 6).map((s) => s.value),
    shadows: entry.analysis?.shadows?.length ?? 0,
    tokens: {
      light: Object.keys(entry.tokens?.light ?? {}).length,
      dark: Object.keys(entry.tokens?.dark ?? {}).length,
    },
    stats: {
      declarations: entry.stats?.declarations ?? 0,
      stylesheetsUsed: entry.stats?.stylesheetsUsed ?? 0,
    },
    file: `${entry.id}.json`,
  };
}

/** Pick a free id: requested slug, then -2, -3 … */
function allocateId(config, base, refreshId) {
  if (refreshId && readEntryFile(config, refreshId)) return refreshId;
  const { entries } = storePaths(config);
  const taken = (id) => fs.existsSync(path.join(entries, `${id}.json`));
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) {
    if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

const OUTPUT_SCHEMA = { type: 'object', additionalProperties: true, properties: {} };

function jsonRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

function compactCaptureSummary(entry, file) {
  const a = entry.analysis;
  return {
    ok: true,
    id: entry.id,
    name: entry.name,
    url: entry.url,
    kind: entry.kind,
    storedAt: file,
    capturedAt: entry.capturedAt,
    palette: a.palette.slice(0, 12),
    fonts: a.fonts.slice(0, 5),
    fontSizes: a.fontSizes.slice(0, 14).map((s) => s.value),
    fontWeights: a.fontWeights.map((w) => w.value),
    spacingScale: a.spacings.slice(0, 14).map((s) => s.value),
    radii: a.radii.slice(0, 8).map((s) => s.value),
    shadows: a.shadows.slice(0, 4).map((s) => s.value),
    gradients: a.gradients.slice(0, 3).map((g) => g.value),
    breakpoints: a.breakpoints.map((b) => b.value),
    tokens: { light: Object.keys(entry.tokens.light).length, dark: Object.keys(entry.tokens.dark).length },
    stats: entry.stats,
    next: `design_library { action: "get", id: "${entry.id}" } for the full analysis, or { action: "export", id: "${entry.id}", format: "tokens" | "spec" } for ready-to-use CSS / a Markdown design spec.`,
  };
}

function defineCaptureTool(config, ctx) {
  return {
    name: 'design_capture',
    description: 'Capture a website\'s real design into the persistent local design library: fetches the page (through the harness web fetch provider, so proxy routing applies) plus its stylesheets, distills the palette with usage counts, font stacks and type scale, spacing rhythm, radii, shadows, gradients, motion, breakpoints, dark-theme variants, and the site\'s own CSS custom-property tokens, then stores one JSON entry plus a ready-to-paste tokens.css. Use when the user shares or praises a website, or before reusing any site\'s look. Pair with design_library to read and apply captures.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Page URL to capture (http/https).' },
        name: { type: 'string', description: 'Label for the entry; defaults to the site name or <title>.' },
        kind: { type: 'string', enum: ['web', 'app', 'doc', 'other'], description: 'What the capture is for; defaults to web.' },
        notes: { type: 'string', description: 'Why this design is worth reusing (mood, brand, what to imitate).' },
        refresh: { type: 'boolean', description: 'Overwrite an existing entry with the same id (ids derive from the label/host).' },
      },
      required: ['url'],
    },
    output: { schema: OUTPUT_SCHEMA, render: jsonRender },
    async execute(args, exec) {
      const url = asString(args.url, { max: 2048 });
      if (!url) throw new Error('url is required');
      const { entry } = await buildCapture(ctx, config, { ...args, url }, exec);
      const base = slugify(asString(args.name, { max: 80 }) ?? entry.name, entry.url ? new URL(entry.url).hostname.replace(/^www\./, '').split('.')[0] : 'site');
      const refreshId = asBool(args.refresh) ? base : undefined;
      entry.id = allocateId(config, base, refreshId);
      entry.tokensCss = buildTokensCss(entry);
      const file = writeEntryFile(config, entry);
      rebuildIndex(config);
      return compactCaptureSummary(entry, file);
    },
    presentCall: (args) => ({ card: 'generic', title: `Capture design from ${typeof args?.url === 'string' ? args.url : 'URL'}`, kind: 'read', rawInput: args }),
  };
}

function defineLibraryTool(config) {
  return {
    name: 'design_library',
    description: 'The persistent local design library of captured website designs (from design_capture). list shows every captured design with its palette/fonts/scale; search filters them; get returns the full analysis (palette with usage counts, font stacks, type scale, spacing, radii, shadows, gradients, breakpoints, captured CSS custom-property tokens); export returns ready-to-use assets (format: "tokens" = tokens.css with CSS variables, "spec" = a Markdown design spec, "json" = the raw entry); delete removes one. Check this library BEFORE designing any website, app UI, dashboard, email, poster, deck, or document typography from scratch, and apply the closest captured design\'s tokens.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'search', 'get', 'delete', 'export'], description: 'Library operation.' },
        id: { type: 'string', description: 'Entry id (required for get/delete/export).' },
        query: { type: 'string', description: 'For search: substring across id/name/url/notes/palette/font families.' },
        format: { type: 'string', enum: ['tokens', 'spec', 'json'], description: 'For export: tokens.css (default), Markdown design spec, or raw JSON.' },
      },
      required: ['action'],
    },
    output: { schema: OUTPUT_SCHEMA, render: jsonRender },
    async execute(args) {
      const action = asEnum(args.action, ['list', 'search', 'get', 'delete', 'export']);
      if (!action) throw new Error('action must be one of list/search/get/delete/export');
      const id = asString(args.id, { max: 120 });

      if (action === 'list' || action === 'search') {
        const rows = rebuildIndex(config);
        let entries = rows;
        if (action === 'search') {
          const query = (asString(args.query, { max: 200 }) ?? '').toLowerCase();
          if (!query) throw new Error('search needs a query');
          entries = rows.filter((row) => {
            const haystack = [
              row.id, row.name, row.url, row.notes, row.kind,
              ...(row.palette ?? []).map((c) => c.value),
              ...(row.fonts ?? []).map((f) => f.family),
            ].join(' ').toLowerCase();
            return haystack.includes(query);
          });
        }
        return {
          ok: true,
          action,
          storeDir: storePaths(config).root,
          total: entries.length,
          entries: entries.slice(0, 50),
          hint: entries.length === 0
            ? 'The library is empty — capture designs with design_capture { url: "..." } (sites the user admires), then apply their tokens.'
            : 'Pick the entry closest to the target mood/brand and apply its palette, type scale, spacing, radii, and shadows; use export(format: "tokens") for CSS variables.',
        };
      }

      if (!id) throw new Error(`${action} needs an entry id (design_library { action: "list" } shows them)`);
      if (action === 'delete') {
        const existed = deleteEntryFile(config, id);
        if (!existed) throw new Error(`no entry "${id}" in the library`);
        const rows = rebuildIndex(config);
        return { ok: true, action, deleted: id, remaining: rows.length };
      }
      const entry = readEntryFile(config, id);
      if (!entry) throw new Error(`no entry "${id}" in the library (design_library { action: "list" } shows valid ids)`);

      if (action === 'get') {
        return { ok: true, action, entry };
      }
      // export
      const format = asEnum(args.format, ['tokens', 'spec', 'json']) ?? 'tokens';
      const content = format === 'json'
        ? JSON.stringify(entry, null, 2)
        : format === 'spec'
          ? buildSpecMarkdown(entry)
          : entry.tokensCss || buildTokensCss(entry);
      const clipped = content.length > 60_000 ? `${content.slice(0, 60_000)}\n/* … truncated; full content at ${entryPath(config, id)} */` : content;
      return { ok: true, action, id, format, file: entryPath(config, id), content: clipped };
    },
    presentCall: (args) => ({ card: 'generic', title: `Design library — ${typeof args?.action === 'string' ? args.action : 'query'}`, kind: 'read', rawInput: args }),
  };
}

// ---------------------------------------------------------------------------
// Prompt section
// ---------------------------------------------------------------------------

function buildSectionText(config) {
  return [
    `design-forge: a local design library of captured website designs exists on disk (${storePaths(config).root}).`,
    `Before building any website page, web/app UI, dashboard, email, poster, slide deck, or document typography from scratch, call design_library { action: "list" } first; when a captured design matches the target's mood or brand, apply its captured tokens (palette, font stacks, type scale, spacing rhythm, radii, shadows) as the design system and say which captured design informed the deliverable. Blend and adapt — never copy logos, images, text content, or distinctive trademarked artwork.`,
    `When the user shares or praises a website, offer to preserve it with design_capture { url: "..." } (add notes about what to imitate); design_library { action: "export", id, format: "tokens" | "spec" } returns ready-to-paste CSS variables or a Markdown design spec.`,
    `If the library is empty, suggest capturing 2-3 sites the user admires before starting a large design task.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

/** Test/debug access to the pure analyzer internals. */
export const __internals = { stripCssComments, walkCss, handleStyleBody, parseDeclarations, matchBrace, findTopLevelColon, pushDeclaration };

/** Register the two tools and (config permitting) the guidance section. */
export function apply(ctx, config) {
  const resolved = normalizeConfig(config);
  ensureStore(resolved);

  ctx.tools.register(defineCaptureTool(resolved, ctx));
  ctx.tools.register(defineLibraryTool(resolved));

  if (resolved.promptSection) {
    ctx.systemPrompt.section({
      name: 'design-forge',
      order: 2155, // after the web-fetch note (2150), before LSP (2200)
      text: buildSectionText(resolved),
    });
  }
}
