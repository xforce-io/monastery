// tests/preflight.test.ts
import { expect, test } from "vitest";
import { checkPreflight, formatPreflightErrors, type Probe } from "../src/cli/preflight.js";

// A fake probe: maps a command's first token (+ subcommand) to ok/not-ok, so tests never spawn.
function fakeProbe(present: Record<string, boolean>): Probe {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    // exact-key match first, then bare-command match
    if (key in present) return present[key];
    if (cmd in present) return present[cmd];
    return false;
  };
}

test("all good: gh present+authed and claude present → ok, no errors", async () => {
  const probe = fakeProbe({ "gh --version": true, "gh auth status": true, "claude --version": true });
  const r = await checkPreflight(probe, { gh: true, claude: true });
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
});

test("gh missing → actionable error, not an execa stack", async () => {
  const probe = fakeProbe({ "gh --version": false, "claude --version": true });
  const r = await checkPreflight(probe, { gh: true, claude: true });
  expect(r.ok).toBe(false);
  expect(r.errors.join("\n")).toMatch(/gh/);
  expect(r.errors.join("\n")).toMatch(/install|PATH/i);
});

test("gh present but not authed → distinct login hint", async () => {
  const probe = fakeProbe({ "gh --version": true, "gh auth status": false, "claude --version": true });
  const r = await checkPreflight(probe, { gh: true, claude: true });
  expect(r.ok).toBe(false);
  expect(r.errors.join("\n")).toMatch(/gh auth login/);
});

test("claude missing → actionable error", async () => {
  const probe = fakeProbe({ "gh --version": true, "gh auth status": true, "claude --version": false });
  const r = await checkPreflight(probe, { gh: true, claude: true });
  expect(r.ok).toBe(false);
  expect(r.errors.join("\n")).toMatch(/claude/);
});

test("need.claude=false skips the claude probe (e.g. `status` only needs gh)", async () => {
  const probe = fakeProbe({ "gh --version": true, "gh auth status": true /* claude absent */ });
  const r = await checkPreflight(probe, { gh: true, claude: false });
  expect(r.ok).toBe(true);
});

test("formatPreflightErrors prefixes each line so it reads as guidance, not a crash", () => {
  const lines = formatPreflightErrors(["thing A", "thing B"]);
  expect(lines).toContain("thing A");
  expect(lines).toMatch(/monastery/); // branded, human-readable preamble
});
