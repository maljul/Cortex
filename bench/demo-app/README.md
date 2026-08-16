# The demo app corpus

The small orders dashboard five agents build on screen. **Not the benchmark's corpus** —
`bench/fixtures/` and `bench/tasks.json` are frozen by `08` §4's passed gate and design §1, and
nothing here touches them.

## What this is for

Until 2026-08-13 the demo's agents patched library files nobody ever ran, so the only visible
result was a diff. A judge had to read TypeScript to see that a write had been lost. Now the
agents build **a working app**, both final versions render side by side in the page, and the
naive lane's defects are things a judge can see and click.

## Fourteen files, seven modules, and the layering is the design

```
lib/money.js              representation, rounding, allocation        ← I3
orders/data.js            catalogue, stock, orders, status flow, tariff
inventory/repository.js   stock on record, reservations, availability ← P2
orders/repository.js      ordering, paging, status changes, inserts   ← C1 · C2 · C3
shipping/quote.js         billable weight and the quote               ← R3
payments/provider.js      the v2 integration, and the dead end        ← A1, and the agent it spares
notify/templates.js       template composition and the copy           ← P6b
notify/email.js           the outbox, retries and the delivered log   ← P6a
orders/list.js            the table, the caption and the pager        ← C1
orders/status.js          the status pane and the timeline            ← C2
orders/create.js          drafting, validation, placing               ← C3
web/{index.html,styles.css,app.js}   the page
```

Design §3.1 asks for a corpus where *"which file does this ticket touch"* has a non-obvious
answer, because every one of its five interlocks has to **cross a module boundary** — a
cross-module contradiction is precisely what file-level isolation cannot see.

## Deep enough that a ticket is real work (2026-08-16)

The corpus was fifteen files of four hundred to sixteen hundred bytes until 2026-08-16, and
every ticket against it was answerable by reading one function. That is fine while the patches
are committed and fatal the moment an agent authors the code: a ticket a model finishes in one
glance produces the same answer every run, and **a demo whose outcome never varies reads as a
recording**. It is now roughly 1,700 lines across the fourteen files, ninety to a hundred and
eighty lines in each module a ticket touches.

Four properties, and `test/app-bundle.test.ts` holds the first three:

1. **The answer is not inside the file the ticket names.** Money has to know what the catalogue
   stores and what the tax bands mean; the quote has to know the tariff and the box dimensions;
   the guard has to know that availability is stock on record minus reservations. The test
   carries a table of module-to-collaborator dependencies and fails if a module becomes
   self-contained.
2. **There is real substance to get right.** Integer minor units with a rounding rule and a
   largest-remainder allocation; billable weight as the greater of actual and volumetric;
   pagination over a *stable* sort, with a tie-break that exists because two orders share a
   `placedAt` to the second; a status flow with an ordering invariant and a terminal state;
   retry with capped exponential backoff; template composition with unfilled-slot handling.
3. **More than one correct way to write each.** Two models will produce visibly different code
   for any of these, which is the point — the demo's credibility rests on outcomes varying.
4. **Getting it wrong is silent.** Every defect these tickets can compose into leaves an app
   that still runs and still renders. That is what makes the interlocks bite.

**No ticket ids or interlock explanations appear in the corpus source any more.** They were
there, and a comment reading *"R3 is only correct if it knows I3 moved money to integer minor
units"* hands the answer to any agent that reads the file. The modules now document what they
are and what invariants they hold, the way a real codebase does. The design lives here, in a
file that is not in `APP_FILES` and that no agent is handed.

## The baseline is deliberately incomplete

Every file here is the *before* state, and `test/app-bundle.test.ts` asserts each absence — a
CORTEX lane that passed because a feature was already present would prove nothing.

| Ticket | Adds | Baseline state (what you see without it) |
| --- | --- | --- |
| C1 | pagination on the order list | fourteen rows dumped at once, no pager |
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

## The acceptance oracle — `acceptance.ts`, and why you must not put it in `APP_FILES`

