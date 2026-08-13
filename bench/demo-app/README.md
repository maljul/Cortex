# The demo app corpus

The small orders dashboard five agents build on screen. **Not the benchmark's corpus** —
`bench/fixtures/` and `bench/tasks.json` are frozen by `08` §4's passed gate and design §1, and
nothing here touches them.

## What this is for

Until 2026-08-13 the demo's agents patched library files nobody ever ran, so the only visible
result was a diff. A judge had to read TypeScript to see that a write had been lost. Now the
agents build **a working app**, both final versions render side by side in the page, and the
naive lane's defects are things a judge can see and click.

## Seven modules, and the layering is the design

```
lib/money.js              formatPrice, lineTotal            ← I3
orders/data.js            the records, the catalogue, the stock
inventory/repository.js   stockOnRecord, availableStock     ← P2
orders/repository.js      allOrders, updateOrderStatus, insertOrder   ← C1 · C2 · C3
shipping/quote.js         shippingQuote                     ← R3
payments/provider.js      the dead end                       ← A1, and the agent it spares
notify/templates.js       confirmationBody                   ← P6b
notify/email.js           notifyOrderPlaced                  ← P6a
orders/list.js            the table and the pager            ← C1
orders/status.js          the status timeline                ← C2
orders/create.js          the new-order action               ← C3
web/{index.html,styles.css,app.js}   the page
```

Design §3.1 asks for a corpus where *"which file does this ticket touch"* has a non-obvious
answer, because every one of its five interlocks has to **cross a module boundary** — a
cross-module contradiction is precisely what file-level isolation cannot see. Fourteen files,
seven modules, and three of the tickets patch two modules each.

## The baseline is deliberately incomplete

Every file here is the *before* state, and `test/app-bundle.test.ts` asserts each absence — a
CORTEX lane that passed because a feature was already present would prove nothing.

| Ticket | Adds | Baseline state (what you see without it) |
| --- | --- | --- |
| C1 | pagination on the order list | seven rows dumped at once, no pager |
| C2 | a status timeline in the detail panel | "No status history is recorded" |
| C3 | a stock check on the order action | you can order two coffees twice with three in stock |
| P6a/P6b | one order-confirmation banner | no confirmation at all |
| P2 | a thirty second cache on stock reads | every read hits the record |
| I3 | prices as integer minor units | `£18.509999999999998` renders on screen |
| R3 | a shipping quote | every order ships free |

**C1, C2 and C3 all edit `orders/repository.js`**, in three separate and non-conflicting
regions. That is the collision the demo is about, and it is deliberately *not* a merge
conflict — any merge tool would take all three. What loses two of them is last-write-wins on
the whole file. Each of the three also patches a view file nobody else touches, so the loss is
**legible**: the pager renders and does not page, rather than a file simply being absent.

## What each interlock actually does, and where it is verified

`test/demo-workload.test.ts` **runs the app** and asserts the composed behaviour, because
design §12 item 8 requires each interlock to be verified to actually break the naive lane:
"an interlock that merges cleanly and then works anyway is a dead beat, and only running it can
tell you which."

| # | Interlock | Naive pane | Verified |
| --- | --- | --- | --- |
| 1 | I3 → R3 money representation | shipping line renders `£0.03` for a `£3.37` quote | executed |
| 2 | P2 → C3 stale cache defeats the guard | guard present, second order oversells, stock goes to −1 | executed |
| 3 | C1 · C2 · C3 one file | one of the three behaviours silently missing | text presence, `test/patches.test.ts` |
| 4 | P6a ‖ P6b same work, two files | the confirmation banner renders twice, identically | executed |
| 5 | A1 → T11 abandonment recall | no file difference at all — a second agent burns the same dead end | journey and token meter |

Interlocks 1 and 2 turn on recall carrying a decision across a boundary, and **V49 measured
that it only does when the closure note names the work rather than the change** (0.8459 → 0.3633
for P2 → C3). Interlock 1 needs no note: `03` §4.4's own fallback lands 0.4323 from R3.

## How it is assembled for the page

Plain scripts and one stylesheet, **no ES module imports and no network**, so the runner can
concatenate a file tree into one self-contained document and hand it to an `iframe` via
`srcdoc`. The load order is a dependency order and lives in `src/demo/app-bundle.ts`.

Keep it that way. An import statement or an external asset would mean the page could only show
one app, or could show them only after a build step — and `07` §2's whole argument is the two
running side by side.

**No input elements, anywhere.** Every action is a button carrying its arguments in data
attributes, so there is no field on the demo surface for invariant 8 to be argued about, and a
judge with thirty seconds clicks rather than types. `test/app-bundle.test.ts` holds that.
