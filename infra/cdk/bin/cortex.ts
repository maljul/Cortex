#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { CortexStack } from '../lib/cortex-stack';

const app = new cdk.App();

// Environment-agnostic on purpose: nothing in the stack does an account or region
// lookup, so one synthesized template deploys wherever the CLI is pointed. The cluster
// it talks to is in `aws-us-east-1` and the credentials come from Secrets Manager in
// whichever account deploys it.
new CortexStack(app, 'CortexStack');
