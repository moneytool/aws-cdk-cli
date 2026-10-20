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
   * The expressions that could not be evaluated
   */
  readonly unresolved: UnresolvedExpression[];
}

/** `{ "Ref": "AWS::NoValue" }`: the enclosing property or list element is removed */
const NO_VALUE = Symbol('AWS::NoValue');

/** Unknown truth value of a condition that could not be evaluated */
type Truth = boolean | undefined;

/**
 * Evaluates every expression in the `Resources` and `Outputs` of a template, one expression at a time.
 *
 * Expressions are evaluated with `EvaluateCloudFormationTemplate`. On top of it, this evaluates the template's
 * `Conditions` (`Fn::Equals`, `Fn::And`, `Fn::Or`, `Fn::Not`, `Condition`), `Fn::If` and `AWS::NoValue`, and drops
 * resources and outputs whose condition is false, like CloudFormation does.
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
  const conditions = new Map<string, Promise<Truth>>();
  // The same expression has the same value everywhere in a stack: evaluate it once (saves repeated lookups)
  const evaluations = new Map<string, Promise<any>>();
  const evaluateOnce = (node: any): Promise<any> => {
    const key = JSON.stringify(node);
    if (!evaluations.has(key)) {
      evaluations.set(key, evaluator.evaluateCfnExpression(node));
    }
    return evaluations.get(key)!;
  };

  function condition(name: string): Promise<Truth> {
    if (!conditions.has(name)) {
      const definition = template.Conditions?.[name];
      conditions.set(name, definition === undefined
        ? Promise.resolve(undefined)
        : conditionValue(definition, `Conditions.${name}`));
    }
    return conditions.get(name)!;
  }

  async function conditionValue(expr: any, path: string): Promise<Truth> {
    if (expr !== null && typeof expr === 'object' && !Array.isArray(expr)) {
      if (typeof expr.Condition === 'string' && Object.keys(expr).length === 1) {
        return condition(expr.Condition);
      }
      const [fn] = Object.keys(expr);
      const args = expr[fn];
      switch (fn) {
        case 'Fn::Equals': {
          const [a, b] = [await evaluate(args[0], `${path}.Fn::Equals.0`), await evaluate(args[1], `${path}.Fn::Equals.1`)];
          return containsExpression(a) || containsExpression(b) ? undefined : JSON.stringify(a) === JSON.stringify(b);
        }
        case 'Fn::Not': {
          const v = await conditionValue(args[0], `${path}.Fn::Not.0`);
          return v === undefined ? undefined : !v;
        }
        case 'Fn::And':
        case 'Fn::Or': {
          const values: Truth[] = [];
          for (const [i, arg] of args.entries()) {
            values.push(await conditionValue(arg, `${path}.${fn}.${i}`));
          }
          const decisive = fn === 'Fn::And' ? false : true;
          if (values.includes(decisive)) {
            return decisive;
          }
          return values.includes(undefined) ? undefined : !decisive;
        }
      }
    }
    const value = await evaluate(expr, path);
    return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : undefined;
  }

  async function evaluate(node: any, path: string): Promise<any> {
    if (Array.isArray(node)) {
      const out = [];
      for (const [i, x] of node.entries()) {
        const value = await evaluate(x, `${path}.${i}`);
        if (value !== NO_VALUE) {
          out.push(value);
        }
      }
      return out;
    }
    if (node === null || typeof node !== 'object') {
      return node;
    }
    const intrinsic = intrinsicName(node);
    if (!intrinsic) {
      const out: { [key: string]: any } = {};
      for (const [key, value] of Object.entries(node)) {
        const evaluated = await evaluate(value, `${path}.${key}`);
        if (evaluated !== NO_VALUE) {
          out[key] = evaluated;
        }
      }
      return out;
    }

    if (intrinsic === 'Ref' && node.Ref === 'AWS::NoValue') {
      return NO_VALUE;
    }
    if (intrinsic === 'Fn::If') {
      const [conditionName, whenTrue, whenFalse] = node['Fn::If'];
      const truth = await condition(conditionName);
      if (truth === undefined) {
        unresolved.push({ path, intrinsic, reason: `condition '${conditionName}' could not be evaluated` });
        return node;
      }
      return evaluate(truth ? whenTrue : whenFalse, `${path}.Fn::If.${truth ? 1 : 2}`);
    }

    try {
      return await evaluateOnce(node);
    } catch (e) {
      const before = unresolved.length;
      const args = await evaluate(node[intrinsic], `${path}.${intrinsic}`);
      const unsupported = formatErrorMessage(e).includes(`function ${intrinsic} is not supported`);
      if (!unsupported && unresolved.length === before && !containsExpression(args)) {
        // The arguments contained expressions only this function evaluates (Fn::If, AWS::NoValue): retry with their values
        try {
          return await evaluateOnce({ [intrinsic]: args });
        } catch (retryError) {
          unresolved.push({ path, intrinsic, reason: formatErrorMessage(retryError) });
          return { [intrinsic]: args };
        }
      }
      if (unsupported || unresolved.length === before) {
        unresolved.push({ path, intrinsic, reason: formatErrorMessage(e) });
      }
      return { [intrinsic]: args };
    }
  }

  async function evaluateSection(section: { [logicalId: string]: any }, name: string) {
    const out: { [logicalId: string]: any } = {};
    for (const [logicalId, element] of Object.entries(section)) {
      if (typeof element?.Condition === 'string' && (await condition(element.Condition)) === false) {
        continue; // not created by CloudFormation
      }
      out[logicalId] = await evaluate(element, `${name}.${logicalId}`);
    }
    return out;
  }

  const evaluated: Template = { ...template };
  for (const section of ['Resources', 'Outputs']) {
    if (template[section]) {
      evaluated[section] = await evaluateSection(template[section], section);
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

function containsExpression(value: any): boolean {
  if (Array.isArray(value)) {
    return value.some(containsExpression);
  }
  if (value !== null && typeof value === 'object') {
    return intrinsicName(value) !== undefined || Object.values(value).some(containsExpression);
  }
  return false;
}
