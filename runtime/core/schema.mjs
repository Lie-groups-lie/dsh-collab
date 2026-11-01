// Small strict validator for the JSON Schema subset used by our tool contracts.
// Unsupported keywords are not advertised. This is not a general JSON Schema engine.
export function validateInput(value, schema, at = 'arguments') {
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at} must be an object`);
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) throw new Error(`${at}.${key} is required`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) {
        if (schema.additionalProperties === false) throw new Error(`${at}.${key} is unknown`);
      } else validateInput(item, schema.properties[key], `${at}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${at} must be an array`);
    if (schema.minItems !== undefined && value.length < schema.minItems || schema.maxItems !== undefined && value.length > schema.maxItems) throw new Error(`${at} has invalid length`);
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) throw new Error(`${at} must contain unique values`);
    value.forEach((item, i) => validateInput(item, schema.items, `${at}[${i}]`));
  } else {
    if (schema.type === 'integer' ? !Number.isSafeInteger(value) : schema.type && typeof value !== schema.type) throw new Error(`${at} must be ${schema.type}`);
    if (schema.minimum !== undefined && value < schema.minimum || schema.maximum !== undefined && value > schema.maximum) throw new Error(`${at} is out of range`);
    if (typeof value === 'string' && (schema.minLength !== undefined && value.length < schema.minLength || schema.maxLength !== undefined && value.length > schema.maxLength || schema.pattern && !new RegExp(schema.pattern).test(value))) throw new Error(`${at} has invalid format`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw new Error(`${at} is not an allowed value`);
}
