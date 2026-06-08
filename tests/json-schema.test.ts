import { expect, test } from "vitest";
import { maintainerSpec } from "../src/agents/maintainer.js";
import { reviewerSpec } from "../src/agents/reviewer.js";
import { zodToJsonSchema } from "../src/provider/json-schema.js";

test("converts reviewer schema to an object JSON schema", () => {
  const schema = zodToJsonSchema(reviewerSpec.schema);
  expect(schema).toMatchObject({
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            severity: { type: "string", enum: ["blocking", "advisory"] },
            title: { type: "string" },
            detail: { type: "string" },
          },
        },
      },
    },
    required: ["findings"],
  });
});

test("converts maintainer action union without throwing", () => {
  const schema = zodToJsonSchema(maintainerSpec.schema);
  expect(schema).toMatchObject({
    anyOf: [
      {
        type: "object",
        properties: {
          actions: {
            type: "array",
            items: { oneOf: expect.any(Array) },
          },
        },
      },
      {
        type: "array",
        items: { oneOf: expect.any(Array) },
      },
    ],
  });
});
