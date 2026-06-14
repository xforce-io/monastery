// #155: docs/PROTOCOL.md must carry a「机器消息信封」section that stays consistent with the
// src/shell/messages.ts implementation — a drift guard, expectations derived from the impl constants.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { STATE_STATUSES, GATED_KINDS } from "../src/shell/messages.js";

const protocol = readFileSync(fileURLToPath(new URL("../docs/PROTOCOL.md", import.meta.url)), "utf8");

test("#155 PROTOCOL has a machine-message envelope section cross-linked to the implementation", () => {
  expect(protocol).toContain("机器消息信封");
  expect(protocol).toContain("src/shell/messages.ts"); // cross-link to the single implementation
});

test("#155 envelope section documents the v1 wire fields", () => {
  // the fields renderStateMessage actually serializes — the doc is the human-readable contract
  for (const field of ["v", "kind", "status", "action", "spec", "agent", "model", "provider", "correlationId", "run", "attempt"]) {
    expect(protocol, `envelope doc should name the \`${field}\` field`).toContain(field);
  }
});

test("#155 envelope status closed set matches STATE_STATUSES (no drift)", () => {
  for (const status of STATE_STATUSES) {
    expect(protocol, `envelope doc should list status \`${status}\``).toContain(status);
  }
});

test("#155 envelope gated-action set matches GATED_KINDS (no drift)", () => {
  for (const kind of GATED_KINDS) {
    expect(protocol, `envelope doc should list gated action \`${kind}\``).toContain(kind);
  }
});
