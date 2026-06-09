// tests/fixtures/step-lock-child.ts — spawned by step-lock.test.ts to exercise
// real SIGINT/SIGTERM lock cleanup in a separate process (end-to-end).
import { StepLock } from "../../src/config/step-lock.ts";

const root = process.argv[2];
const lock = new StepLock(root);
lock.acquire("owner/repo", "child");
process.stdout.write("READY\n");
// Stay alive until a signal arrives; the lock's signal handler should release it.
setInterval(() => {}, 1000);
