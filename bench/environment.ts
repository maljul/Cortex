/**
 * `environment.json`. spec/06-BENCHMARK-SPEC.md §6, §7.2.
 *
 * §7.2: "Publish the environment: cluster tier, region, model ids, dates." Everything
 * below is either observed at run time (Node's version, the cluster's own build
 * string, the dependency versions in `package.json`) or read from the configuration
 * that actually drove the run (the model ids in the environment). Nothing is copied
 * from a document, because a hand-copied environment block is how a published run
 * comes to describe a cluster it never touched.
 *
 * The one field that cannot be observed is the Cloud **tier**: CockroachDB does not
 * report "Basic" over SQL. It is named here as configuration with its source stated,
 * so a reader knows which line to distrust.
 */
import { readFileSync } from 'node:fs';
import { arch, platform, release } from 'node:os';

import { clusterIdentity } from '../src/db/identity.js';
import { EMBED_DIMENSIONS, EMBED_MODEL } from '../src/embed/titan.js';
import { REASON_MODEL } from './reason.js';
import { JUDGE_THRESHOLD } from './metrics.js';

interface PackageJson {
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

export interface EnvironmentBlock {
  recordedAt: string;
  cortexVersion: string;
  runtime: { node: string; platform: string; release: string; arch: string };
  dependencies: Record<string, string>;
  cluster: {
    version: string;
    user: string;
    database: string;
    /** Not observable over SQL. Stated as configuration, with its source. */
    tierSource: string;
  };
  models: {
    embed: string;
    embedDimensions: number;
    reason: string;
    region: string;
    /** Whether the run replayed cassettes or called the models. */
    mode: string;
  };
  judge: { threshold: number; distance: string; groundTruth: string };
  harness: { scheduler: string; concurrency: string };
}

export async function describeEnvironment(options: {
  recordedAt: string;
  mode: string;
}): Promise<EnvironmentBlock> {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as PackageJson;
  const cluster = await clusterIdentity();

  return {
    recordedAt: options.recordedAt,
    cortexVersion: pkg.version,
    runtime: {
      node: process.version,
      platform: platform(),
      release: release(),
      arch: arch(),
    },
    dependencies: { ...pkg.dependencies, ...pkg.devDependencies },
    cluster: {
      version: cluster.version,
      user: cluster.user,
      database: cluster.database,
      tierSource:
        'CockroachDB Cloud Basic, cluster agent-hack-30704, aws-us-east-1. Configuration, ' +
        'not observation: the tier is not reported over SQL. The version string above ' +
        'is the cluster speaking for itself.',
    },
    models: {
      embed: process.env.BEDROCK_EMBED_MODEL ?? EMBED_MODEL,
      embedDimensions: EMBED_DIMENSIONS,
      reason: process.env.BEDROCK_REASON_MODEL ?? REASON_MODEL,
      region: process.env.BEDROCK_REGION ?? '(AWS SDK default chain)',
      mode: options.mode,
    },
    judge: {
      threshold: JUDGE_THRESHOLD,
      distance: 'cosine, computed in bench/judge.ts — not the operator the mechanism uses',
      groundTruth:
        'the `pair` labels in bench/tasks.json, written by hand before anything was measured',
    },
    harness: {
      scheduler:
        'one step at a time on a simulated clock; agents start at staggered offsets',
      concurrency:
        'none — contention is real and deterministic, but two transactions never ' +
        'overlap, so serialization_retries is 0 by construction and claim latencies ' +
        'are uncontended. See docs/DECISIONS.md.',
    },
  };
}
