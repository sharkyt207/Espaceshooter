import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

/** Installs the esbuild-backed TypeScript loader for `node --test`. */
register('./ts-loader.mjs', pathToFileURL('./tests/'));
