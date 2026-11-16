import { badRequest } from './errors.js';
import { isPlainObject } from './util.js';

/**
 * Minimal schema validator. A schema maps field -> rule:
 *   { type: 'string'|'number'|'boolean'|'array'|'object', required, min, max, enum, pattern, items, fields }
 * Unknown fields are rejected so typos surface instead of being silently ignored.
 */
export function validate(body, schema, { partial = false } = {}) {
  if (!isPlainObject(body)) throw badRequest('Request body must be a JSON object');
  const problems = [];
  const out = checkObject(body, schema, '', problems, partial);
  if (problems.length) throw badRequest('Validation failed', problems);
  return out;
}

function checkObject(obj, schema, prefix, problems, partial) {
  const out = {};
  for (const [key, rule] of Object.entries(schema)) {
    const path = prefix + key;
    const value = obj[key];
    if (value === undefined || value === null) {
      if (rule.required && !partial) problems.push(`${path} is required`);
      continue;
    }
    const checked = checkValue(value, rule, path, problems);
    if (checked !== undefined) out[key] = checked;
  }
  for (const key of Object.keys(obj)) {
    if (!(key in schema)) problems.push(`unknown field: ${prefix}${key}`);
  }
  return out;
}

function checkValue(value, rule, path, problems) {
  const fail = (msg) => {
    problems.push(`${path} ${msg}`);
    return undefined;
  };
  switch (rule.type) {
    case 'string': {
      if (typeof value !== 'string') return fail('must be a string');
      const v = value.trim();
      if (rule.min && v.length < rule.min) return fail(`must be at least ${rule.min} characters`);
      if (rule.max && v.length > rule.max) return fail(`must be at most ${rule.max} characters`);
      if (rule.enum && !rule.enum.includes(v)) return fail(`must be one of: ${rule.enum.join(', ')}`);
      if (rule.pattern && !rule.pattern.test(v)) return fail('has an invalid format');
      return v;
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('must be a number');
      if (rule.min !== undefined && value < rule.min) return fail(`must be >= ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) return fail(`must be <= ${rule.max}`);
      return value;
    }
    case 'boolean':
      return typeof value === 'boolean' ? value : fail('must be a boolean');
    case 'array': {
      if (!Array.isArray(value)) return fail('must be an array');
      if (rule.min && value.length < rule.min) return fail(`must have at least ${rule.min} item(s)`);
      if (rule.max && value.length > rule.max) return fail(`must have at most ${rule.max} items`);
      const items = [];
      for (const [i, item] of value.entries()) {
        const before = problems.length;
        const checked = checkValue(item, rule.items, `${path}[${i}]`, problems);
        if (problems.length === before) items.push(checked);
      }
      return items;
    }
    case 'object':
      if (!isPlainObject(value)) return fail('must be an object');
      return checkObject(value, rule.fields ?? {}, `${path}.`, problems, false);
    default:
      throw new Error(`unknown rule type ${rule.type}`);
  }
}
