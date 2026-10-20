import * as fs from 'fs';
import * as path from 'path';
import { GetResourceCommand } from '@aws-sdk/client-cloudcontrol';
import { DescribeStacksCommand, GetTemplateCommand, ListStackResourcesCommand, StackStatus } from '@aws-sdk/client-cloudformation';
import { StackSelectionStrategy } from '../../lib/api/cloud-assembly';
import { Toolkit } from '../../lib/toolkit';
import { cdkOutFixture, TestIoHost } from '../_helpers';
import {
  mockCloudControlClient,
  mockCloudFormationClient,
  mockSdkProvider,
  restoreSdkMocksToDefault,
  setDefaultSTSMocks,
} from '../_helpers/mock-sdk';

const FIXTURE = 'stack-with-references';
const template = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '_fixtures', FIXTURE, 'cdk.out', 'Stack1.template.json'), 'utf-8'));
const STACK_ID = 'arn:aws:cloudformation:us-east-1:123456789012:stack/Stack1/f1b0a1b0-0000-0000-0000-000000000000';

let ioHost: TestIoHost;
let toolkit: Toolkit;

beforeEach(() => {
  jest.restoreAllMocks();
  restoreSdkMocksToDefault();
  setDefaultSTSMocks();
  mockSdkProvider();
  ioHost = new TestIoHost('info', true);
  toolkit = new Toolkit({ ioHost, unstableFeatures: ['evaluate'] });
});

function givenDeployedStack() {
  mockCloudFormationClient.on(DescribeStacksCommand).resolves({
    Stacks: [{
      StackName: 'Stack1',
      StackId: STACK_ID,
      StackStatus: StackStatus.CREATE_COMPLETE,
      CreationTime: new Date(),
      Parameters: [{ ParameterKey: 'BootstrapVersion', ParameterValue: '/cdk-bootstrap/hnb659fds/version', ResolvedValue: '30' }],
    }],
  });
  mockCloudFormationClient.on(GetTemplateCommand).resolves({ TemplateBody: JSON.stringify(template) });
  mockCloudFormationClient.on(ListStackResourcesCommand).resolves({
    StackResourceSummaries: [
      {
        LogicalResourceId: 'MyBucketF68F3FF0',
        PhysicalResourceId: 'stack1-mybucket-1a2b3c',
        ResourceType: 'AWS::S3::Bucket',
        ResourceStatus: 'CREATE_COMPLETE',
        LastUpdatedTimestamp: new Date(),
      },
      {
        LogicalResourceId: 'BucketName742CD8B0',
        PhysicalResourceId: 'CFN-BucketName742CD8B0-abc',
        ResourceType: 'AWS::SSM::Parameter',
        ResourceStatus: 'CREATE_COMPLETE',
        LastUpdatedTimestamp: new Date(),
      },
    ],
  });
}

describe('evaluate', () => {
  test('requires the evaluate unstable feature', async () => {
    const stableToolkit = new Toolkit({ ioHost });
    const cx = await cdkOutFixture(stableToolkit, FIXTURE);

    await expect(stableToolkit.evaluate(cx)).rejects.toThrow(/Unstable feature 'evaluate' is not enabled/);
  });

  test('replaces references, attributes and pseudo parameters with their deployed values', async () => {
    // GIVEN
    givenDeployedStack();
    mockCloudControlClient.on(GetResourceCommand).rejects(new Error('cloud control is unavailable'));

    // WHEN
    const cx = await cdkOutFixture(toolkit, FIXTURE);
    const result = await toolkit.evaluate(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS } });

    // THEN
    expect(result.stacks).toHaveLength(1);
    const stack = result.stacks[0];
    expect(stack.stackName).toEqual('Stack1');
    expect(stack.template.Resources.BucketName742CD8B0.Properties.Value).toEqual('stack1-mybucket-1a2b3c');
    expect(stack.template.Outputs.BucketArn.Value).toEqual('arn:aws:s3:::stack1-mybucket-1a2b3c');
    expect(stack.template.Outputs.Name.Value).toEqual('Stack1');
    expect(stack.template.Outputs.Joined.Value).toEqual('stack1-mybucket-1a2b3c-us-east-1');

    // the attribute that needs a Cloud Control lookup is kept and reported
    expect(stack.template.Outputs.BucketDomain.Value).toEqual({ 'Fn::GetAtt': ['MyBucketF68F3FF0', 'RegionalDomainName'] });
    expect(stack.unresolved).toEqual([expect.objectContaining({
      path: 'Outputs.BucketDomain.Value',
      intrinsic: 'Fn::GetAtt',
    })]);
  });

  test('looks up attributes through Cloud Control, and leaves the other template sections as they are', async () => {
    // GIVEN
    givenDeployedStack();
    mockCloudControlClient.on(GetResourceCommand).resolves({
      ResourceDescription: { Properties: JSON.stringify({ RegionalDomainName: 'stack1-mybucket-1a2b3c.s3.us-east-1.amazonaws.com' }) },
    });

    // WHEN
    const cx = await cdkOutFixture(toolkit, FIXTURE);
    const result = await toolkit.evaluate(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS } });

    // THEN
    const stack = result.stacks[0];
    expect(stack.unresolved).toEqual([]);
    expect(stack.template.Outputs.BucketDomain.Value).toEqual('stack1-mybucket-1a2b3c.s3.us-east-1.amazonaws.com');
    expect(stack.template.Rules.CheckBootstrapVersion).toEqual(template.Rules.CheckBootstrapVersion);
  });

  test('fails when the stack is not deployed', async () => {
    // GIVEN
    mockCloudFormationClient.on(DescribeStacksCommand).rejects(Object.assign(new Error('Stack with id Stack1 does not exist'), { name: 'ValidationError' }));

    // WHEN
    const cx = await cdkOutFixture(toolkit, FIXTURE);

    // THEN
    await expect(toolkit.evaluate(cx, { stacks: { strategy: StackSelectionStrategy.ALL_STACKS } }))
      .rejects.toThrow("stack 'Stack1' is not deployed in aws://123456789012/us-east-1, deploy it before evaluating its template");
  });
});
