import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kms from 'aws-cdk-lib/aws-kms';

export class KmsStack extends cdk.Stack {
  public readonly signingKey: kms.Key;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    this.signingKey = new kms.Key(this, 'EnclaveShareKey', {
      description: 'Mini DFlow Nitro Enclave key-wrapping key; runtime access is attestation-gated',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      alias: 'alias/mini-dflow-enclave-share'
    });
    new cdk.CfnOutput(this, 'KeyArn', { value: this.signingKey.keyArn });
  }
}
