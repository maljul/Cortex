/**
 * The agents' reasoning step, recorded once and replayed thereafter.
 * spec/06-BENCHMARK-SPEC.md §5.
 *
 * What is simulated and what is not, stated plainly because §5 requires it: **model
 * reasoning is replayed, database behaviour is fully live in both arms**. This module
 * is the replayed half. It decides, per task, which line ranges of which fixture files
 * the agent edits and what it learned — the two things §3's `conflicting_edits` and
 * the offline duplicate judge need — and it reports the token spend Bedrock actually
 * billed, so `wasted_tokens` is a measurement rather than a constant.
 *
 * The request shape was verified live against `us.anthropic.claude-sonnet-4-5-
 * 20250929-v1:0` in `us-east-1` on 2026-08-10 before any of this was written; the
 * response envelope is in docs/verification-log.md. It was not written from recall:
 * `05` §6 names the model and nothing had ever invoked it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  BedrockRuntimeClient,
  type BedrockRuntimeClientConfig,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

import type { CassetteStore } from './cassettes.js';
import { CORPUS_DIR, type BenchTask } from './tasks.js';
import type { Effect, TokenSpend } from './types.js';

/** `05` §6 names this variable; the entitled model is the 4-5 one (see CLAUDE.md). */
export const REASON_MODEL = 'us.anthropic.claude-sonnet-4-5-20250929-v1:0';

/** Bedrock's InvokeModel envelope for Anthropic models. Verified live, not recalled. */
const ANTHROPIC_VERSION = 'bedrock-2023-05-31';

export class ReasoningError extends Error {}

export interface ReasonResult {
  edits: Effect[];
  /** One sentence, standing in for the finding consolidation would extract (§4.4). */
  note: string;
  tokens: TokenSpend;
}

const SYSTEM_PROMPT = [
  'You are one agent in a fleet working on a shared TypeScript repository.',
  'You are given a task and the current contents of the files it touches.',
  'Decide which line range of each file you would edit, and state in one sentence what',
  'a later agent would need to know about the code you touched.',
  'Reply with JSON only — no prose, no markdown fence — matching exactly:',
  '{"edits":[{"file":"<path>","start_line":<int>,"end_line":<int>}],"note":"<one sentence>"}',
  'Every file you list must be one you were given. Line numbers are 1-based and',
  'inclusive, and must fall inside the file. Edit only what the task requires.',
].join('\n');

function corpusRoot(): string {
  // Resolved from this module, not from cwd: `npm run bench`, vitest and a future
  // `cortex bench` all run from different places, and a corpus that moves with the
  // working directory would change the prompt and so change every cassette key.
  return join(fileURLToPath(new URL('../', import.meta.url)), CORPUS_DIR);
}

/** `file:src/a.ts` -> `src/a.ts`. A `glob:` key here is a fixture bug, not a runtime case. */
export function pathOfKey(key: string): string {
  if (!key.startsWith('file:')) {
    throw new ReasoningError(
      `bench tasks name files, not ${JSON.stringify(key)}. A glob would expand to a ` +
        'different file set per checkout, which is not reproducible.',
    );
  }
  return key.slice('file:'.length);
}

function numbered(source: string): string {
  return source
    .split('\n')
    .map((line, i) => `${String(i + 1).padStart(4)}| ${line}`)
    .join('\n');
}

/**
 * The exact text sent to the model, and therefore the cassette key.
 *
 * It contains the task and the file bodies and nothing else — no agent id, no arm, no
 * attempt number, no clock. That is what lets both arms replay the *same* cassette for
 * a task, which is §5's methodological point: any difference in the results is
 * attributable to the coordination layer.
 */
export function reasonPrompt(task: BenchTask): string {
  const root = corpusRoot();
  const files = task.resourceKeys.map(pathOfKey).map((path) => {
    const source = readFileSync(join(root, path), 'utf8');
    return `--- ${path} (${source.split('\n').length} lines) ---\n${numbered(source)}`;
  });

  return [`TASK: ${task.statement}`, '', ...files].join('\n');
}

/** Line count per file, used to reject a range the model invented. */
function lineCounts(task: BenchTask): Map<string, number> {
  const root = corpusRoot();
  return new Map(
    task.resourceKeys.map(pathOfKey).map((path) => {
      const source = readFileSync(join(root, path), 'utf8');
      return [path, source.split('\n').length];
    }),
  );
}

/**
 * Checks the model's answer against the task before it is ever written to a cassette.
 *
 * A cassette is committed and replayed forever, so a malformed or out-of-range answer
 * recorded once would silently poison every later run — and `conflicting_edits` is
 * computed from these ranges, so a hallucinated line span becomes a published number.
 * Recording fails loudly instead.
 */