Interlocks used to be detected by **text matching**: `src/demo/attribution.ts` asks whether a
tree's file contains a committed patch's replacement text, and `scripts/gate-workload.mts` asks
the same of four fixed markers. Exact and cheap while every patch is committed — and the moment
an agent authors the code, none of that text is there, every marker reads absent, and the page
reports interlocks and lost writes that never happened, silently, with the suite green.

`acceptance.ts` decides them **behaviourally** instead. It assembles the tree, runs it through
`src/demo/evaluate.ts` — the same execution `test/demo-workload.test.ts` uses, so the two cannot
drift — and asks the questions a judge would ask by clicking. Two sets:

- `TICKET_CHECKS`, one per ticket that carries code: *did this agent's change work on its own?*
  Run against a tree carrying only that ticket, **every one passes in both lanes**. That is
  design §3.1's sharpest claim made executable: neither agent wrote a bug.
- `COMPOSITION_CHECKS`, one per interlock: *does the assembled app behave?* These are what the
  naive lane fails while every ticket check in the same tree still passes.

Every check returns `{ id, verdict, observed }` and never a bare boolean, because `observed` is
the string the page renders as evidence — *"shipping renders £0.03; the tariff for 0.75kg is
£3.37"* is a defect a reader can check. `error` is a third verdict rather than a false: a tree
that throws, because a lane lost a whole file, is a different fact from a tree that answers
wrongly.

**It is withheld from the agents and `test/acceptance.test.ts` enforces that** — not in
`APP_FILES`, not in any tree handed to an agent, not in the assembled document, and referred to
by no module outside `test/`. A corpus whose test suite the agent can read is a specification it
optimises against, and the question quietly turns from *"did the agent do the work"* into *"did
the agent make the tests pass"*.

**Interlock 5 has no check and cannot have one.** A1 and T11 patch nothing, so both lanes' trees
are byte-identical; every behavioural question has the same answer in each. What differs is
whether a second agent spent its budget rediscovering a dead end, and that shows in the journey
and the token meter or nowhere.

## What each interlock actually does, and where it is verified

| # | Interlock | Naive pane | Verified |
| --- | --- | --- | --- |
| 1 | I3 → R3 money representation | shipping line renders `£0.03` for a `£3.37` quote | `COMPOSITION_CHECKS` `interlock-1`, executed |
| 2 | P2 → C3 stale cache defeats the guard | guard present, second order oversells, stock goes to −1 | `interlock-2`, executed |
| 3 | C1 · C2 · C3 one file | one of the three behaviours silently missing | `interlock-3`, executed against the lossy tree |
| 4 | P6a ‖ P6b same work, two files | the confirmation banner renders twice, identically | `interlock-4`, executed |
| 5 | A1 → T11 abandonment recall | no file difference at all — a second agent burns the same dead end | journey and token meter |

Interlock 3 **passes** on the naive lane's *intended* tree and fails only once last-write-wins
has been through the shared file. That distinction is asserted, and it matters: it is the
difference between two correct changes composing wrongly and a change that is simply gone, which
is the difference between `src/demo/attribution.ts` having something to say and having nothing.

Interlocks 1 and 2 turn on recall carrying a decision across a boundary, and **V49 measured that
it only does when the closure note names the work rather than the change** (0.8459 → 0.3633 for
P2 → C3). Interlock 1 needs no note: `03` §4.4's own fallback lands 0.4323 from R3.

## How it is assembled for the page

Plain scripts and one stylesheet, **no ES module syntax and no network**, so the runner can
concatenate a file tree into one self-contained document and hand it to an `iframe` via
`srcdoc`. The load order is a dependency order and lives in `src/demo/app-bundle.ts`.

Keep it that way. A module keyword or an external asset would mean the page could only show one
app, or could show them only after a build step — and `07` §2's whole argument is the two running
side by side. A module keyword also fails silently: the iframe renders blank with no error, so
`test/app-bundle.test.ts` asserts its absence against the files as well as the document.

**No input elements, anywhere.** Every action is a button carrying its arguments in data
attributes, so there is no field on the demo surface for invariant 8 to be argued about, and a
judge with thirty seconds clicks rather than types. `test/app-bundle.test.ts` holds that.
