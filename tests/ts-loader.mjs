import { transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * TypeScript loader for the Node test runner.
 *
 * Node's built-in `--experimental-strip-types` only erases annotations; it
 * cannot handle constructor parameter properties, which this codebase uses
 * throughout for dependency injection. Rather than contort production code to
 * suit a test runner, we transpile through esbuild - already present as a Vite
 * dependency, so this adds nothing to the install.
 */

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);

  const path = fileURLToPath(url);
  const source = await readFile(path, 'utf8');
  const { code } = await transform(source, {
    loader: 'ts',
    format: 'esm',
    target: 'es2022',
    sourcefile: path,
    sourcemap: 'inline',
  });

  return { format: 'module', source: code, shortCircuit: true };
}

/**
 * Resolve extensionless relative imports.
 *
 * The source uses bundler-style specifiers (`./Math2D`), which Vite resolves
 * but Node ESM does not. We try `.ts` and then `/index.ts` before giving up,
 * mirroring what the bundler does.
 */
export async function resolve(specifier, context, nextResolve) {
  const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
  const hasExtension = /\.[a-z]+$/i.test(specifier);

  if (isRelative && !hasExtension) {
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`]) {
      try {
        return await nextResolve(candidate, context);
      } catch {
        // Try the next candidate.
      }
    }
  }
  return nextResolve(specifier, context);
}
