import { describe, it, expect, vi, beforeEach } from "vitest";

// The production GhAdapter (constructed with no args) must run gh through the
// transient-retry wrapper (#148): a single EOF blip is absorbed, and a sustained
// outage surfaces as a clean TransientGitHubError — never the raw ExecaError.
const execaMock = vi.fn();
vi.mock("execa", () => ({ execa: (...args: unknown[]) => execaMock(...args) }));

import { GhAdapter } from "../src/github/gh-adapter.js";

beforeEach(() => execaMock.mockReset());

describe("GhAdapter default run resilience (#148)", () => {
  it("retries a transient EOF and then succeeds", async () => {
    execaMock
      .mockRejectedValueOnce(Object.assign(new Error("Command failed"), { stderr: "EOF" }))
      .mockResolvedValueOnce({ stdout: "" });

    const gh = new GhAdapter(); // default run — the production path
    await expect(gh.ensureLabel("o/r", "type:bug", "D73A4A", "broken")).resolves.toBeUndefined();
    expect(execaMock).toHaveBeenCalledTimes(2);
  }, 10_000);

  // The wiring above proves the production default run goes through withGhRetry.
  // The exhaustion → clean TransientGitHubError behavior is covered directly in
  // tests/transient.test.ts (re-asserting it here would mean a multi-second real-
  // timer backoff that also trips a vitest unhandled-rejection false-positive).
});
