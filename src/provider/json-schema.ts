import type { ZodTypeAny } from "zod";
import { z } from "zod";
import type { JSONSchema } from "./interface.js";

/** Minimal zod -> JSON Schema bridge for monastery's structured agent contracts. */
export function zodToJsonSchema(schema: ZodTypeAny): JSONSchema {
  return convert(schema);
}

function convert(schema: ZodTypeAny): JSONSchema {
  const def = schema._def as { typeName: string; [key: string]: unknown };
  const description = typeof def.description === "string" ? def.description : undefined;
  const withDescription = (out: JSONSchema): JSONSchema =>
    description && typeof out === "object" ? { ...out, description } : out;

  switch (def.typeName) {
    case z.ZodFirstPartyTypeKind.ZodObject: {
      const shape = typeof def.shape === "function" ? def.shape() as Record<string, ZodTypeAny> : {};
      const properties: Record<string, JSONSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = convert(value);
        if (!isOptionalLike(value)) required.push(key);
      }
      return withDescription({ type: "object", properties, required, additionalProperties: false });
    }
    case z.ZodFirstPartyTypeKind.ZodArray:
      return withDescription({ type: "array", items: convert(def.type as ZodTypeAny) });
    case z.ZodFirstPartyTypeKind.ZodString:
      return withDescription({ type: "string" });
    case z.ZodFirstPartyTypeKind.ZodNumber:
      return withDescription({ type: "number" });
    case z.ZodFirstPartyTypeKind.ZodBoolean:
      return withDescription({ type: "boolean" });
    case z.ZodFirstPartyTypeKind.ZodEnum:
      return withDescription({ type: "string", enum: def.values as unknown[] });
    case z.ZodFirstPartyTypeKind.ZodLiteral:
      return withDescription({ const: def.value });
    case z.ZodFirstPartyTypeKind.ZodOptional:
    case z.ZodFirstPartyTypeKind.ZodNullable:
    case z.ZodFirstPartyTypeKind.ZodDefault:
    case z.ZodFirstPartyTypeKind.ZodEffects:
      return withDescription(convert((def.innerType ?? def.schema) as ZodTypeAny));
    case z.ZodFirstPartyTypeKind.ZodUnion:
      return withDescription({ anyOf: (def.options as ZodTypeAny[]).map(convert) });
    case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
      return withDescription({ oneOf: [...(def.options as Map<string, ZodTypeAny>).values()].map(convert) });
    default:
      return withDescription({});
  }
}

function isOptionalLike(schema: ZodTypeAny): boolean {
  const def = schema._def as { typeName: string; innerType?: ZodTypeAny; schema?: ZodTypeAny };
  if (
    def.typeName === z.ZodFirstPartyTypeKind.ZodOptional ||
    def.typeName === z.ZodFirstPartyTypeKind.ZodDefault
  ) return true;
  if (def.typeName === z.ZodFirstPartyTypeKind.ZodEffects && def.schema) return isOptionalLike(def.schema);
  return false;
}
