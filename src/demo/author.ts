/**
 * WHO WRITES THE CODE — the seam that decides whether an agent thinks or recites.
 *
 * Until this module existed, `applyAndSave` called `appliedPatches(task, informed)` and got back
 * committed text: the ticket's patch, or its `informedPatches` variant when recall had handed the
 * agent the decision. The *coordination* was entirely live — dedupe, claims, races, the changefeed
 * — but the *content* was fixed, so every run produced a byte-identical pair of applications and a
 * reader could reasonably conclude the whole thing was staged. It was not, and that is exactly the
 * problem: a true claim that looks fabricated is worth less than a weaker one that looks real.
 *
 * A `PatchAuthor` is the one function that answers "what does this agent write". There are two:
 *
 * - `committedAuthor` — the previous behaviour, unchanged, and still the REPLAY path. It costs
 *   nothing, it cannot fail, and it is what an anonymous visitor gets so that rule B4 survives a
 *   month without an unbounded Bedrock bill.
 * - `modelAuthor` — a real Bedrock call. The agent is handed the task statement, the bytes it just
 *   read, and whatever `recall()` returned, and the model authors the edit.
 *
 * **The two arms differ by what goes into the prompt, and by nothing else.** The cortex agent's
 * request carries `findings`; the naive agent's carries an empty array, because `whatIsKnown`
 * returns nothing for that lane — that stack has no verb with which to ask. This is the honest
 * asymmetry and not a handicap: nothing in the naive prompt is weakened, sabotaged or shortened.
 * It is the same model, the same statement, the same files, the same token budget. The only
 * missing thing is the fact the fleet already paid to learn, which is the entire thesis.
 *
 * A consequence worth stating plainly, because it is a *feature* and will otherwise read as a bug:
 * an uninformed model sometimes gets it right anyway. The naive lane will fail on some runs and
 * not others. A lane that failed one hundred per cent of the time would be a script; one that
 * fails most of the time is a measurement.
 *
 * WHAT THE MODEL RETURNS, AND WHY IT IS THIS SHAPE
 *
 * `{"edits":[{"file","find","replace"}],"note":"..."}` — the `Patch` shape `src/demo/patches.ts`
 * already defines, and deliberately not a full file and not a unified diff:
 *
 * - **Not a full file.** `spanOf` (`src/demo/conflicts.ts`), the `lostWrites` readback and
 *   `attributeFeatures` (`src/demo/attribution.ts`) are all defined over `patch.replace`. A whole
 *   file has no anchor, so `06` §3's `conflicting_edits` would have nothing to locate and every
 *   collision figure on the page would silently become zero.
 * - **Not a unified diff.** Applying one needs context matching and fuzz, and `patches.ts` refuses
 *   fuzz by name: an apply that lands *somewhere* is indistinguishable from the coordination
 *   failure this demo exists to show, while actually being a bug in the demo.
 *
 * The shape also self-validates. `applyPatch` throws `PatchError` when an anchor is missing or
 * appears twice, and `applyAndSave` already treats that as a real outcome rather than an
 * exception, so a model that hallucinates an anchor is handled by a path that predates it.
 *
 * VALIDATION, IN ORDER, AND WHY IT STOPS WHERE IT DOES
 *
 * 1. The response parses as JSON (a markdown fence is tolerated — Haiku 4.5 emits one).
 * 2. Every `file` named is one the agent was actually handed. A model may not invent a path, and
 *    it may not reach a file outside the corpus. This is invariant 7's spirit applied to a model
 *    output: nothing structural crosses the boundary from the model into the system.
 * 3. Every `find` occurs **exactly once** in the bytes the agent read. Zero means a hallucinated
 *    anchor; more than one means an ambiguous edit.
 * 4. The patched source **compiles**, checked with `node:vm` — and is **never executed**.
 *
 * Point 4 is the one worth reading twice. Compiling answers "did the model emit syntactically
 * valid JavaScript" honestly, which is the question that matters, while model-authored code never
 * runs inside the function that holds the demo's database credentials. The composed app *is*
 * executed later, but in a sandboxed `iframe` in the visitor's browser with no same-origin access
 * — which is where untrusted code belongs and where the page already puts it. Each file is
 * compiled on its own rather than the concatenation, so a failure names the file that broke.
 *
 * WHEN VALIDATION FAILS, THE AGENT STILL DOES THE TICKET
 *
 * Every failure path falls back to the committed patch and reports `source: 'fallback'`. It does
 * not throw, and it does not skip the ticket. A judge behind the run button may never be shown an
 * error page (`04` §5 invariant 1), and a run that half-completed because Bedrock throttled is a
 * worse outcome than one that completed with two tickets recited instead of authored. The
 * fallback is *counted*, not hidden: `AuthorResult.source` is carried out to the meter so the page
 * can say how many hunks on this run the model actually wrote.
 *
 * COST IS BOUNDED BY CONTRACT, NOT BY ESTIMATE
 *
 * `max_tokens` is a hard ceiling on the expensive side of the bill, so the output half of the cost
 * model is provable rather than projected. The model is Haiku 4.5, reached through its
 * cross-region inference profile — verified entitled on this account on 2026-08-16, ~1470ms. The
 * benchmark keeps Sonnet 4.5 and its committed cassettes: the cassette key includes the model, so
 * a shared constant here would silently invalidate `08` §4's published table.
 */
