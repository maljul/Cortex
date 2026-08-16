#!/usr/bin/env node
/**
 * `npx cortex` — the bin, and nothing more than a shim.
 *
 * The dispatcher is `src/cli/main.ts`, in TypeScript, so `npx tsc --noEmit` covers the
 * command surface the way it covers everything else in this repository (B1). This file
 * registers tsx's ESM loader and hands over; it holds no logic, because logic here would
 * be the one part of the CLI that nothing typechecks.
 *
 * **tsx is a devDependency and stays one.** Moving it to `dependencies` without
 * regenerating `package-lock.json` would desync the lock's root entry from `package.json`
 * and break `npm ci` — which is exactly the clean-clone path U18 verified (V57), and the
 * lockfile is not this unit's to rewrite. So the bin works from a clone that has run
 * `npm install`, which is what the README asks for, and not from a bare `npm install
 * --production`. Said plainly rather than left to be discovered.
 */
let register;
try {
  ({ register } = await import('tsx/esm/api'));
} catch {
  process.stderr.write(
    'cortex: tsx is not installed, so the TypeScript CLI cannot be loaded.\n' +
      'Run `npm install` in the repository root first.\n',
  );
  process.exit(1);
}

register();

const { main } = await import(new URL('../src/cli/main.js', import.meta.url).href);
process.exitCode = await main(process.argv.slice(2));
