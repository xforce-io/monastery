// tests/preflight.test.ts
import { expect, test } from "vitest";
import { checkPreflight, formatPreflightErrors, type Probe } from "../src/cli/preflight.js";

// A fake probe: maps a command's first token (+ subcommand) to ok/not-ok, so tests never spawn.
// `transientKeys` marks failures that look like a transient GitHub/network blip (#148).
function fakeProbe(present: Record<string, boolean>, transientKeys: string[] = []): Probe {
  return async (cmd, args) => {
    const key = [cmd, ...args].join(" ");
    const ok = key in present ? present[key] : cmd in present ? present[cmd] : false;
    return { ok, transient: !ok && transientKeys.includes(key) };
  };
}

test("all good: gh present+authed and claude present → ok, no errors", async () => {
  const probe = fakeProbe({ "gh --version": true, "gh auth status": true, "claude --version": true });
  const r = await checkPreflight(probe, { gh: true, agent: true });
  expect(r.ok).toBe(true);
  expect(r.errors).toEqual([]);
});

test("gh missing → actionable error, not an execa stack", async () => {
  const probe = fakeProbe({ "gh --version": false, "claude --version": true });
  const r = await checkPreflight(probe, { gh: true, agent: true });
  expect(r.ok).toBe(false);
  expect(r.errors.join("\n")).toMatch(/gh/);
  expect(r.errors.join("\n")).toMatch(/install|PATH/i);
});

test("gh present but not authed → distinct login hint", async () => {
  const probe = fakeProbe({ "gh --version": true, "gh auth status": false, "claude --version": true });
  const r = await checkPreflight(probe, { gh: true, agent: true });
  expect(r.ok).toBe(false);
  expect(r.errors.join("\n")).toMatch(/gh auth login/);
});

test("transient API blip on auth probe → 'temporarily unavailable', NOT a misleading 'not authenticated' (#148)", async () => {
  const probe = fakeProbe(
    { "gh --version": true, "gh auth status": false, "claude --version": true },
    ["gh auth status"], // the auth probe failed because the GitHub API EOF'd, not because login is missing
  );
  const r = await checkPreflight(probe, { gh: true, agent: true });
  expect(r.ok).toBe(false);
  const msg = r.errors.join("\n");
  expect(msg).toMatch(/temporarily unavailable|retry/i);
  expect(msg).not.toMatch(/gh auth login/); // must not send the user to fix auth that is fine
});

test("agent provider passes when claude is missing but codex is present", async () => {
  const probe = fakeProbe({ "gh --version": true, "gh auth status": true, "claude --version": false, "codex --version": true });
  const r = await checkPreflight(probe, { gh: true, agent: true });
  expect(r.ok).toBe(true);
});

test("all agent providers missing → actionable error", async () => {
  const probe = fakeProbe({ "gh --version": true, "gh auth status": true, "claude --version": false, "codex --version": false });
  const r = await checkPreflight(probe, { gh: true, agent: true });
  expect(r.ok).toBe(false);
  expect(r.errors.join("\n")).toMatch(/agent provider/);
  expect(r.errors.join("\n")).toMatch(/claude/);
  expect(r.errors.join("\n")).toMatch(/codex/);
});

test("need.agent=false skips the agent probe (e.g. `status` only needs gh)", async () => {
  const probe = fakeProbe({ "gh --version": true, "gh auth status": true /* claude absent */ });
  const r = await checkPreflight(probe, { gh: true, agent: false });
  expect(r.ok).toBe(true);
});

test("formatPreflightErrors prefixes each line so it reads as guidance, not a crash", () => {
  const lines = formatPreflightErrors(["thing A", "thing B"]);
  expect(lines).toContain("thing A");
  expect(lines).toMatch(/monastery/); // branded, human-readable preamble
});
