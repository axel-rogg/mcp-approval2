/**
 * Minimaler Zod → JSON-Schema Konverter.
 *
 * Plan-Ref: PLAN-architecture-v1.md §11 Phase 4 (MCP-Protocol).
 *
 * Wir vermeiden die `zod-to-json-schema`-Dependency, weil:
 *   1. der Tool-Schema-Bedarf in Phase 4 sehr begrenzt ist (object, primitives,
 *      enums, arrays, optionals)
 *   2. wir Kontrolle ueber die `description`-Propagation behalten wollen
 *   3. ein extra-Package fuer ~50 Tools nicht lohnt
 *
 * Unterstuetzt:
 *   ZodObject, ZodString, ZodNumber, ZodBoolean, ZodLiteral, ZodEnum,
 *   ZodNativeEnum, ZodArray, ZodOptional, ZodNullable, ZodDefault,
 *   ZodUnion (best-effort), ZodRecord (best-effort), ZodAny, ZodUnknown.
 *
 * Wenn ein Tool kompliziertere Schemas braucht (z.B. Discriminated Unions
 * mit shared properties), bringen wir `zod-to-json-schema` ins package.json.
 */
import { z, type ZodTypeAny } from 'zod';
import type { JsonSchema } from './types.js';

interface MutableJsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  description?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  nullable?: boolean;
  title?: string;
}

export function zodToJsonSchema(schema: ZodTypeAny): JsonSchema {
  return convert(schema);
}

function convert(schema: ZodTypeAny): JsonSchema {
  // Optional → wrap inner; required-flag handled by parent (ZodObject)
  if (schema instanceof z.ZodOptional) {
    return convert(schema.unwrap() as ZodTypeAny);
  }
  if (schema instanceof z.ZodDefault) {
    const inner = convert(schema._def.innerType as ZodTypeAny);
    return { ...inner, default: schema._def.defaultValue() };
  }
  if (schema instanceof z.ZodNullable) {
    const inner = convert(schema.unwrap() as ZodTypeAny);
    // JSON-Schema: 'null'-Union
    const types = Array.isArray(inner.type)
      ? [...inner.type, 'null']
      : inner.type
        ? [inner.type, 'null']
        : undefined;
    const out: MutableJsonSchema = { ...inner, nullable: true };
    if (types) out.type = types;
    return out;
  }

  if (schema instanceof z.ZodObject) {
    const shape = (schema as z.AnyZodObject).shape as Record<string, ZodTypeAny>;
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    for (const [key, val] of Object.entries(shape)) {
      properties[key] = convert(val);
      // optional/default → nicht in required
      if (!isOptionalLike(val)) {
        required.push(key);
      }
    }
    const out: MutableJsonSchema = {
      type: 'object',
      properties,
      additionalProperties: false,
    };
    if (required.length > 0) out.required = required;
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodString) {
    const out: MutableJsonSchema = { type: 'string' };
    const checks = (schema._def as { checks?: Array<Record<string, unknown>> }).checks;
    if (checks) {
      for (const c of checks) {
        if (c['kind'] === 'min' && typeof c['value'] === 'number') out.minLength = c['value'];
        if (c['kind'] === 'max' && typeof c['value'] === 'number') out.maxLength = c['value'];
        if (c['kind'] === 'regex' && c['regex'] instanceof RegExp) out.pattern = (c['regex'] as RegExp).source;
        if (c['kind'] === 'email') out.format = 'email';
        if (c['kind'] === 'uuid') out.format = 'uuid';
        if (c['kind'] === 'url') out.format = 'uri';
        if (c['kind'] === 'datetime') out.format = 'date-time';
      }
    }
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodNumber) {
    const out: MutableJsonSchema = { type: 'number' };
    const checks = (schema._def as { checks?: Array<Record<string, unknown>> }).checks;
    if (checks) {
      for (const c of checks) {
        if (c['kind'] === 'min' && typeof c['value'] === 'number') out.minimum = c['value'];
        if (c['kind'] === 'max' && typeof c['value'] === 'number') out.maximum = c['value'];
        if (c['kind'] === 'int') out.type = 'integer';
      }
    }
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodBoolean) {
    const out: MutableJsonSchema = { type: 'boolean' };
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodLiteral) {
    const value = (schema._def as { value: unknown }).value;
    const out: MutableJsonSchema = { const: value };
    if (typeof value === 'string') out.type = 'string';
    else if (typeof value === 'number') out.type = 'number';
    else if (typeof value === 'boolean') out.type = 'boolean';
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodEnum) {
    const values = (schema._def as { values: readonly string[] }).values;
    const out: MutableJsonSchema = { type: 'string', enum: [...values] };
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodNativeEnum) {
    const enumObj = (schema._def as { values: Record<string, string | number> }).values;
    const values = Object.values(enumObj).filter(
      (v): v is string | number => typeof v === 'string' || typeof v === 'number',
    );
    const typeSet = new Set<string>(values.map((v) => (typeof v === 'number' ? 'number' : 'string')));
    const types = Array.from(typeSet);
    const out: MutableJsonSchema = { enum: values };
    if (types.length === 1) {
      out.type = types[0]!;
    } else if (types.length > 1) {
      out.type = types;
    }
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodArray) {
    const item = (schema._def as { type: ZodTypeAny }).type;
    const out: MutableJsonSchema = {
      type: 'array',
      items: convert(item),
    };
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodUnion) {
    const options = (schema._def as { options: ZodTypeAny[] }).options;
    const out: MutableJsonSchema = {
      anyOf: options.map((o) => convert(o)),
    };
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodRecord) {
    const valueType = (schema._def as { valueType: ZodTypeAny }).valueType;
    const out: MutableJsonSchema = {
      type: 'object',
      additionalProperties: convert(valueType),
    };
    const desc = getDescription(schema);
    if (desc) out.description = desc;
    return out;
  }

  if (schema instanceof z.ZodAny || schema instanceof z.ZodUnknown) {
    return {};
  }

  // Fallback: leeres Schema. Caller bekommt keine Validation-Hilfe, aber
  // tools/list bricht nicht.
  return {};
}

function isOptionalLike(schema: ZodTypeAny): boolean {
  return schema instanceof z.ZodOptional || schema instanceof z.ZodDefault;
}

function getDescription(schema: ZodTypeAny): string | undefined {
  const desc = (schema._def as { description?: unknown }).description;
  return typeof desc === 'string' ? desc : undefined;
}
