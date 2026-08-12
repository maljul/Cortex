/**
 * TWO APPS, SIDE BY SIDE — turning a file tree into something an `iframe` can render.
 *
 * `07` §2 asks the naive toggle to make the contrast *visible*. Since 2026-08-13 the agents
 * build a small orders dashboard rather than patching library files, so the contrast is two
 * running apps: one where the order list has a pager, prices read `£12.34` and the form
 * refuses an oversell, and one where an agent reported each of those done and the code is not
 * there.
 *
 * **Self-contained, and that is a hard requirement rather than a preference.** The document
 * produced here is handed to `iframe srcdoc`, so it must reach no network at all — no module
 * imports, no external stylesheet, no fetch. Two consequences the corpus has to respect and
 * `bench/demo-app/README.md` states: plain scripts in a fixed load order, and no `import`.
 * Anything else means the page can only show one app, or can show them only after a build
 * step, and the whole argument is the two together.
 *
 * **Nothing here executes the app.** It concatenates text. A tree containing a patch that
 * broke the app still bundles, and it *should* — the naive lane's app is meant to be broken,
 * and a bundler that refused to render broken output would quietly delete the evidence.
 */

/** Load order. `app.js` last, because it calls into all of them. */
const SCRIPT_ORDER = ['money.js', 'orders.js', 'templates.js', 'notify.js', 'app.js'] as const;

export interface AppTree {
  [file: string]: string;
}

/**
 * Escapes a closing script tag inside JavaScript source.
 *
 * The HTML parser ends a `<script>` block at the first `</script>` in the text, wherever it
 * appears — including inside a string literal. An agent's patch that adds one would truncate
 * the document and produce a blank app, which on this page would read as "the mechanism lost
 * the whole file" rather than "the bundler is wrong".
 */
function inlineScript(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/**
 * One self-contained HTML document from a tree of the demo app's files.
 *
 * Missing files are skipped rather than throwing: an arm that never applied a patch to
 * `notify.js` still has a renderable app, and that difference is the point.
 */
export function assembleApp(tree: AppTree): string {
  const styles = tree['styles.css'] ?? '';
  const body = tree['index.html'] ?? '';
  const scripts = SCRIPT_ORDER.filter((name) => typeof tree[name] === 'string')
    .map((name) => `<script>\n${inlineScript(tree[name]!)}\n</script>`)
    .join('\n');

  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>\n${styles}\n</style>`,
    '</head><body>',
    body,
    scripts,
    // `start()` is called after every script is parsed, so load order is the only ordering
    // this document depends on. Guarded because a lane whose `app.js` was lost has no
    // `start` at all, and a thrown ReferenceError would blank a page that should instead
    // show exactly how much of the app went missing.
    '<script>if (typeof start === "function") { start(); }</script>',
    '</body></html>',
  ].join('\n');
}

/** The files the demo app is made of, in the order they load. */
export const APP_FILES: readonly string[] = ['index.html', 'styles.css', ...SCRIPT_ORDER];
