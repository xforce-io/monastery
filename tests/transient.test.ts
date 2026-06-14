import { describe, it, expect, vi } from "vitest";
import { isTransientGhError, rethrowIfTransient, TransientGitHubError, withGhRetry } from "../src/github/transient.js";

// A minimal ExecaError-shaped object — the classifier only inspects these string/flag fields.
function ghErr(fields: { stderr?: string; message?: string; shortMessage?: string; timedOut?: boolean; code?: string }): Error {
  return Object.assign(new Error(fields.message ?? "Command failed"), fields);
}

describe("isTransientGhError", () => {
  it("treats a GraphQL/REST EOF as transient", () => {
    expect(isTransientGhError(ghErr({ stderr: 'Post "https://api.github.com/repos/o/r/labels": EOF' }))).toBe(true);
  });
  it("treats HTTP 5xx as transient", () => {
    expect(isTransientGhError(ghErr({ stderr: "HTTP 503: Service Unavailable" }))).toBe(true);
    expect(isTransientGhError(ghErr({ stderr: "gh: 502 Bad Gateway" }))).toBe(true);
  });
  it("treats timeouts as transient (text or timedOut flag)", () => {
    expect(isTransientGhError(ghErr({ stderr: "dial tcp: i/o timeout" }))).toBe(true);
    expect(isTransientGhError(ghErr({ message: "Command timed out", timedOut: true }))).toBe(true);
  });
  it("treats network errors as transient", () => {
    expect(isTransientGhError(ghErr({ stderr: "read: connection reset by peer (ECONNRESET)" }))).toBe(true);
    expect(isTransientGhError(ghErr({ stderr: "dial tcp: lookup api.github.com: EAI_AGAIN" }))).toBe(true);
    expect(isTransientGhError(ghErr({ stderr: "TLS handshake timeout" }))).toBe(true);
  });
  it("does NOT treat a genuine 404 / not-found as transient", () => {
    expect(isTransientGhError(ghErr({ stderr: "HTTP 404: Not Found" }))).toBe(false);
  });
  it("does NOT treat a missing binary (ENOENT) as transient", () => {
    expect(isTransientGhError(ghErr({ message: "spawn gh ENOENT", code: "ENOENT" }))).toBe(false);
  });
  it("does NOT treat a real auth failure as transient", () => {
    expect(isTransientGhError(ghErr({ stderr: "HTTP 401: Bad credentials" }))).toBe(false);
  });
  it("is false for non-error inputs", () => {
    expect(isTransientGhError(null)).toBe(false);
    expect(isTransientGhError(undefined)).toBe(false);
    expect(isTransientGhError("EOF")).toBe(false);
  });
});

describe("rethrowIfTransient", () => {
  it("re-throws a TransientGitHubError so a sustained outage surfaces instead of being swallowed", () => {
    const e = new TransientGitHubError("down", 4);
    expect(() => rethrowIfTransient(e)).toThrow(e);
  });
  it("does nothing for a non-transient error — the caller degrades to its fallback (404/empty)", () => {
    expect(() => rethrowIfTransient(new Error("HTTP 404"))).not.toThrow();
    expect(() => rethrowIfTransient("anything")).not.toThrow();
    expect(() => rethrowIfTransient(undefined)).not.toThrow();
  });
});

describe("withGhRetry", () => {
  it("retries transient failures then returns the eventual success", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    let attempts = 0;
    const run = async (_args: string[]) => {
      attempts++;
      if (attempts < 3) throw ghErr({ stderr: "EOF" });
      return "ok";
    };
    const wrapped = withGhRetry(run, { maxAttempts: 4, baseMs: 300, sleep });

    const out = await wrapped(["label", "create"]);

    expect(out).toBe("ok");
    expect(attempts).toBe(3);
    // exponential backoff: two sleeps before the 3rd (successful) attempt
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([300, 600]);
  });

  it("passes args and input through to the underlying run", async () => {
    const seen: Array<{ args: string[]; input?: string }> = [];
    const run = async (args: string[], input?: string) => {
      seen.push({ args, input });
      return "done";
    };
    const wrapped = withGhRetry(run, { sleep: async () => {} });
    await wrapped(["issue", "comment"], "hello");
    expect(seen).toEqual([{ args: ["issue", "comment"], input: "hello" }]);
  });

  it("throws a clean TransientGitHubError (not the raw ExecaError) when retries are exhausted", async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const run = async () => {
      attempts++;
      throw ghErr({ stderr: 'Post "https://api.github.com/...": EOF' });
    };
    const wrapped = withGhRetry(run, { maxAttempts: 3, baseMs: 10, sleep });

    await expect(wrapped(["label", "create"])).rejects.toBeInstanceOf(TransientGitHubError);
    expect(attempts).toBe(3); // maxAttempts tries
    expect(sleep).toHaveBeenCalledTimes(2); // one sleep between each of the 3 attempts
    // The clean error must not leak the raw execa dump as its own message.
    await expect(wrapped(["label", "create"])).rejects.toThrow(/temporarily unavailable/i);
  });

  it("rethrows a non-transient error immediately without retrying or sleeping", async () => {
    const sleep = vi.fn(async () => {});
    let attempts = 0;
    const run = async () => {
      attempts++;
      throw ghErr({ message: "HTTP 404: Not Found", stderr: "HTTP 404: Not Found" });
    };
    const wrapped = withGhRetry(run, { maxAttempts: 4, baseMs: 10, sleep });

    await expect(wrapped(["issue", "view"])).rejects.toThrow(/404/);
    await expect(wrapped(["issue", "view"])).rejects.not.toBeInstanceOf(TransientGitHubError);
    expect(attempts).toBe(2); // one per call above, never retried within a call
    expect(sleep).not.toHaveBeenCalled();
  });
});
