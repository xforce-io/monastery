// tests/issue-step.test.ts
import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGitHub } from "../src/github/fake.js";
import { FakeProvider } from "../src/provider/fake.js";
import { issueStep } from "../src/engine/issue-step.js";

const fakeFails = () => {
  const m = new Map<string, number>();
  return {
    recordFail: (r: string, n: number) => { const k = `${r}#${n}`; const v = (m.get(k) ?? 0) + 1; m.set(k, v); return v; },
    failCount: (r: string, n: number) => m.get(`${r}#${n}`) ?? 0,
    clearFail: (r: string, n: number) => { m.delete(`${r}#${n}`); },
  };
};
const ctx = (gh: FakeGitHub, provider: FakeProvider) => ({
  repo: "o/r", gh, provider, model: "haiku",
  artifactRoot: mkdtempSync(join(tmpdir(), "monastery-step-")),
  fails: fakeFails(),
});

test("virtual new + thesis:out -> needs-approval, panel draft", async () => {
  const gh = new FakeGitHub({ thesis: "AI maintainer only", issues: [{ number: 1, title: "chat", body: "social chat", labels: [], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"social chat is off-thesis"}' });
  const c = ctx(gh, provider);
  const out = await issueStep(c, 1);
  expect(out).toEqual({ kind: "progressed" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:out");
  expect(i.labels).toContain("monastery/state:needs-approval"); // out skips triaged -> straight to needs-approval
  expect(i.labels).toContain("monastery:needs-approval");
  expect(gh.panels[1]).toContain("off-thesis"); // draft reason rendered as a `> ` line in panel
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("virtual new + thesis:in -> triaged parked (no proposal, no approval)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 2, title: "bug", body: "x", labels: [], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"within scope"}' });
  const c = ctx(gh, provider);
  await issueStep(c, 2);
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:in");
  expect(i.labels).toContain("monastery/state:triaged");
  expect(i.labels).not.toContain("monastery:needs-approval");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("needs-approval without approved -> waiting:human (idempotent, gate NOT re-run)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 3, title: "x", body: "y", labels: ["monastery/state:needs-approval", "thesis:out", "monastery:needs-approval"], state: "open" }] });
  const provider = new FakeProvider({}); // must NOT be called
  const c = ctx(gh, provider);
  const out = await issueStep(c, 3);
  expect(out).toEqual({ kind: "waiting", on: "human" });
  expect(provider.calls.length).toBe(0);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("approved -> post reason + close + state:done", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 4, title: "x", body: "y", labels: ["monastery/state:needs-approval", "thesis:out", "monastery:approved"], state: "open" }] });
  await gh.upsertPanel("o/r", 4, "<!--monastery-state\nprotocol: gate\n-->\n**待审提议**\n\n> thanks, but out of scope");
  const c = ctx(gh, new FakeProvider({}));
  const out = await issueStep(c, 4);
  expect(out).toEqual({ kind: "done" });
  expect(gh.closed).toContain(4);
  expect(gh.comments[4]?.join("\n")).toContain("out of scope");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("multi-line out reason round-trips: every line quoted, full reason posted on approval", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 9, title: "x", body: "y", labels: [], state: "open" }] });
  const provider = new FakeProvider({ "verdict.json": '{"verdict":"out","reason":"line one.\\nline two."}' });
  const c = ctx(gh, provider);
  await issueStep(c, 9);                 // virtual new -> needs-approval, panel draft
  expect(gh.panels[9]).toContain("> line one.");
  expect(gh.panels[9]).toContain("> line two.");
  await gh.addLabel("o/r", 9, "monastery:approved"); // human approves
  const out = await issueStep(c, 9);     // needs-approval + approved -> close
  expect(out).toEqual({ kind: "done" });
  const posted = gh.comments[9]?.join("\n") ?? "";
  expect(posted).toContain("line one.");
  expect(posted).toContain("line two.");
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("transient gate failure: first skips are local — no GitHub write, issue stays virtual-new", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 10, title: "x", body: "y", labels: [], state: "open" }] });
  const c = ctx(gh, new FakeProvider({})); // null verdict (no file, no resultText)
  const out = await issueStep(c, 10);
  expect(out).toEqual({ kind: "noop" });
  expect(gh.panels[10]).toBeUndefined();
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toEqual([]);
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("persistent gate failure escalates to a panel note after threshold (3)", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 11, title: "x", body: "y", labels: [], state: "open" }] });
  const c = ctx(gh, new FakeProvider({}));
  await issueStep(c, 11);
  await issueStep(c, 11);
  expect(gh.panels[11]).toBeUndefined(); // silent at 2
  await issueStep(c, 11);
  expect(gh.panels[11]).toContain("needs a human"); // escalated at 3
  rmSync(c.artifactRoot, { recursive: true, force: true });
});

test("success after failures resets counter and reconciles the stale escalation panel", async () => {
  const gh = new FakeGitHub({ thesis: "T", issues: [{ number: 12, title: "x", body: "y", labels: [], state: "open" }] });
  const c = ctx(gh, new FakeProvider({}));
  await issueStep(c, 12); await issueStep(c, 12); await issueStep(c, 12); // escalated
  expect(gh.panels[12]).toContain("needs a human");
  // same ctx (same fails tracker), but now the provider yields a valid verdict:
  const ok = { ...c, provider: new FakeProvider({ "verdict.json": '{"verdict":"in","reason":"ok"}' }) };
  const out = await issueStep(ok, 12);
  expect(out).toEqual({ kind: "progressed" });
  const [i] = await gh.listOpenIssues("o/r", 0);
  expect(i.labels).toContain("thesis:in");
  expect(i.labels).toContain("monastery/state:triaged");
  expect(gh.panels[12]).toContain("resolved"); // stale escalation reconciled
  rmSync(c.artifactRoot, { recursive: true, force: true });
});
