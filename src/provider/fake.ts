// src/provider/fake.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig, AgentProvider, AgentResult } from "./interface.js";

/** Test double: writes a fixed set of files (name -> contents) into artifactDir. */
export class FakeProvider implements AgentProvider {
  public calls: AgentConfig[] = [];
  constructor(private files: Record<string, string>, private resultText?: string) {}
  async run(config: AgentConfig): Promise<AgentResult> {
    this.calls.push(config);
    mkdirSync(config.artifactDir, { recursive: true });
    const artifacts: string[] = [];
    for (const [name, body] of Object.entries(this.files)) {
      const p = join(config.artifactDir, name);
      writeFileSync(p, body, "utf8");
      artifacts.push(p);
    }
    return { artifacts, resultText: this.resultText };
  }
}
