/**
 * Bundles the spike handler once, so both IaC stacks deploy the byte-identical
 * artifact and the timed comparison is about the tool and nothing else.
 *
 * CommonJS output, deliberately, while the repository is ESM everywhere else (B1).
 * `pg` reaches for `pg-native` inside a try/catch; under CJS that stays a lazy
 * `require` that fails harmlessly, whereas an ESM bundle hoists the import and throws
 * at module load for a dependency the code already handles being absent.
 *
 * The `.cjs` extension is load-bearing rather than cosmetic. The repository's root
 * `package.json` says `"type": "module"`, so a CommonJS bundle written as `.js` is
 * unloadable here even though Lambda would read it as CommonJS quite happily — and an
 * artifact that only runs after it is uploaded cannot be smoke-tested before it is.
 * Lambda resolves `index.handler` against `.cjs` since nodejs18.x.
 *
 * `.js` specifiers are rewritten to `.ts` by the plugin below. TypeScript's
 * `nodenext` resolution requires source to import `./pool.js` while the file on disk
 * is `pool.ts`; esbuild does not do that remapping, so without this the bundle fails
 * to resolve project source. Nothing about the project changes to accommodate the
 * bundler — the rewrite lives here.
 */
import { build } from 'esbuild';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const resolveTsFromJs = {
  name: 'ts-from-js',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^\.{1,2}\/.*\.js$/ }, (args) => {
      const candidate = resolve(args.resolveDir, args.path).replace(/\.js$/, '.ts');
      return existsSync(candidate) ? { path: candidate } : undefined;
    });
  },
};

/**
 * One directory per function, each containing a single `index.cjs`.
 *
 * Not one shared directory with four entry files: CDK hashes the asset directory, so a
 * shared one makes every function's asset change whenever any handler does, and a
 * one-line edit to the demo router redeploys the changefeed sink as well. Separate
 * directories keep a redeploy to the function that actually changed.
 */
const FUNCTIONS = ['identity', 'demo', 'changefeed', 'connections'];

for (const name of FUNCTIONS) {
  await build({
    entryPoints: [resolve(here, `lambda/${name}.ts`)],
    outfile: resolve(here, `lambda-dist/${name}/index.cjs`),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['pg-native'],
    plugins: [resolveTsFromJs],
    logLevel: 'info',
  });
}