function validate(task: BenchTask, raw: unknown, tokens: TokenSpend): ReasonResult {
  const answer = raw as { edits?: unknown; note?: unknown };
  const counts = lineCounts(task);

  if (!Array.isArray(answer.edits) || answer.edits.length === 0) {
    throw new ReasoningError(`${task.id}: model returned no edits`);
  }
  if (typeof answer.note !== 'string' || answer.note.trim() === '') {
    throw new ReasoningError(`${task.id}: model returned no note`);
  }

  const edits = answer.edits.map((entry) => {
    const edit = entry as { file?: unknown; start_line?: unknown; end_line?: unknown };
    const file = String(edit.file);
    const startLine = Number(edit.start_line);
    const endLine = Number(edit.end_line);
    const total = counts.get(file);

    if (total === undefined) {
      throw new ReasoningError(
        `${task.id}: model edited ${file}, which the task does not claim. Its claim ` +
          'set is what arbitration protects; an edit outside it is unarbitrated by ' +
          'construction and would make the benchmark measure the wrong thing.',
      );
    }
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) {
      throw new ReasoningError(`${task.id}: non-integer line range in ${file}`);
    }
    if (startLine < 1 || endLine < startLine || endLine > total) {
      throw new ReasoningError(
        `${task.id}: line range ${startLine}-${endLine} is outside ${file} (${total} lines)`,
      );
    }

    return { file, startLine, endLine } satisfies Effect;
  });

  return { edits, note: answer.note.trim(), tokens };
}

export interface ReasonerOptions {
  model?: string;
  clientConfig?: BedrockRuntimeClientConfig;
}

export class Reasoner {
  readonly model: string;

  /** Calls that reached Bedrock. A replay run must end with this at zero. */
  invocations = 0;

  private readonly store: CassetteStore;
  private readonly options: ReasonerOptions;
  private client: BedrockRuntimeClient | undefined;

  constructor(store: CassetteStore, options: ReasonerOptions = {}) {
    this.store = store;
    this.model = options.model ?? process.env.BEDROCK_REASON_MODEL ?? REASON_MODEL;
    this.options = options;
  }

  async plan(task: BenchTask): Promise<ReasonResult> {
    const prompt = reasonPrompt(task);
    return this.store.reason(this.model, prompt, async () => {
      const { payload, tokens } = await this.invoke(prompt);
      return validate(task, payload, tokens);
    });
  }

  /**
   * Constructed on first use, like `db/pool.ts` and the MCP server's embedder.
   *
   * U8 found this the hard way: a module-scope client reads `BEDROCK_REGION` before
   * the entry point has loaded `.env`. A replay run never gets here at all, which is
   * what makes replay work with no AWS credentials present.
   */
  private bedrock(): BedrockRuntimeClient {
    if (this.client === undefined) {
      const region = process.env.BEDROCK_REGION;
      this.client = new BedrockRuntimeClient({
        ...(region === undefined ? {} : { region }),
        ...this.options.clientConfig,
      });
    }
    return this.client;
  }

  private async invoke(prompt: string): Promise<{ payload: unknown; tokens: TokenSpend }> {
    this.invocations += 1;

    const response = await this.bedrock().send(
      new InvokeModelCommand({
        modelId: this.model,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          anthropic_version: ANTHROPIC_VERSION,
          max_tokens: 512,
          system: SYSTEM_PROMPT,
          // temperature 0 does not make sampling deterministic — that is what the
          // cassette is for — but it does keep a re-record close to the last one.
          temperature: 0,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        }),
      }),
    );

    const body = JSON.parse(new TextDecoder().decode(response.body)) as {
      content?: Array<{ type: string; text?: string }>;
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    if (body.stop_reason === 'max_tokens') {
      throw new ReasoningError(
        'the model hit max_tokens, so its JSON is truncated. Raise max_tokens rather ' +
          'than salvaging a partial answer into a committed cassette.',
      );
    }

    const text = (body.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('');

    return {
      payload: parseJson(text),
      tokens: {
        input: Number(body.usage?.input_tokens ?? 0),
        output: Number(body.usage?.output_tokens ?? 0),
      },
    };
  }
}

/** Tolerates a markdown fence, refuses anything else. */
function parseJson(text: string): unknown {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/.exec(text);
  const body = fenced ? fenced[1]! : text;

  try {
    return JSON.parse(body);
  } catch (error) {
    throw new ReasoningError(
      `model did not return JSON: ${(error as Error).message}. First 200 chars: ` +
        JSON.stringify(text.slice(0, 200)),
    );
  }
}
