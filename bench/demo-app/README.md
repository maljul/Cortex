# The demo app corpus

The small orders dashboard five agents build on screen. **Not the benchmark's corpus** —
`bench/fixtures/` and `bench/tasks.json` are frozen by `08` §4's passed gate and design §1, and
nothing here touches them.

## What this is for

Until 2026-08-13 the demo's agents patched library files nobody ever ran, so the only visible
result was a diff. A judge had to read TypeScript to see that a write had been lost. Now the
agents build **a working app**, both final versions render side by side in the page, and a lost
write is a **feature that visibly is not there**.

## The baseline is deliberately incomplete

Every file here is the *before* state. Each ticket in `bench/demo-workload.ts` adds one visible
feature, and the whole point is that the naive lane finishes with some of them missing:

| Ticket | Adds | Baseline state (what you see without it) |
| --- | --- | --- |
| C1 | pagination on the order list | every row dumped at once, no pager |
| C2 | a status timeline in order detail | the timeline panel says nothing is recorded |
| C3 | a stock check on the new-order form | you can order 999 of an item with 3 in stock |
| P6a/P6b | one order-confirmation banner | no confirmation at all |
| I3 | prices as integer minor units | `12.340000000000002` renders on screen |
| R3 | shipping quotes in minor units | the quote line is wrong for the same reason |

**C1, C2 and C3 all edit `app.js`**, in three separate and non-conflicting regions. That is the
collision the demo is about, and it is deliberately *not* a merge conflict — any merge tool
would take all three. What loses two of them is last-write-wins on the whole file.

## How it is assembled for the page

Plain scripts and a stylesheet, **no ES module imports and no network**, so the runner can
concatenate a file tree into one self-contained document and hand it to an `iframe` via
`srcdoc`. Load order is `money.js`, `orders.js`, `templates.js`, `notify.js`, `app.js`.

Keep it that way. An import statement or an external asset would mean the page could only show
one app, or could show them only after a build step — and `07` §2's whole argument is the two
running side by side.
