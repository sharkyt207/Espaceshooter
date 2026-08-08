/**
 * build-stylesheet-page.mjs - inline the packed frames into the style page.
 *
 * The page is written as ordinary HTML with a single placeholder where the
 * frame data belongs, so it stays readable and editable; this step swaps the
 * placeholder for the JSON that `pack-styleshots.mjs` produced. Keeping them
 * apart means a re-capture never touches the markup.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const TEMPLATE = process.argv[2] ?? './scripts/styles-page.html';
const SHOTS = process.argv[3] ?? './dist/styleshots.json';
const OUT = process.argv[4] ?? './dist/stilrichtungen.html';

const template = readFileSync(TEMPLATE, 'utf8');
const shots = readFileSync(SHOTS, 'utf8');

if (!template.includes('"__SHOTS__"')) {
  throw new Error('template has no "__SHOTS__" placeholder');
}

writeFileSync(OUT, template.replace('"__SHOTS__"', shots));
console.log(`Wrote ${OUT} (${(Buffer.byteLength(template) + Buffer.byteLength(shots)) / 1024 / 1024} MB)`);
