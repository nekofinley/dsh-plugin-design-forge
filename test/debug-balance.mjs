// Locate the construct that unbalances the brace walker.
import fs from 'node:fs';
import path from 'node:path';
import { __internals } from '../lib/index.js';

const dir = path.join(import.meta.dirname, 'linear-css');
const { matchBrace, stripCssComments } = __internals;

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
  const css = stripCssComments(fs.readFileSync(path.join(dir, file), 'utf8'));
  // Simple depth scan honoring quotes, mirroring matchBrace.
  let depth = 0;
  let quote = null;
  let minDepth = 0;
  let firstNeg = -1;
  for (let i = 0; i < css.length; i++) {
    const ch = css[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth < minDepth) { minDepth = depth; if (firstNeg === -1) firstNeg = i; }
    }
  }
  if (minDepth < 0 || depth !== 0) {
    console.log(`${file}: final depth ${depth}, min ${minDepth}, first-negative-at ${firstNeg}`);
    if (firstNeg >= 0) console.log(`  context: ${JSON.stringify(css.slice(Math.max(0, firstNeg - 150), firstNeg + 80))}`);
    // also find unterminated string
    let q = null, qStart = -1;
    for (let i = 0; i < css.length; i++) {
      const ch = css[i];
      if (q) { if (ch === '\\') i++; else if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; qStart = i; }
    }
    if (q) console.log(`  UNTERMINATED STRING starting at ${qStart}: ${JSON.stringify(css.slice(qStart - 80, qStart + 120))}`);
  } else {
    console.log(`${file}: balanced (final depth 0)`);
  }
}
