import type { EvaluateCloudFormationTemplate } from '../../../lib/api/cloudformation';
import { CfnEvaluationException, evaluateTemplateBestEffort } from '../../../lib/api/cloudformation';

/**
 * An evaluator that knows a fixed set of Refs and fails on everything else,
 * mirroring how EvaluateCloudFormationTemplate evaluates nested arguments.
 */
function fakeEvaluator(refs: { [logicalId: string]: string }): EvaluateCloudFormationTemplate {
  async function evaluateCfnExpression(expr: any): Promise<any> {
    if (Array.isArray(expr)) {
      const out = [];
      for (const x of expr) {
        out.push(await evaluateCfnExpression(x));
      }
      return out;
    }
    if (expr === null || typeof expr !== 'object') {
      return expr;
    }
    if ('Ref' in expr) {
      if (expr.Ref in refs) {
        return refs[expr.Ref];
      }
      throw new CfnEvaluationException(`Parameter or resource '${expr.Ref}' could not be found for evaluation`);
    }
    if ('Fn::Join' in expr) {
      const [sep, parts] = expr['Fn::Join'];
      return (await evaluateCfnExpression(parts)).join(sep);
    }
    throw new CfnEvaluationException(`CloudFormation function ${Object.keys(expr)[0]} is not supported`);
  }
  return { evaluateCfnExpression } as unknown as EvaluateCloudFormationTemplate;
}

describe('evaluateTemplateBestEffort', () => {
  test('replaces every expression it can evaluate, in Resources and Outputs', async () => {
    const result = await evaluateTemplateBestEffort(fakeEvaluator({ 'Bucket': 'my-bucket', 'AWS::Region': 'us-east-1' }), {
      Resources: {
        Param: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'Bucket' }, Tags: [{ Key: 'k', Value: 'literal' }] } },
      },
      Outputs: {
        Joined: { Value: { 'Fn::Join': ['-', [{ Ref: 'Bucket' }, { Ref: 'AWS::Region' }]] } },
      },
    });

    expect(result.unresolved).toEqual([]);
    expect(result.template.Resources.Param.Properties).toEqual({ Value: 'my-bucket', Tags: [{ Key: 'k', Value: 'literal' }] });
    expect(result.template.Outputs.Joined.Value).toEqual('my-bucket-us-east-1');
  });

  test('keeps expressions it cannot evaluate, without affecting the others', async () => {
    const result = await evaluateTemplateBestEffort(fakeEvaluator({ Bucket: 'my-bucket' }), {
      Resources: {
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: {
            Value: { Ref: 'Bucket' },
            Description: { 'Fn::If': ['IsProd', 'prod', 'dev'] },
          },
        },
      },
    });

    expect(result.template.Resources.Param.Properties).toEqual({
      Value: 'my-bucket',
      Description: { 'Fn::If': ['IsProd', 'prod', 'dev'] },
    });
    expect(result.unresolved).toEqual([{
      path: 'Resources.Param.Properties.Description',
      intrinsic: 'Fn::If',
      reason: 'CloudFormation function Fn::If is not supported',
    }]);
  });

  test('reports only the innermost failure, and evaluates the arguments around it', async () => {
    const result = await evaluateTemplateBestEffort(fakeEvaluator({ Bucket: 'my-bucket' }), {
      Outputs: {
        Joined: { Value: { 'Fn::Join': ['-', [{ Ref: 'Bucket' }, { Ref: 'Missing' }]] } },
      },
    });

    expect(result.template.Outputs.Joined.Value).toEqual({ 'Fn::Join': ['-', ['my-bucket', { Ref: 'Missing' }]] });
    expect(result.unresolved).toEqual([{
      path: 'Outputs.Joined.Value.Fn::Join.1.1',
      intrinsic: 'Ref',
      reason: "Parameter or resource 'Missing' could not be found for evaluation",
    }]);
  });

  test('leaves the other template sections untouched', async () => {
    const template = {
      Parameters: { Env: { Type: 'String', Default: { Ref: 'NotEvaluated' } } },
      Conditions: { IsProd: { 'Fn::Equals': [{ Ref: 'Env' }, 'prod'] } },
      Resources: {},
    };

    const result = await evaluateTemplateBestEffort(fakeEvaluator({}), template);

    expect(result.template.Parameters).toBe(template.Parameters);
    expect(result.template.Conditions).toBe(template.Conditions);
    expect(result.unresolved).toEqual([]);
  });
});
