import { expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProvider, type CodexRunner } from "../src/provider/codex.js";

const dir = () => mkdtempSync(join(tmpdir(), "monastery-codex-provider-"));

test("CodexProvider runs codex exec in artifactDir and scans only real artifacts", async () => {
  const d = dir();
  const calls: Parameters<CodexRunner>[] = [];
  const run: CodexRunner = async (file, args, opts) => {
    calls.push([file, args, opts]);
    expect(opts?.cwd).toBe(d);
    expect(opts?.input).toBe("persona\n\n---\n\ncontext");
    writeFileSync(join(d, "out.json"), "{\"ok\":true}", "utf8");
    writeFileSync(join(d, "_codex_stdout.jsonl"), "{}", "utf8");
    writeFileSync(join(d, "_codex_last_message.txt"), "done", "utf8");
    return { exitCode: 0 };
  };

  try {
    const provider = new CodexProvider(run);
    const result = await provider.run({ persona: "persona", context: "context", artifactDir: d, model: "fast", timeoutMs: 1234 });

    expect(calls).toHaveLength(1);
    const [file, args] = calls[0];
    expect(file).toBe("codex");
    expect(args).toEqual([
      "exec",
      "-C", d,
      "-m", "fast",
      "--sandbox", "workspace-write",
      "--skip-git-repo-check",
      "--ephemeral",
      "--output-last-message", join(d, "_codex_last_message.txt"),
      "--json",
      "-",
    ]);
    expect(result.artifacts).toEqual([join(d, "out.json")]);
    expect(result.resultText).toBe("done");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("CodexProvider omits -m when model is empty so the CLI default is used", async () => {
  const d = dir();
  const calls: Parameters<CodexRunner>[] = [];
  const run: CodexRunner = async (file, args, opts) => {
    calls.push([file, args, opts]);
    writeFileSync(join(d, "out.json"), "{\"ok\":true}", "utf8");
    return { exitCode: 0 };
  };

  try {
    await new CodexProvider(run).run({ persona: "p", context: "c", artifactDir: d, model: " " });
    expect(calls[0][1]).not.toContain("-m");
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("CodexProvider creates artifactDir before spawning", async () => {
  const d = join(dir(), "nested");
  const run: CodexRunner = async (_file, _args, opts) => {
    writeFileSync(join(opts!.cwd!, "out.json"), "{\"ok\":true}", "utf8");
    return { exitCode: 0 };
  };

  try {
    const result = await new CodexProvider(run).run({ persona: "p", context: "c", artifactDir: d, model: "m" });
    expect(JSON.parse(readFileSync(result.artifacts[0], "utf8"))).toEqual({ ok: true });
  } finally {
    rmSync(d.replace(/\/nested$/, ""), { recursive: true, force: true });
  }
});
