// src/provider/fake.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

type FakeResponse = { files: Record<string, string>; resultText?: string };

/** Test double: writes a fixed set of files (name -> contents) into artifactDir.
 *  Pass an array of Response objects to simulate sequential calls (e.g. retry scenarios).
 *  The last response repeats for any calls beyond the sequence length. */
export class FakeProvider implements AgentProvider {
  public calls: AgentConfig[] = [];
  private seq: FakeResponse[];

  constructor(
    files: Record<string, string> | FakeResponse[],
    resultText?: string,
  ) {
    this.seq = Array.isArray(files) ? files : [{ files, resultText }];
  }

  async run(config: AgentConfig): Promise<AgentResult> {
    this.calls.push(config);
    mkdirSync(config.artifactDir, { recursive: true });
    const resp = this.seq[Math.min(this.calls.length - 1, this.seq.length - 1)];
    const artifacts: string[] = [];
    for (const [name, body] of Object.entries(resp.files)) {
      const p = join(config.artifactDir, name);
      writeFileSync(p, body, "utf8");
      artifacts.push(p);
    }
    return { artifacts, resultText: resp.resultText };
  }
}
