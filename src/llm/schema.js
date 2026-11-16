// Validates LLM output against the JSON Schema the request asked for. Structured outputs make
// malformed responses rare, but a response is still untrusted input: it is checked before any
// field is used, and anything that does not conform is discarded (the caller falls back).
// Supports the subset our schemas use: type, properties, required, additionalProperties: false,
// items, enum, minimum/maximum, minLength/maxLength, minItems/maxItems.

const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/** Returns a list of problems (empty when `value` conforms to `schema`). */
export function validateSchema(value, schema, path = '$', problems = []) {
  if (!schema || typeof schema !== 'object') return problems;
  const actual = typeOf(value);
  const expected = schema.type;
  if (expected) {
    const ok = expected === actual || (expected === 'number' && actual === 'integer');
    if (!ok) {
      problems.push(`${path}: expected ${expected}, got ${actual}`);
      return problems;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: not one of the allowed values`);
  if (actual === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) problems.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) problems.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (actual === 'number' || actual === 'integer') {
    if (schema.minimum !== undefined && value < schema.minimum) problems.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) problems.push(`${path}: above ${schema.maximum}`);
  }
  if (actual === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) problems.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) problems.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((item, i) => validateSchema(item, schema.items, `${path}[${i}]`, problems));
  }
  if (actual === 'object') {
    const props = schema.properties ?? {};
    for (const key of schema.required ?? []) if (!(key in value)) problems.push(`${path}.${key}: missing`);
    for (const [key, v] of Object.entries(value)) {
      if (props[key]) validateSchema(v, props[key], `${path}.${key}`, problems);
      else if (schema.additionalProperties === false) problems.push(`${path}.${key}: not allowed`);
    }
  }
  return problems;
}
