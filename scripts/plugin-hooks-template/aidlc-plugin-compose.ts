#!/usr/bin/env bun
// Cross-platform Cursor plugin compose launcher. Cursor hook commands are
// command strings, so avoid `sh -c`: prefer an installed aidlc executable and
// fall back to the sibling compose.ts with the Bun executable already running
// this hook.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const harnessDir = process.argv[2] || ".cursor";
const env = { ...process.env, AIDLC_HARNESS_DIR: harnessDir };
const aidlc = Bun.which("aidlc");

if (aidlc) {
  const synced = spawnSync(aidlc, ["plugin", "sync"], {
    env,
    stdio: "inherit",
  });
  if (synced.status === 0) process.exit(0);
}

const compose = join(dirname(fileURLToPath(import.meta.url)), "compose.ts");
const fallback = spawnSync(process.execPath, [compose], {
  env,
  stdio: "inherit",
});
process.exit(fallback.status ?? 1);
