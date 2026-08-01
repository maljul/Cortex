// Episode -> knowledge-graph extraction, the highest-volume model call in CORTEX.
//
// Cost shape (spec/03-MEMORY-MODEL.md §4.4, consolidation):
//   - The schema and instructions are byte-identical on every episode, so they sit
//     in a cached prefix and bill at cache-read rates rather than full input rates.
//   - Extraction is pattern-matching, not reasoning, so it runs at low effort.
//     Reasoning budget belongs on the traversal path, which runs far less often.
//
// Two failure modes here are silent — no exception, no warning, just a larger bill:
//   - `effort` sent as an HTTP header is ignored and the call runs at default effort.
//     It belongs in `output_config`. Guarded by test/extract.test.ts.
//   - A system prefix under 512 tokens never caches, even with `cache_control` set.
//     Guarded by assertCacheablePrefix below.
import Anthropic from '@anthropic-ai/sdk';

/** Minimum cacheable prefix on Claude Opus 5. Shorter prefixes silently never cache. */
export const MIN_CACHEABLE_PREFIX_TOKENS = 512;

export const EXTRACTION_MODEL = 'claude-opus-5';

/**
 * The cached prefix. Every byte of this is identical on every episode — that is the
 * whole reason it bills at cache-read rates. Editing it invalidates the cache for
 * every in-flight episode, so treat changes as a deploy, not a tweak.
 */
export const EXTRACTION_SYSTEM = `You extract a temporal knowledge graph from a single episode of agent activity in a software repository.

An episode is a natural-language record of something one agent did, proposed, or observed. Your job is to turn it into entities and typed, time-stamped relationships that another agent can traverse later without re-reading the original text.

Return only entities and edges that the episode states or directly implies. Never invent a relationship to make the graph look more connected, and never carry over knowledge about these systems from outside the episode text.

ENTITIES

Each entity has a name, a type, and a one-sentence description.

Use these types: agent, file, glob, migration, service, bug, feature, decision, person, dependency, test. If none fit, use "other" rather than inventing a type name.

Names must be canonical, because two episodes describing the same target must produce the same name or the graph fragments into duplicates:
- Agents are named exactly as the episode names them: agent-3, agent-11.
- Code targets use the resource-key grammar: file:<repo-relative path>, glob:<repo-relative glob>, migration:<id>, service:<name>:<verb>. Normalise to POSIX separators, strip any leading "./", and lowercase the scheme.
- People are named by their full name where the episode gives one; resolve obvious aliases to a single canonical form, so "Buzz Aldrin" and "Edwin Aldrin" become one entity.
- Everything else uses a short lowercase noun phrase, singular, with hyphens instead of spaces.

Descriptions state what the thing is, not what happened to it in this episode. What happened belongs in the edges.

EDGES

Each edge has a source, a target, a relation, and a valid_from timestamp.

Source and target must both be names that appear in your entities array. Do not emit an edge to an entity you did not also declare.

Relations are lowercase verb phrases in the present tense, with underscores instead of spaces: claims, releases, modifies, depends_on, blocks, supersedes, reported_by, fixes, tests, owns, contradicts. Prefer an existing relation over coining a new one.

valid_from is the moment the relationship became true, as an ISO 8601 date or date-time. Resolve relative expressions such as "yesterday" or "last Tuesday" against the reference_time supplied with the episode. If the episode implies no time for a relationship, use null rather than guessing or defaulting to the reference time — a wrong timestamp is worse than an absent one, because the temporal layer is the entire reason this graph exists rather than a pile of embeddings.

Where an episode describes something ending — a claim released, a decision superseded, a dependency dropped — emit that as its own edge with its own valid_from, rather than deleting or amending the edge that established it. The graph is append-only; history is the product.

SCOPE

Everything you extract belongs to one repository. Do not emit entities representing the repository itself, the fleet, or the memory system, and do not emit edges whose only content is that two things appear in the same episode. Co-occurrence is not a relationship.

If the episode contains no extractable graph — it is pure narration, an empty status ping, or otherwise carries no entities and no relationships — return empty arrays. An empty result is a valid and useful answer. Padding it with weak entities is not.`;

