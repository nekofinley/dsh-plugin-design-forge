// Find parser pollution: declarations whose values contain braces, and show
// the raw context around them in the source sheet.
import fs from 'node:fs';
import path from 'node:path';
import { __internals } from '../lib/index.js';

const dir = path.join(import.meta.dirname, 'linear-css');
const { walkCss } = __internals;

for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.css'))) {
  const css = fs.readFileSync(path.join(dir, file), 'utf8');
  walkCss(css, ({ chain, decls, atPath }) => {
    for (const decl of decls) {
      if (/[{}]/.test(decl.value)) {
        // locate the value in the source for context
        const idx = css.indexOf(decl.value.slice(0, 24).replace(/[{}]/g, ''));
        const context = idx >= 0 ? css.slice(Math.max(0, idx - 120), idx + decl.value.length + 60) : '(not found)';
        console.log(`--- ${file}`);
        console.log(`chain: ${chain.join(' > ')}${atPath ? ` @ ${atPath}` : ''}`);
        console.log(`polluted: ${decl.prop}: ${decl.value}`);
        console.log(`context: ${JSON.stringify(context)}`);
        console.log();
      }
    }
  });
}
console.log('done');
