// src/github/transient.ts
// GitHub's API has transient bad days — GraphQL/REST return EOF, 5xx, or the
// connection resets mid-flight (#148). A single such blip must not crash a tick
// or get misread as "not authenticated". This module classifies those failures
// and wraps a GhRun with bounded retry + exponential backoff so one hiccup is
// absorbed, and a sustained outage surfaces as a clean, retryable terminal error
// — never a raw ExecaError stack dump.
import type { GhRun } from "./gh-adapter.js";

/** Patterns that mark a `gh` failure as a transient GitHub/network condition (case-insensitive). */
const TRANSIENT_PATTERNS: RegExp[] = [
  /\bEOF\b/i,                                  // GraphQL/REST stream closed early
  /\bHTTP\s*5\d\d\b/i,                         // gh: "HTTP 503: ..."
  /\b(?:502|503|504)\b/,                       // bare bad-gateway/unavailable/timeout codes
  /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|ENETDOWN|EAI_AGAIN|EPIPE)\b/i,
  /\bi\/o timeout\b/i,
  /\btimed?\s*out\b/i,                         // "timed out" / "timeout"
  /\bconnection reset\b/i,
  /\bconnection refused\b/i,
  /\bTLS handshake\b/i,
  /\bdial tcp\b/i,
  /\bnetwork is unreachable\b/i,
  /\btemporary failure in name resolution\b/i,
  /\bservice unavailable\b/i,
];

function errText(err: { stderr?: unknown; stdout?: unknown; shortMessage?: unknown; message?: unknown }): string {
  return [err.stderr, err.stdout, err.shortMessage, err.message]
    .filter((s): s is string => typeof s === "string")
    .join("\n");
}

/**
 * True when `err` looks like a transient GitHub API / network failure that is safe
 * to retry. A missing binary (ENOENT), a 4xx (404/401/403), or any non-error value
 * is NOT transient — those are configuration/permanent and must surface immediately.
 */
export function isTransientGhError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; timedOut?: unknown };
  if (e.code === "ENOENT") return false; // binary not on PATH — permanent, not a blip
  if (e.timedOut === true) return true; // execa killed it on its own timeout
  const text = errText(err as Record<string, unknown>);
  return TRANSIENT_PATTERNS.some((re) => re.test(text));
}

/** A clean, user-level terminal error for a sustained transient outage — carries no raw stack dump. */
export class TransientGitHubError extends Error {
  constructor(message: string, readonly attempts: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransientGitHubError";
  }
}

/**
 * Re-throw `err` if it is a sustained-outage {@link TransientGitHubError}, otherwise do nothing (#148).
 * Use inside a gh read path's catch so a genuine 404/empty still degrades to its fallback, but a
 * sustained API outage surfaces cleanly instead of masquerading as "data absent".
 */
export function rethrowIfTransient(err: unknown): void {
  if (err instanceof TransientGitHubError) throw err;
}

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  /** Injected so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A short, human reason pulled from a transient error for the clean terminal message. */
function reasonOf(err: unknown): string {
  if (err && typeof err === "object") {
    const text = errText(err as Record<string, unknown>).trim();
    const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
    if (firstLine) return firstLine;
  }
  return "GitHub API error";
}

/**
 * Wrap a GhRun with bounded retry + exponential backoff for transient failures only.
 * Non-transient errors are rethrown untouched on the first attempt. When all attempts
 * fail transiently, throws a {@link TransientGitHubError} (never the raw ExecaError).
 */
export function withGhRetry(run: GhRun, opts: RetryOptions = {}): GhRun {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseMs = opts.baseMs ?? 300;
  const sleep = opts.sleep ?? realSleep;
  return async (args, input) => {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await run(args, input);
      } catch (err) {
        if (!isTransientGhError(err)) throw err; // permanent — surface immediately
        lastErr = err;
        if (attempt < maxAttempts) await sleep(baseMs * 2 ** (attempt - 1));
      }
    }
    throw new TransientGitHubError(
      `GitHub API temporarily unavailable after ${maxAttempts} attempts: ${reasonOf(lastErr)}. Please retry.`,
      maxAttempts,
      { cause: lastErr },
    );
  };
}
