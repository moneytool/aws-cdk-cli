import type { StackSelector } from '../../api/cloud-assembly';

export interface EvaluateOptions {
  /**
   * Select the stacks to evaluate
   *
   * @default - All stacks
   */
  readonly stacks?: StackSelector;

  /**
   * Name of the toolkit stack, used to access the stacks' environments
   *
   * @default "CDKToolkit"
   */
  readonly toolkitStackName?: string;

  /**
   * Maximum number of stacks to evaluate in parallel
   *
   * @default 10
   */
  readonly concurrency?: number;
}

/**
 * An expression in a stack template that could not be evaluated against the deployed stack
 */
export interface UnresolvedExpression {
  /**
   * Location of the expression in the template, e.g. `Resources.MyBucket.Properties.BucketName`
   */
  readonly path: string;

  /**
   * The intrinsic function that could not be evaluated, e.g. `Fn::GetAtt`
   */
  readonly intrinsic: string;

  /**
   * Why the expression could not be evaluated
   */
  readonly reason: string;
}

/**
 * A stack template evaluated against the deployed stack
 */
export interface EvaluatedStack {
  /**
   * The name of the stack
   */
  readonly stackName: string;

  /**
   * The hierarchical id of the stack in the cloud assembly
   */
  readonly hierarchicalId: string;

  /**
   * The stack's template, with every expression in `Resources` and `Outputs` that could be
   * evaluated against the deployed stack replaced by its value
   *
   * Expressions that could not be evaluated are left in place, and listed in `unresolved`.
   */
  readonly template: { [key: string]: any };

  /**
   * Expressions that could not be evaluated
   */
  readonly unresolved: UnresolvedExpression[];
}

/**
 * Result of the evaluate action
 */
export interface EvaluateResult {
  /**
   * The evaluated stacks
   */
  readonly stacks: EvaluatedStack[];
}
