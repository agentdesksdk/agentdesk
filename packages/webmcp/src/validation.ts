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

  // JSON Schema `required` is about presence. An empty string is present;
  // rejecting it is `minLength`'s job.
  for (const key of asStringArray(schema.required)) {
    if (!(key in input) || input[key] === undefined) {
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
  const allowed = asStringArray(
    typeof expected === "string" ? [expected] : expected,
  );

  if (allowed.length > 0 && !allowed.some((t) => matchesType(value, t))) {
    return [
      {
        path,
        message: `${path} must be ${allowed.join(" or ")}, received ${describe(value)}`,
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

  if (
    allowed.includes("object") &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const nested = value as Record<string, unknown>;
    const nestedProps = (property.properties ?? {}) as Record<
      string,
      PropertySchema
    >;
    for (const key of asStringArray(property.required)) {
      const child = nested[key];
      if (child === undefined || child === null || child === "") {
        issues.push({ path: `${path}.${key}`, message: `${path}.${key} is required` });
      }
    }
    for (const [key, child] of Object.entries(nested)) {
      const childSchema = nestedProps[key];
      if (childSchema && child !== undefined && child !== null) {
        issues.push(...checkValue(`${path}.${key}`, child, childSchema));
      }
    }
  }

  return issues;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * Keywords the bundled validator does not enforce. Call this in a test or
 * at startup to find schemas that look validated but are not, then either
 * simplify the schema or pass a full validator via the `validate` option.
 */
const SUPPORTED = new Set([
  "type",
  "description",
  "properties",
  "required",
  "enum",
  "items",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
  "title",
  "default",
  "examples",
]);

/**
 * A keyword is only "supported" when its value has a shape the validator
 * can act on. `enum: "x"` or tuple-form `items: [...]` are silently inert,
 * so they are reported alongside genuinely unknown keywords.
 */
function shapeIsEnforceable(key: string, value: unknown): boolean {
  switch (key) {
    case "type":
      return (
        typeof value === "string" ||
        (Array.isArray(value) && value.every((v) => typeof v === "string"))
      );
    case "enum":
      return Array.isArray(value);
    case "required":
      return Array.isArray(value) && value.every((v) => typeof v === "string");
    case "items":
    case "properties":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "minimum":
    case "maximum":
    case "minLength":
    case "maxLength":
      return typeof value === "number";
    case "pattern":
      return typeof value === "string";
    default:
      return true;
  }
}

export function unsupportedSchemaKeywords(schema: InputSchema): string[] {
  const found = new Set<string>();
  const walk = (node: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(node)) {
      if (!SUPPORTED.has(key) || !shapeIsEnforceable(key, value)) {
        found.add(key);
        continue;
      }
      if (key === "properties" && value && typeof value === "object") {
        for (const child of Object.values(value as Record<string, unknown>)) {
          if (child && typeof child === "object") {
            walk(child as Record<string, unknown>);
          }
        }
      }
      if (
        key === "items" &&
        value &&
        typeof value === "object" &&
        !Array.isArray(value)
      ) {
        walk(value as Record<string, unknown>);
      }
    }
  };
  walk(schema as unknown as Record<string, unknown>);
  return [...found].sort();
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
