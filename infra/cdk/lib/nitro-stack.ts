// Launches the parent EC2 node to host the Nitro enclave boundary.
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as kms from "aws-cdk-lib/aws-kms";

interface NitroStackProps extends cdk.StackProps {
  vpc: ec2.Vpc;
  artifactBucket: s3.Bucket;
  signingKey: kms.Key;
  instanceType: string;
  enclaveCpuCount: number;
  enclaveMemoryMiB: number;
}

export class NitroStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: NitroStackProps) {
    super(scope, id, props);

    const role = new iam.Role(this, "NitroParentRole", {
      assumedBy: new iam.ServicePrincipal("ec2.amazonaws.com"),
      description:
        "Parent role for Mini DFlow Nitro Enclave. KMS runtime access is added only by attestation policy.",
    });
    props.artifactBucket.grantRead(role);
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          "ssm:GetParameter",
          "ssm:GetParameters",
          "ssm:GetParametersByPath",
        ],
        resources: ["*"],
      }),
    );
    const sg = new ec2.SecurityGroup(this, "ParentSecurityGroup", {
      vpc: props.vpc,
      allowAllOutbound: true,
      description: "No inbound internet access; management via SSM.",
    });

    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      "dnf update -y",
      "dnf install -y aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel docker jq",
      "systemctl enable --now docker",
      `mkdir -p /etc/nitro_enclaves && cat > /etc/nitro_enclaves/allocator.yaml <<'ALLOC'\n---\nmemory_mib: ${props.enclaveMemoryMiB}\ncpu_count: ${props.enclaveCpuCount}\nALLOC`,
      "systemctl enable --now nitro-enclaves-allocator.service",
      `cat > /etc/nitro_enclaves/vsock-proxy.yaml <<'PROXY'\nallowlist:\n  - {address: kms.${this.region}.amazonaws.com, port: 443}\nPROXY`,
      "systemctl enable --now nitro-enclaves-vsock-proxy.service",
      "usermod -aG ne ec2-user || true",
      "usermod -aG docker ec2-user || true",
      "dnf install -y amazon-ssm-agent || true",
      "systemctl enable --now amazon-ssm-agent || true",
      "mkdir -p /opt/mini-dflow/enclave /opt/mini-dflow/config",
      "echo READY > /opt/mini-dflow/BOOTSTRAPPED",
    );

    const instance = new ec2.Instance(this, "NitroParent", {
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: new ec2.InstanceType(props.instanceType),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      role,
      securityGroup: sg,
      enclaveEnabled: true,
      userData,
      requireImdsv2: true,
      blockDevices: [
        {
          deviceName: "/dev/xvda",
          volume: ec2.BlockDeviceVolume.ebs(50, {
            encrypted: true,
            deleteOnTermination: false,
            volumeType: ec2.EbsDeviceVolumeType.GP3,
          }),
        },
      ],
    });

    instance.node.addDependency(props.signingKey);
    new cdk.CfnOutput(this, "ParentInstanceId", { value: instance.instanceId });
    new cdk.CfnOutput(this, "ParentRoleArn", { value: role.roleArn });
    new cdk.CfnOutput(this, "Region", { value: this.region });
    new cdk.CfnOutput(this, "EnclaveCpu", {
      value: String(props.enclaveCpuCount),
    });
    new cdk.CfnOutput(this, "EnclaveMemoryMiB", {
      value: String(props.enclaveMemoryMiB),
    });
  }
}
