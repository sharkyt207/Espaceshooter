/**
 * Bundles the built app into one self-contained HTML file.
 *
 * The game already has zero runtime network dependencies - every texture,
 * sprite and sound is generated at boot - so inlining the JS and CSS produces a
 * file that runs from a filesystem, an email attachment or a sandboxed iframe
 * with no server at all.
 *
 * Emits *fragment* HTML by default (no <html>/<head>/<body>), which is what
 * embedding hosts expect. Pass --standalone for a complete document you can
 * open directly from disk.
 *
 * Usage:
 *   npm run build
 *   node scripts/build-singlefile.mjs [--out FILE] [--standalone]
 */

import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const standalone = args.includes('--standalone');
const outPath = argOf('--out', standalone ? 'dist/grayzone-standalone.html' : 'dist/grayzone-embed.html');

const assetDir = 'dist/assets';
const files = await readdir(assetDir);

const jsFile = files.find((f) => f.endsWith('.js'));
const cssFile = files.find((f) => f.endsWith('.css'));
if (!jsFile || !cssFile) {
  throw new Error(`Could not find built assets in ${assetDir}. Run "npm run build" first.`);
}

const js = await readFile(join(assetDir, jsFile), 'utf8');
const css = await readFile(join(assetDir, cssFile), 'utf8');

// Strip the sourcemap reference: the map is 1.1 MB and is not shipped inline.
const code = js.replace(/\/\/# sourceMappingURL=.*$/m, '').trim();

// A literal `</script` inside the bundle would close the tag early. Escaping the
// slash is safe in JS string and regex literals alike.
const safeCode = code.replace(/<\/script/gi, '<\\/script');

const fragment = `<title>GRAYZONE PROTOCOL</title>
<style>
${css}
</style>
<div id="app"></div>
<script type="module">
${safeCode}
</script>
`;

const document = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <title>GRAYZONE PROTOCOL</title>
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    />
    <meta name="theme-color" content="#0b0d10" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
    <meta name="color-scheme" content="dark" />
    <style>
${css}
    </style>
  </head>
  <body>
    <div id="app"></div>
    <script type="module">
${safeCode}
    </script>
  </body>
</html>
`;

const output = standalone ? document : fragment;
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, output, 'utf8');

const kb = (output.length / 1024).toFixed(0);
console.log(`Wrote ${outPath} (${kb} kB, ${standalone ? 'standalone document' : 'embeddable fragment'})`);
