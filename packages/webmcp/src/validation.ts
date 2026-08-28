import type { InputSchema } from "./capability.ts";

export type ValidationIssue = {
  path: string;
  message: string;
};

export type ValidationResult =
  | { valid: true; value: Record<string, unknown> }
  | { valid: false; issues: ValidationIssue[] };

/**
 * Validates tool input against a capability's schema.
 *
 * The browser performs no validation of its own: the spec types
 * `inputSchema` as a bare object and hands the raw input straight to the
 * handler. Without this, a wrong-typed argument reaches business logic and
 * fails as an opaque handler error.
 *
 * Supply your own via `createAgentDeskRuntime({ validate })` to use Ajv,
 * Zod, or Standard Schema instead.
 */
export type Validator = (
  schema: InputSchema,
  input: Record<string, unknown>,
) => ValidationResult;

type PropertySchema = Record<string, unknown>;

/**
 * Covers the JSON Schema subset this SDK emits and that tool authors
 * realistically write: object roots with typed, optionally required,
 * scalar or array properties. Unsupported keywords are ignored rather
 * than rejected, so a richer schema still passes rather than failing shut.
 */
export const defaultValidator: Validator = (schema, input) => {
  const issues: ValidationIssue[] = [];
  const properties = schema.properties ?? {};

  for (const key of schema.required ?? []) {
    const value = input[key];
    if (value === undefined || value === null || value === "") {
      issues.push({ path: key, message: `${key} is required` });
    }
  }

  for (const [key, raw] of Object.entries(input)) {
    const property = properties[key];
    if (!property || raw === undefined || raw === null) {
      continue;
    }
    issues.push(...checkValue(key, raw, property));
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }
  return { valid: true, value: input };
};

function checkValue(
  path: string,
  value: unknown,
  property: PropertySchema,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const expected = property.type;

  if (typeof expected === "string" && !matchesType(value, expected)) {
    return [
      {
        path,
        message: `${path} must be a ${expected}, received ${describe(value)}`,
      },
    ];
  }

  if (Array.isArray(property.enum) && !property.enum.includes(value)) {
    issues.push({
      path,
      message: `${path} must be one of ${property.enum.map(String).join(", ")}`,
    });
  }

  if (typeof value === "number") {
    if (typeof property.minimum === "number" && value < property.minimum) {
      issues.push({ path, message: `${path} must be >= ${property.minimum}` });
    }
    if (typeof property.maximum === "number" && value > property.maximum) {
      issues.push({ path, message: `${path} must be <= ${property.maximum}` });
    }
  }

  if (typeof value === "string") {
    if (
      typeof property.minLength === "number" &&
      value.length < property.minLength
    ) {
      issues.push({
        path,
        message: `${path} must be at least ${property.minLength} characters`,
      });
    }
    if (
      typeof property.maxLength === "number" &&
      value.length > property.maxLength
    ) {
      issues.push({
        path,
        message: `${path} must be at most ${property.maxLength} characters`,
      });
    }
    if (typeof property.pattern === "string") {
      let re: RegExp | undefined;
      try {
        re = new RegExp(property.pattern);
      } catch {
        re = undefined;
      }
      if (re && !re.test(value)) {
        issues.push({ path, message: `${path} must match ${property.pattern}` });
      }
    }
  }

  if (Array.isArray(value) && typeof property.items === "object") {
    const items = property.items as PropertySchema;
    value.forEach((entry, index) => {
      issues.push(...checkValue(`${path}[${index}]`, entry, items));
    });
  }

  return issues;
}

function matchesType(value: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "null":
      return value === null;
    default:
      return true;
  }
}

function describe(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}
