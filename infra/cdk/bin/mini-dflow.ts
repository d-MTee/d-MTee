#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/network-stack';
import { KmsStack } from '../lib/kms-stack';
import { NitroStack } from '../lib/nitro-stack';
import { ArtifactStack } from '../lib/artifact-stack';

const app = new cdk.App();
const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION || 'ap-northeast-2' };
const network = new NetworkStack(app, 'MiniDflowNetwork', { env });
const artifacts = new ArtifactStack(app, 'MiniDflowArtifacts', { env });
const kms = new KmsStack(app, 'MiniDflowKms', { env });
new NitroStack(app, 'MiniDflowNitro', {
  env, vpc: network.vpc, artifactBucket: artifacts.bucket, signingKey: kms.signingKey,
  instanceType: app.node.tryGetContext('instanceType') || 'm5.xlarge',
  enclaveCpuCount: Number(app.node.tryGetContext('enclaveCpuCount') || 2),
  enclaveMemoryMiB: Number(app.node.tryGetContext('enclaveMemoryMiB') || 4096)
});
app.synth();