import { Script } from 'node:vm';
import { BedrockRuntimeClient, InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';

import type { Finding } from '../memory/recall.js';
import { applyPatch, PatchError, type FileTree, type Patch } from './patches.js';

/** The Bedrock envelope `bench/reason.ts` verified. Sonnet 4.5 and Haiku 4.5 are both pre-4.6, so
 *  `output_config.effort` errors on them and `thinking` must be omitted rather than configured. */
const ANTHROPIC_VERSION = 'bedrock-2023-05-31';

/**
 * **Named separately from the benchmark's `REASON_MODEL` on purpose.**
 *
 * `bench/reason.ts` calls Sonnet 4.5 and its cassette key includes the model id. Repointing that
 * constant would invalidate every committed cassette and with them `08` §4's passed gate. This is
 * a second constant for a second job.
 *
 * Haiku 4.5 is roughly a third of Sonnet's rate on both token directions, which is the difference
 * between a LIVE cap of a handful of runs and a cap that survives a month of judging. The task —
 * read a file, author a small anchored edit, emit strict JSON — sits well inside it.
 */
export const FLEET_REASON_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

/**
 * The output ceiling, and therefore the ceiling on the expensive half of the bill.
 *
 * Large enough for a genuine multi-hunk edit, small enough that one call's worst case is known
 * before it is made. A truncated answer is refused rather than salvaged: half a JSON object is
 * not a smaller edit, it is a broken one.
 */
export const FLEET_MAX_OUTPUT_TOKENS = 1400;

export interface AuthorRequest {
  taskId: string;
  statement: string;
  agent: string;
  /** The bytes this agent just read, keyed by corpus-relative path. The model sees exactly what
   *  `applyPatch` will run against — not a fresh read, which could have moved underneath it. */
  files: FileTree;
  /** What `recall()` returned. Empty for the naive lane, which has no way to ask. */
  findings: readonly Finding[];
  /**
   * The reviewed patches this ticket would apply if no model were involved — already resolved to
   * the right variant by the caller, which is the only place that knows whether recall handed the
   * agent the *specific* fact this ticket needed. That condition is narrower than "recall returned
   * something", and deriving it here from `findings.length` instead would silently pick the
   * uninformed variant for an informed agent and delete two interlocks without failing a test.
   *
   * The model never sees this field — `buildPrompt` ignores it. It is the fallback, and on the
   * REPLAY path it is the whole answer.
   */
  committed: readonly Patch[];
}

export interface AuthorResult {
  patches: Patch[];
  /** `model` — the model authored these and they validated. `committed` — the REPLAY path, no
   *  call was made. `fallback` — a call was made and did not survive validation. */
  source: 'model' | 'committed' | 'fallback';
  /** Bedrock's own `usage`, so `06` §3's `wasted_tokens` is measured rather than estimated.
   *  Null when no call was made. */
  usage: { inputTokens: number; outputTokens: number } | null;
  /** One sentence from the model about what it did, or why the fallback fired. Rendered, so it
   *  must never contain anything the model was not asked for. */
  note: string | null;
}

export type PatchAuthor = (request: AuthorRequest) => Promise<AuthorResult>;

/**
 * REPLAY: the committed patch, exactly as before this module existed.
 *
 * `informed` is decided the way it has always been decided — by whether recall actually returned
 * the fact this ticket needed — so the REPLAY path keeps a fully live causal chain (close →
 * changefeed → consolidation → recall) and only the code content is fixed.
 */
export function committedAuthor(): PatchAuthor {
  return async (request) => ({
    patches: [...request.committed],
    source: 'committed',
    usage: null,
    note: null,
  });
}

const SYSTEM_PROMPT = [
  'You are one of five autonomous coding agents working concurrently on a small orders dashboard.',
  'You are given a ticket, the exact current contents of the files you may edit, and sometimes',
  'facts the fleet has already established. Implement the ticket.',
  '',
  'Reply with STRICT JSON and nothing else, in exactly this shape:',
  '{"edits":[{"file":"<path>","find":"<exact existing text>","replace":"<new text>"}],"note":"<one sentence>"}',
  '',
  'Rules you must follow or your work is discarded:',
  '- "file" must be one of the paths you were given. Never invent a path.',
  '- "find" must be text that appears EXACTLY ONCE, byte for byte, in that file as given to you.',
  '  Copy it from the file. Include enough surrounding text to be unique.',
  '- "replace" must be complete, valid JavaScript for that position.',
  '- The codebase uses NO modules: never write import, export or require. Call functions directly;',
  '  they are all in scope at runtime.',
  '- Never add an input element, a form, or a network call.',
  '- If facts from the fleet are supplied, they are established knowledge about this codebase.',
  '  Honour them — they describe decisions other agents already made that yours must compose with.',
  '- Keep the edit minimal and focused on the ticket.',
].join('\n');

function buildPrompt(request: AuthorRequest): string {
  const parts: string[] = [`TICKET: ${request.statement}`, ''];

  if (request.findings.length > 0) {
    parts.push('WHAT THE FLEET ALREADY KNOWS ABOUT THIS CODEBASE:');
    for (const finding of request.findings) {
      const reverted = finding.timesReverted > 0
        ? ` (work on this was reverted ${finding.timesReverted} time(s) before)`
        : '';
      parts.push(`- ${finding.fact}${reverted}`);
    }
    parts.push('');
  }

  parts.push('FILES YOU MAY EDIT (exact current contents):');
  for (const [path, body] of Object.entries(request.files)) {
    parts.push('', `--- ${path} ---`, body);
  }

  return parts.join('\n');
}

/** Tolerates a markdown fence, refuses anything else. Haiku 4.5 fences by default. */
function parseJson(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  try {
    return JSON.parse(fenced ? fenced[1]! : text);
  } catch {
    return null;
  }
}

/**
 * Everything a model output must survive before a single byte of it reaches the corpus.
 *
 * Returns the validated patches, or a string naming why they were refused — a string rather than a
 * throw because the caller's answer to every rejection is the same and is not exceptional.
 */
export function validateEdits(candidate: unknown, files: FileTree): Patch[] | string {
  if (candidate === null || typeof candidate !== 'object') return 'response was not JSON';
  const edits = (candidate as { edits?: unknown }).edits;
  if (!Array.isArray(edits) || edits.length === 0) return 'response carried no edits';

  const patches: Patch[] = [];
  for (const raw of edits) {
    if (raw === null || typeof raw !== 'object') return 'an edit was not an object';
    const { file, find, replace } = raw as Record<string, unknown>;

    if (typeof file !== 'string' || typeof find !== 'string' || typeof replace !== 'string') {
      return 'an edit was missing file, find or replace';
    }
    // The model may only touch what it was handed. Nothing structural crosses this boundary.
    const body = files[file];
    if (body === undefined) return `named a file it was not given: ${file}`;
    if (find.length === 0) return 'an edit had an empty anchor';

    // Exactly once. Zero is a hallucinated anchor; more than one is an ambiguous edit, and
    // `applyPatch` would refuse it anyway — refusing here names the reason.
    const first = body.indexOf(find);
    if (first === -1) return `anchor not found in ${file}`;
    if (body.indexOf(find, first + 1) !== -1) return `anchor appears more than once in ${file}`;

    patches.push({ file, find, replace });
  }

  // Apply them all, then compile what comes out. Applying first matters: two edits to one file
  // must compose, and a pair that individually anchor but together produce broken source is
  // exactly the failure a per-edit check would miss.
  let patched: FileTree = files;
  try {
    for (const patch of patches) patched = applyPatch(patched, patch);
  } catch (error) {
    if (error instanceof PatchError) return `patch did not apply: ${error.message}`;
    throw error;
  }

  for (const file of [...new Set(patches.map((p) => p.file))]) {
    if (!file.endsWith('.js')) continue;
    try {
      // Compile only. Model-authored code is never executed in the process holding the demo DSN;
      // the composed app runs later, in the browser's sandboxed iframe, where it belongs.
      new Script(patched[file]!, { filename: file });
    } catch (error) {
      return `authored ${file} does not parse: ${(error as Error).message}`;
    }
  }

  return patches;
}

export interface ModelAuthorOptions {
  /** Falls back to this whenever a call cannot be made or its result cannot be trusted.
   *  Defaults to the reviewed patches the request already carries. */
  fallback?: PatchAuthor;
  region?: string;
  model?: string;
  /** Injectable so a test can drive validation and fallback without reaching Bedrock. */
  invoke?: (prompt: string) => Promise<{ text: string; inputTokens: number; outputTokens: number }>;
  /** Called on every rejection, so a run can report how often the model was overruled. */
  onReject?: (reason: string) => void;
}

/** LIVE: the model authors the edit, and everything above validates it. */
export function modelAuthor(options: ModelAuthorOptions): PatchAuthor {
  const model = options.model ?? FLEET_REASON_MODEL;
  const fallback = options.fallback ?? committedAuthor();
  let client: BedrockRuntimeClient | null = null;

  const invoke = options.invoke ?? (async (prompt: string) => {
    client ??= new BedrockRuntimeClient(
      options.region ? { region: options.region } : {},
    );
    const response = await client.send(new InvokeModelCommand({
      modelId: model,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify({
        anthropic_version: ANTHROPIC_VERSION,
        max_tokens: FLEET_MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        temperature: 1,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      }),
    }));
    const body = JSON.parse(new TextDecoder().decode(response.body)) as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    if (body.stop_reason === 'max_tokens') {
      throw new Error('model hit max_tokens, so its JSON is truncated');
    }
    return {
      text: (body.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join(''),
      inputTokens: Number(body.usage?.input_tokens ?? 0),
      outputTokens: Number(body.usage?.output_tokens ?? 0),
    };
  });

  return async (request) => {
    // A ticket with nothing to write — the abandoned one — must not spend a call to discover it.
    const fallbackResult = await fallback(request);
    if (fallbackResult.patches.length === 0) return fallbackResult;

    let usage: { inputTokens: number; outputTokens: number } | null = null;
    let reason: string;
    try {
      const answer = await invoke(buildPrompt(request));
      usage = { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens };
      const validated = validateEdits(parseJson(answer.text), request.files);
      if (Array.isArray(validated)) {
        const note = (parseJson(answer.text) as { note?: unknown } | null)?.note;
        return {
          patches: validated,
          source: 'model',
          usage,
          note: typeof note === 'string' ? note.slice(0, 240) : null,
        };
      }
      reason = validated;
    } catch (error) {
      reason = (error as Error).message;
    }

    options.onReject?.(reason);
    return {
      ...fallbackResult,
      source: 'fallback',
      usage,
      note: `the model's answer was not usable (${reason}), so this agent applied the reviewed patch`,
    };
  };
}
