/**
 * The NAIVE arm. spec/06-BENCHMARK-SPEC.md §2.
 *
 * "Shared state: JSON file on disk, last-write-wins. Semantic memory: separate local
 * vector store. Arbitration: none. Dedupe: none."
 *
 * §2 also requires this to be a **fair** representation of what people actually do
 * today, not a strawman, and that requirement shaped two decisions here:
 *
 * 1. **The vector store does not lose writes.** Each note is its own file, so
 *    concurrent agents never clobber one another's memory — which is how a real local
 *    vector store behaves. The naive arm genuinely has semantic recall, and it
 *    currently has *more* of it than the CORTEX arm, whose `findings` table waits on
 *    consolidation (`03` §4.4). Nothing here is arranged to make the naive arm fail at
 *    remembering.
 * 2. **Nothing is scripted to fail.** The load-work-save cycle below is the ordinary
 *    shape of a shared task file: read it, do the work, write it back. The losses come
 *    out of that shape when two agents' cycles overlap on the simulated clock. There
 *    is no code path that drops an entry, and none that checks whose entry it is.
 *
 * §5: "database behaviour is fully live in both arms. The naive arm really does lose
 * writes to its JSON file." These are real `readFileSync`/`writeFileSync` calls
 * against a real file.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { step, type AgentProgram, type Step } from '../scheduler.js';
import type { BenchTask } from '../tasks.js';
import type { Effect, TokenSpend } from '../types.js';

import {
  AGENT_START_STEP_MS,
  cosineDistance,
  RECALL_MAX_DISTANCE,
  toAcknowledged,
  type AssignedAgent,
  type BenchContext,
} from './shared.js';

interface CompletedEntry {
  agent: string;
  note: string;
  files: Effect[];
  tokens: TokenSpend;
}

interface SharedState {
  completed: Record<string, CompletedEntry>;
}

interface NoteFile {
  taskId: string;
  note: string;
  vector: number[];
}

export interface NaiveArm {
  programs(agents: readonly AssignedAgent[]): AgentProgram[];
  finalState(): Promise<string[]>;
  notes(): string[];
}

export function createNaiveArm(ctx: BenchContext, runDir: string): NaiveArm {
  const statePath = join(runDir, 'shared-state.json');
  const notesDir = join(runDir, 'notes');

  mkdirSync(notesDir, { recursive: true });
  if (!existsSync(statePath)) {
    writeFileSync(statePath, `${JSON.stringify({ completed: {} }, null, 2)}\n`, 'utf8');
  }

  function readState(): SharedState {
    return JSON.parse(readFileSync(statePath, 'utf8')) as SharedState;
  }

  function writeState(state: SharedState): void {
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  }

  /** Sorted, so the scan order never depends on the filesystem's. */
  function readNotes(): NoteFile[] {
    return readdirSync(notesDir)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(notesDir, name), 'utf8')) as NoteFile);
  }

  async function* program(agent: AssignedAgent): AsyncGenerator<Step, void, void> {
    for (const task of agent.queue) {
      let embedding: number[] = [];
      yield step('recall', task.id, 1, ctx.recallMs(task, 1), async () => {
        embedding = await ctx.embed(task.statement);
        const near = readNotes().filter(
          (entry) => cosineDistance(embedding, entry.vector) < RECALL_MAX_DISTANCE,
        );
        return { outcome: 'ok', detail: { findings: near.length } };
      });

      // Read-modify-write, split across the work the agent then does. This is the
      // whole mechanism: the snapshot goes stale while the agent works, and the save
      // below writes the stale snapshot back over whatever landed in between.
      let snapshot: SharedState | undefined;
      yield step('load', task.id, 1, ctx.arbitrateMs(task, 1, 'load'), async () => {
        snapshot = readState();
        return { outcome: 'ok', detail: { known: Object.keys(snapshot.completed).length } };
      });

      let workStart = 0;
      let output: Awaited<ReturnType<BenchContext['plan']>> | undefined;
      yield step('work', task.id, 1, ctx.workMs(task), async (at) => {
        workStart = at;
        output = await ctx.plan(task);
        return { outcome: 'ok', detail: { files: output.edits.length } };
      });

      const saveMs = ctx.arbitrateMs(task, 1, 'save');
      yield step('save', task.id, 1, saveMs, async (at) => {
        if (snapshot === undefined || output === undefined) {
          throw new Error('load or work step did not run');
        }

        const abandoned = task.kind === 'abandoned';
        if (!abandoned) {
          snapshot.completed[task.id] = {
            agent: agent.id,
            note: output.note,
            files: output.edits,
            tokens: output.tokens,
          };
          writeState(snapshot);

          // The local vector store: one file per note, so it does not lose writes.
          // Indexed under the task statement's vector rather than the note's, so both
          // arms draw on exactly the same embedding cassettes (§5).
          writeFileSync(
            join(notesDir, `${task.id}.json`),
            `${JSON.stringify({ taskId: task.id, note: output.note, vector: embedding })}\n`,
            'utf8',
          );
        }

        ctx.acknowledge(
          toAcknowledged(
            task,
            agent.id,
            { effects: output.edits, note: output.note, tokens: output.tokens },
            { startVirtualMs: workStart, endVirtualMs: at + saveMs },
          ),
        );

        return {
          outcome: abandoned ? 'abandoned' : 'done',
          detail: { recorded: Object.keys(snapshot.completed).length },
        };
      });
    }
  }

  return {
    programs(agents) {
      return agents.map((agent) => ({
        id: agent.id,
        startVirtualMs: agent.index * AGENT_START_STEP_MS,
        steps: program(agent),
      }));
    },

    async finalState() {
      return Object.keys(readState().completed).sort();
    },

    notes() {
      return [
        `NAIVE shared state: ${statePath}. Real file I/O; losses come from the ` +
          'load-work-save cycle overlapping, not from any code that drops an entry.',
        'The loss rate is high, and the mechanism is worth stating rather than ' +
          'explaining away: each save writes the whole file back from a snapshot taken ' +
          'before the work, so the file ends up holding roughly what the last saver ' +
          'happened to have seen. That is what last-write-wins on a whole-file rewrite ' +
          'does, and 06 §2 specifies exactly that for this arm. A merge at save time ' +
          'would lose far less — and would no longer be last-write-wins, nor would it ' +
          'be safe: this harness serialises steps, so the read-merge-write would look ' +
          'atomic here and would not be atomic between two real processes.',
      ];
    },
  };
}
