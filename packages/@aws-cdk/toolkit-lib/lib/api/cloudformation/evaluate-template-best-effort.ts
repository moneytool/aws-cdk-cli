import type { EvaluateCloudFormationTemplate } from './evaluate-cloudformation-template';
import type { Template } from './stack-helpers';
import type { UnresolvedExpression } from '../../actions/evaluate';
import { formatErrorMessage } from '../../util';

/**
 * A template with as many expressions as possible replaced by their values
 */
export interface BestEffortEvaluation {
  /**
   * The template, with every expression in `Resources` and `Outputs` that could be evaluated replaced by its value
   */
  readonly template: Template;

  /**
   * The expressions that could not be evaluated, innermost first
   */
  readonly unresolved: UnresolvedExpression[];
}

/**
 * Evaluates every expression in the `Resources` and `Outputs` of a template, one expression at a time.
 *
 * An expression that cannot be evaluated does not stop the rest: it is kept in place (with its arguments
 * evaluated where possible) and reported. When an expression fails because one of its arguments failed,
 * only the innermost failure is reported.
 */
export async function evaluateTemplateBestEffort(
  evaluator: EvaluateCloudFormationTemplate,
  template: Template,
): Promise<BestEffortEvaluation> {
  const unresolved: UnresolvedExpression[] = [];

  async function evaluate(node: any, path: string): Promise<any> {
    if (Array.isArray(node)) {
      const out = [];
      for (const [i, x] of node.entries()) {
        out.push(await evaluate(x, `${path}.${i}`));
      }
      return out;
    }
    if (node === null || typeof node !== 'object') {
      return node;
    }
    const intrinsic = intrinsicName(node);
    if (intrinsic) {
      try {
        return await evaluator.evaluateCfnExpression(node);
      } catch (e) {
        const before = unresolved.length;
        const args = await evaluate(node[intrinsic], `${path}.${intrinsic}`);
        if (unresolved.length === before) {
          unresolved.push({ path, intrinsic, reason: formatErrorMessage(e) });
        }
        return { [intrinsic]: args };
      }
    }
    const out: { [key: string]: any } = {};
    for (const [key, value] of Object.entries(node)) {
      out[key] = await evaluate(value, `${path}.${key}`);
    }
    return out;
  }

  const evaluated: Template = { ...template };
  for (const section of ['Resources', 'Outputs']) {
    if (template[section]) {
      evaluated[section] = await evaluate(template[section], section);
    }
  }
  return { template: evaluated, unresolved };
}

function intrinsicName(node: { [key: string]: any }): string | undefined {
  const keys = Object.keys(node);
  if (keys.length === 1 && (keys[0] === 'Ref' || keys[0].startsWith('Fn::'))) {
    return keys[0];
  }
  return undefined;
}