/** Structured-output schema. Guarantees parseable output instead of hoping the prompt holds. */
export const GRAPH_SCHEMA = {
  type: 'object',
  properties: {
    entities: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['name', 'type', 'description'],
        additionalProperties: false,
      },
    },
    edges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          target: { type: 'string' },
          relation: { type: 'string' },
          valid_from: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['source', 'target', 'relation', 'valid_from'],
        additionalProperties: false,
      },
    },
  },
  required: ['entities', 'edges'],
  additionalProperties: false,
} as const;

export interface Episode {
  text: string;
  /** ISO 8601. Relative dates in the episode resolve against this. */
  occurredAt: string;
}

export interface ExtractedEntity {
  name: string;
  type: string;
  description: string;
}

export interface ExtractedEdge {
  source: string;
  target: string;
  relation: string;
  valid_from: string | null;
}

export interface ExtractedGraph {
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
}

export interface RawUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

export interface ExtractionUsage {
  /** Billed at cache-read rates — a tenth of base input. */
  cachedTokens: number;
  /** Billed at the cache-write premium. Expected once per prefix, not per episode. */
  writtenTokens: number;
  /** Billed at full input rates. */
  uncachedTokens: number;
  outputTokens: number;
  cacheHit: boolean;
}

/**
 * Conservative token estimate, deliberately biased low so the guard trips early
 * rather than letting a marginal prefix through. Exact counts come from
 * `client.messages.countTokens` at runtime; this exists to fail fast offline.
 */
export function estimatePrefixTokens(text: string): number {
  return Math.floor(text.length / 4);
}

export function assertCacheablePrefix(system: string): void {
  const estimated = estimatePrefixTokens(system);

  if (estimated < MIN_CACHEABLE_PREFIX_TOKENS) {
    throw new Error(
      `Extraction prefix is too short to cache: ~${estimated} tokens, minimum is ` +
        `${MIN_CACHEABLE_PREFIX_TOKENS}. A shorter prefix is accepted by the API and ` +
        `silently never cached, so every episode would bill at full input rates.`,
    );
  }
}

export interface BuildOptions {
  system?: string;
  model?: string;
  maxTokens?: number;
}

/**
 * Builds the extraction request. Stable content first (cached), variable content
 * last (never cached) — the ordering is what makes the prefix reusable at all.
 */
export function buildExtractionRequest(episode: Episode, options: BuildOptions = {}) {
  const system = options.system ?? EXTRACTION_SYSTEM;

  assertCacheablePrefix(system);

  return {
    model: options.model ?? EXTRACTION_MODEL,
    max_tokens: options.maxTokens ?? 2000,
    system: [
      {
        type: 'text' as const,
        text: system,
        // 1h rather than the 5m default: a backfill spans far more than five minutes,
        // and an expired entry means re-paying the write premium mid-run.
        cache_control: { type: 'ephemeral' as const, ttl: '1h' as const },
      },
    ],
    output_config: {
      // Mechanical work. The reasoning budget belongs on the traversal path.
      effort: 'low' as const,
      format: { type: 'json_schema' as const, schema: GRAPH_SCHEMA },
    },
    messages: [
      {
        role: 'user' as const,
        content: `reference_time: ${episode.occurredAt}\n\n${episode.text}`,
      },
    ],
  };
}

export function summarizeUsage(usage: RawUsage): ExtractionUsage {
  const cachedTokens = usage.cache_read_input_tokens ?? 0;

  return {
    cachedTokens,
    writtenTokens: usage.cache_creation_input_tokens ?? 0,
    uncachedTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheHit: cachedTokens > 0,
  };
}

export interface ExtractOptions extends BuildOptions {
  client?: Anthropic;
}

export interface ExtractionResult {
  graph: ExtractedGraph;
  usage: ExtractionUsage;
}

let sharedClient: Anthropic | undefined;

function defaultClient(): Anthropic {
  if (!sharedClient) {
    sharedClient = new Anthropic();
  }

  return sharedClient;
}

export async function extractGraph(
  episode: Episode,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const { client = defaultClient(), ...buildOptions } = options;
  const request = buildExtractionRequest(episode, buildOptions);

  const response = await client.messages.create(
    request as unknown as Anthropic.MessageCreateParamsNonStreaming,
  );

  const text = response.content.find((block) => block.type === 'text');

  if (!text || text.type !== 'text') {
    throw new Error(`Extraction returned no text block (stop_reason: ${response.stop_reason})`);
  }

  return {
    graph: JSON.parse(text.text) as ExtractedGraph,
    usage: summarizeUsage(response.usage as RawUsage),
  };
}
