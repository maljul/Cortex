/**
 * U21'S GATE — ten tickets run to completion in both arms against the real cluster, with all
 * four beats observed.
 *
 *   npm run gate:workload
 *
 * That sentence is the unit's done-when, verbatim from design §11, and this script is the only
 * thing that can decide it. Everything it prints comes from the run: the beats are observed
 * moments rather than a script, the meters are read back out of the cluster, and the two apps
 * at the end are the trees the two lanes actually finished with.
 *
 * **Two scopes, not one** (design §4.1). Each arm gets its own `repos` row carrying
 * `demo_expires_at`, so the isolation between the arms is row-level security rather than the
 * incidental "they happen to use different tables" it used to be. It also means each arm has its
 * own `DEMO_SESSION_ROW_CAP` budget, and finding the ceiling deliberately rather than in front of
 * a judge is design §12 item 3 — which this prints.
 *
 * **Beat 4 needs a running changefeed.** Consolidation is performed by the deployed sink reading
 * the cluster's own changefeed, so `npm run changefeed status` must show a running job or the
 * cortex lane's agents will honestly report that nothing was known. That is the correct
 * behaviour and this script says which happened rather than pretending.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { closePool } from '../src/db/pool.js';
import { StatementRecorder, byTransaction } from '../src/db/recorder.js';
import { Embedder } from '../src/embed/titan.js';
import { attributeFeatures, unattributableLosses, type Feature } from '../src/demo/attribution.js';
import { assembleApp } from '../src/demo/app-bundle.js';
import { runArm, ASSIGNMENT, type ArmResult } from '../src/demo/workload.js';
import { createDemoSession, DEMO_SESSION_ROW_CAP, demoState } from '../src/memory/demo.js';
import { DEMO_TASKS, taskById } from '../bench/demo-workload.js';

const ENV_PATH = resolve(process.cwd(), '.env');
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

let failures = 0;

function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

function meterRows(result: ArmResult): string[] {
  const m = result.meter;
  return [
    `duplicate work avoided   ${m.duplicateWorkAvoided}`,
    `duplicate work done      ${m.duplicateWorkDone}`,
    `writes lost              ${m.lostWrites}`,
    `blocked and re-planned   ${m.blockedAndReplanned}`,
    `findings recalled        ${m.findingsRecalled}`,
    `agents spared            ${m.agentsSpared}`,
    `dead ends walked         ${m.deadEndsWalked}`,
    `live embedding calls     ${m.embeddingCalls}`,
    `claim p50 (ms)           ${m.claimP50Ms ?? '—'}`,
    `serialization retries    ${m.serializationRetries}`,
    `wasted tokens            ${m.wastedTokens === null ? 'TBD' : m.wastedTokens}`,
  ];
}

async function main(): Promise<void> {
  const embedder = new Embedder();
  const embed = (text: string) => embedder.embed(text);

  console.log(`the cut: ${DEMO_TASKS.map((t) => t.id).join(' ')}`);
  const waves = new Set(ASSIGNMENT.map((a) => a.wave)).size;
  console.log(`${ASSIGNMENT.length} assignments across 5 agents, in ${waves} waves\n`);

  const cortexScope = await createDemoSession();
  const naiveScope = await createDemoSession();
  console.log(`cortex scope ${cortexScope.sessionId}`);
  console.log(`naive  scope ${naiveScope.sessionId}\n`);

  const cortexRecorder = new StatementRecorder();
  const naiveRecorder = new StatementRecorder();

  const cortexStarted = Date.now();
  const cortex = await runArm({
    sessionId: cortexScope.sessionId,
    arm: 'cortex',
    embed,
    recorder: cortexRecorder,
  });
  const cortexMs = Date.now() - cortexStarted;

  const naiveStarted = Date.now();
  const naive = await runArm({
    sessionId: naiveScope.sessionId,
    arm: 'naive',
    embed,
    recorder: naiveRecorder,
  });
  const naiveMs = Date.now() - naiveStarted;

  // ---- The journey, so a reader can see what happened rather than trust a verdict ----
  for (const result of [cortex, naive]) {
    console.log(`\n${result.arm.toUpperCase()} — ${result.events.length} events`);
    for (const event of result.events) {
      const detail = event.detail ? ` ${JSON.stringify(event.detail).slice(0, 150)}` : '';
      console.log(
        `  ${String(event.at).padStart(6)}ms  ${event.agent}  ${event.taskId.padEnd(4)} ` +
          `${event.phase.padEnd(10)}${detail}`,
      );
    }
  }

  console.log('\n\nMETER');
  const cortexRows = meterRows(cortex);
  const naiveRows = meterRows(naive);
  console.log(`  ${'metric'.padEnd(25)} ${'CORTEX'.padEnd(10)} NAIVE`);
  for (const [index, row] of cortexRows.entries()) {
    const label = row.slice(0, 25);
    console.log(
      `  ${label} ${row.slice(25).trim().padEnd(10)} ${naiveRows[index]!.slice(25).trim()}`,
    );
  }
  console.log(`\n  wall clock: cortex ${cortexMs}ms, naive ${naiveMs}ms`);

  // ---- Attribution — one row per hunk, and every loss must name somebody ----
  /**
   * One feature per hunk — but **only for tickets with a single variant**.
   *
   * A ticket that has an informed variant is not a present-or-absent question: both lanes deliver
   * the feature, differently, and the defect is in how the two versions compose. Testing the
   * uninformed replacement text against a cortex tree that holds the informed one reports the
   * *correctly informed* agent as having lost its work, which is the same defect the meter's
   * readback had. `src/demo/attribution.ts` covers absence; interlocks 1 and 2 are compositions
   * and need the second axis `docs/UNITS.md` describes and no code has.
   */
  const features: Feature[] = DEMO_TASKS.filter((task) => task.informedPatches === undefined)
    .flatMap((task) => task.patches.map((patch) => ({ id: task.id, patch })));
  const records = attributeFeatures({
    features,
    cortex: cortex.tree,
    naive: naive.tree,
    steps: naive.steps,
  });
  const losses = records.filter((r) => r.inCortex && !r.inNaive);
  const unattributed = unattributableLosses(records, naive.steps);

  console.log('\nATTRIBUTION');
  for (const record of losses) {
    console.log(
      `  lost  ${record.feature.padEnd(4)} ${record.file.padEnd(24)} ` +
        `reported done by ${record.agent} (intent ${record.intentId?.slice(0, 8)})`,
    );
  }
  const surplus = records.filter((r) => !r.inCortex && r.inNaive);
  for (const record of surplus) {
    console.log(`  extra ${record.feature.padEnd(4)} ${record.file} — naive did work cortex did not`);
  }

  // ---- Row budgets, per scope. Design §12 item 3 ----
  const cortexState = await demoState(cortexScope.sessionId);
  const naiveState = await demoState(naiveScope.sessionId);

  console.log('\nROW BUDGET (per scope, cap ' + DEMO_SESSION_ROW_CAP + ')');
  console.log(`  cortex  ${cortexState?.rows.used} used, ${cortexState?.rows.remaining} left`);
  console.log(`  naive   ${naiveState?.rows.used} used, ${naiveState?.rows.remaining} left`);

  const cortexTxns = byTransaction(cortexRecorder.statements);
  const naiveTxns = byTransaction(naiveRecorder.statements);
  console.log(
    `\nTRANSACTIONS  cortex ${cortexTxns.length}, naive ${naiveTxns.length}` +
      `  (statements: ${cortexRecorder.statements.length} / ${naiveRecorder.statements.length})`,
  );

  // ---- The gate ----
  console.log('\nGATE');
  const settled = (result: ArmResult) =>
    new Set(result.steps.map((s) => s.taskId)).size;

  check('every ticket reached a terminal outcome in CORTEX', settled(cortex) === DEMO_TASKS.length,
    `${settled(cortex)}/${DEMO_TASKS.length}`);
  check('every ticket reached a terminal outcome in NAIVE', settled(naive) === DEMO_TASKS.length,
    `${settled(naive)}/${DEMO_TASKS.length}`);

  check('beat 1 — recall returned a finding', cortex.beats.recall);
  check('beat 2 — a proposal was deduped', cortex.beats.dedupe);
  /**
   * Beat 3 has **two honest endings and the run picks one**, which the first two gate runs
   * showed by picking a different one each time.
   *
   * Three agents propose for one file at once. A loser whose transaction commits finds the key
   * held, is told who holds it, and re-plans — that is invariant 3, and it is the evidence this
   * demo wants. A loser whose transaction *conflicts* instead gets a 40001, `withRetry` backs it
   * off, and by the time it returns the holder has closed and released, so it is granted with no
   * block ever recorded. Both are the mechanism working and neither is arranged; which happens
   * depends on whether CockroachDB aborts the transaction before or after the claim insert.
   *
   * So the beat is "they contended", satisfied either way, and the stronger claim is reported
   * separately rather than asserted — a page that needs a named holder every time would be
   * depicting a determinism the system does not have (design §9 motion rule 3).
   */
  const contended = cortex.meter.blockedAndReplanned > 0 || cortex.meter.serializationRetries > 0;
  check(
    'beat 3 — two agents wanted one file',
    contended,
    cortex.meter.blockedAndReplanned > 0
      ? `${cortex.meter.blockedAndReplanned} blocked and told the holder`
      : `no block: the losers hit ${cortex.meter.serializationRetries} SERIALIZABLE retries and were granted after the holder released`,
  );
  check('beat 4 — a finding this run produced came back on recall', cortex.beats.consolidate);

  check('the naive lane lost work the cortex lane kept', losses.length > 0, `${losses.length} hunks`);
  check('every loss is attributable', unattributed.length === 0,
    unattributed.length === 0 ? '' : unattributed.map((r) => r.feature).join(', '));
  check('the naive lane did duplicate work the cortex lane avoided',
    naive.meter.duplicateWorkDone > cortex.meter.duplicateWorkDone,
    `${naive.meter.duplicateWorkDone} vs ${cortex.meter.duplicateWorkDone}`);
  check('an agent was spared by what the fleet already knew', cortex.meter.agentsSpared > 0);
  check('the naive lane walked a dead end the cortex lane did not',
    naive.meter.deadEndsWalked > cortex.meter.deadEndsWalked,
    `${naive.meter.deadEndsWalked} vs ${cortex.meter.deadEndsWalked}`);
  check('both scopes stayed inside the row cap',
    (cortexState?.rows.used ?? 0) < DEMO_SESSION_ROW_CAP &&
      (naiveState?.rows.used ?? 0) < DEMO_SESSION_ROW_CAP);
  check('both apps assemble', assembleApp(cortex.tree).length > 0 && assembleApp(naive.tree).length > 0);

  // The interlocks, read off the finished trees. Each one is asserted by executed behaviour in
  // `test/demo-workload.test.ts`; here the question is only whether *this run* produced them.
  const naiveQuote = naive.tree['shipping/quote.js'] ?? '';
  const cortexQuote = cortex.tree['shipping/quote.js'] ?? '';
  check('interlock 1 — naive priced shipping in pounds, cortex in minor units',
    naiveQuote.includes('2.99') && cortexQuote.includes('299'));

  const naiveGuard = naive.tree['orders/repository.js'] ?? '';
  const cortexGuard = cortex.tree['orders/repository.js'] ?? '';
  check('interlock 2 — cortex read the record, naive read the cache',
    cortexGuard.includes('stockOnRecord(wanted.sku)'),
    naiveGuard.includes('availableStock(wanted.sku)') ? 'naive used the cache' : 'naive lost the guard entirely');

  const naiveBanners =
    (naive.tree['notify/email.js'] ?? '').includes('SENT.push') &&
    !(naive.tree['notify/templates.js'] ?? '').includes("return '';");
  check('interlock 4 — naive implemented the confirmation twice', naiveBanners);

  const spared = cortex.events.find((e) => e.phase === 'spared');
  check('interlock 5 — the spared agent is named, with what spared it',
    spared !== undefined && spared.detail?.['fact'] !== undefined);

  console.log(
    `\n${failures === 0 ? 'PASS' : 'FAIL'} — ${failures === 0 ? 'all checks' : `${failures} check(s) failed`}`,
  );
  console.log(`Bedrock embedding calls: ${embedder.stats.invocations}, cache hits: ${embedder.stats.hits}`);

  await closePool();
  if (failures > 0) process.exitCode = 1;
}

await main();
