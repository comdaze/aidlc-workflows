#!/usr/bin/env bun
// Non-destructive installer for dist/cursor. It preserves project-owned files,
// structurally merges Cursor's shared JSON surfaces, and refuses ambiguous
// collisions before writing any part of the distribution.

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIST_ROOT = dirname(fileURLToPath(import.meta.url));
const AGENTS_BEGIN = "<!-- BEGIN AIDLC CURSOR -->";
const AGENTS_END = "<!-- END AIDLC CURSOR -->";
const GITIGNORE_BEGIN = "# BEGIN AIDLC CURSOR";
const GITIGNORE_END = "# END AIDLC CURSOR";
const RECEIPT_REL = ".cursor/aidlc-install.json";

type JsonObject = Record<string, unknown>;
type WriteAction =
  | { kind: "copy"; source: string; target: string }
  | { kind: "write"; target: string; content: string | Buffer };

interface InstallReceipt {
  schemaVersion: 1;
  managedFiles: Record<string, string>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(path: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    throw new Error(`${path}: malformed JSON (${error instanceof Error ? error.message : error})`);
  }
  if (!isObject(parsed)) throw new Error(`${path}: expected a JSON object`);
  return parsed;
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function readReceipt(path: string): InstallReceipt | null {
  if (!existsSync(path)) return null;
  const parsed = parseObject(path);
  if (parsed.schemaVersion !== 1 || !isObject(parsed.managedFiles)) {
    throw new Error(`${path}: unsupported or malformed AI-DLC install receipt`);
  }
  const managedFiles: Record<string, string> = {};
  for (const [file, hash] of Object.entries(parsed.managedFiles)) {
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new Error(`${path}: invalid managed-file hash for ${file}`);
    }
    managedFiles[file] = hash;
  }
  return { schemaVersion: 1, managedFiles };
}

function isLegacyAidlcInstall(targetRoot: string): boolean {
  return [
    ".cursor/tools/aidlc-version.ts",
    ".cursor/hooks/aidlc-cursor-adapter.ts",
    ".cursor/skills/aidlc/SKILL.md",
  ].every((rel) => existsSync(join(targetRoot, rel)));
}

function activeSpaceFor(targetRoot: string): string {
  const pointer = join(targetRoot, "aidlc", "active-space");
  if (!existsSync(pointer)) return "default";
  const space = readFileSync(pointer, "utf-8").trim();
  return /^[a-z0-9][a-z0-9._-]*$/.test(space) ? space : "default";
}

function managedContent(rel: string, source: Buffer, activeSpace: string): Buffer {
  if (
    /^\.cursor\/rules\/.+\.mdc$/.test(rel) ||
    /^\.cursor\/agents\/[^/]+-agent\.md$/.test(rel)
  ) {
    return Buffer.from(
      source
        .toString("utf-8")
        .replace(
          /aidlc\/spaces\/[^/]+\/memory\//g,
          `aidlc/spaces/${activeSpace}/memory/`,
        ),
      "utf-8",
    );
  }
  return source;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label}: expected an array of strings`);
  }
  return value as string[];
}

function mergeHooks(sourcePath: string, targetPath: string): string {
  const source = parseObject(sourcePath);
  const existing = existsSync(targetPath) ? parseObject(targetPath) : {};
  const sourceVersion = source.version;
  if (
    existing.version !== undefined &&
    sourceVersion !== undefined &&
    existing.version !== sourceVersion
  ) {
    throw new Error(
      `${targetPath}: hooks version ${String(existing.version)} conflicts with shipped version ${String(sourceVersion)}`,
    );
  }
  const sourceHooks = source.hooks;
  const existingHooks = existing.hooks;
  if (!isObject(sourceHooks)) throw new Error(`${sourcePath}: hooks must be an object`);
  if (existingHooks !== undefined && !isObject(existingHooks)) {
    throw new Error(`${targetPath}: hooks must be an object`);
  }

  const mergedHooks: JsonObject = { ...(existingHooks ?? {}) };
  for (const [event, shippedEntries] of Object.entries(sourceHooks)) {
    if (!Array.isArray(shippedEntries)) {
      throw new Error(`${sourcePath}: hooks.${event} must be an array`);
    }
    const projectEntries = mergedHooks[event];
    if (projectEntries !== undefined && !Array.isArray(projectEntries)) {
      throw new Error(`${targetPath}: hooks.${event} must be an array`);
    }
    const merged = [...((projectEntries as unknown[] | undefined) ?? [])];
    for (const entry of shippedEntries) {
      const command = isObject(entry) && typeof entry.command === "string" ? entry.command : null;
      const existingIndex =
        command === null
          ? -1
          : merged.findIndex(
              (candidate) => isObject(candidate) && candidate.command === command,
            );
      // A command match identifies an AI-DLC-owned hook entry. Replace it with
      // the refreshed shipped object so security metadata such as failClosed
      // upgrades instead of being frozen at the first installed version.
      if (existingIndex === -1) merged.push(entry);
      else merged[existingIndex] = entry;
    }
    mergedHooks[event] = merged;
  }

  const merged = {
    ...existing,
    ...(sourceVersion === undefined ? {} : { version: sourceVersion }),
    hooks: mergedHooks,
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function mergeCli(sourcePath: string, targetPath: string): string {
  const source = parseObject(sourcePath);
  const existing = existsSync(targetPath) ? parseObject(targetPath) : {};
  const sourcePermissions = source.permissions;
  const existingPermissions = existing.permissions;
  if (!isObject(sourcePermissions)) throw new Error(`${sourcePath}: permissions must be an object`);
  if (existingPermissions !== undefined && !isObject(existingPermissions)) {
    throw new Error(`${targetPath}: permissions must be an object`);
  }

  const shippedAllow = stringArray(sourcePermissions.allow, `${sourcePath}: permissions.allow`);
  const shippedDeny = stringArray(sourcePermissions.deny, `${sourcePath}: permissions.deny`);
  const projectAllow = stringArray(existingPermissions?.allow, `${targetPath}: permissions.allow`);
  const projectDeny = stringArray(existingPermissions?.deny, `${targetPath}: permissions.deny`);
  const conflicts = [
    ...shippedAllow.filter((entry) => projectDeny.includes(entry)),
    ...shippedDeny.filter((entry) => projectAllow.includes(entry)),
  ];
  if (conflicts.length > 0) {
    throw new Error(
      `${targetPath}: shipped permissions conflict with existing allow/deny entries: ${[...new Set(conflicts)].join(", ")}`,
    );
  }

  const permissions = {
    ...(existingPermissions ?? {}),
    allow: [...new Set([...projectAllow, ...shippedAllow])],
    deny: [...new Set([...projectDeny, ...shippedDeny])],
  };
  return `${JSON.stringify({ ...existing, permissions }, null, 2)}\n`;
}

function replaceOrAppendMarked(
  existing: string,
  shipped: string,
  begin: string,
  end: string,
): string {
  const start = existing.indexOf(begin);
  const finish = existing.indexOf(end);
  if ((start === -1) !== (finish === -1) || (start !== -1 && finish < start)) {
    throw new Error(`cannot merge text with an incomplete ${begin} section`);
  }
  const section = `${begin}\n${shipped.trimEnd()}\n${end}`;
  if (start !== -1) {
    return `${existing.slice(0, start)}${section}${existing.slice(finish + end.length)}`;
  }
  if (existing.length === 0) return `${section}\n`;
  return `${existing.trimEnd()}\n\n${section}\n`;
}

function* filesUnder(root: string): Generator<string> {
  for (const name of readdirSync(root).sort()) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) yield* filesUnder(path);
    else yield path;
  }
}

export function install(targetDir: string): void {
  const targetRoot = resolve(targetDir);
  const actions: WriteAction[] = [];
  const collisions: string[] = [];
  const sharedJson = new Set([".cursor/hooks.json", ".cursor/cli.json"]);
  const receiptTarget = join(targetRoot, RECEIPT_REL);
  const priorReceipt = readReceipt(receiptTarget);
  const legacyInstall = priorReceipt === null && isLegacyAidlcInstall(targetRoot);
  const activeSpace = activeSpaceFor(targetRoot);
  const managedFiles: Record<string, string> = {
    ...(priorReceipt?.managedFiles ?? {}),
  };

  for (const top of [".cursor", "aidlc"]) {
    const sourceRoot = join(DIST_ROOT, top);
    for (const source of filesUnder(sourceRoot)) {
      const rel = relative(DIST_ROOT, source).replaceAll("\\", "/");
      if (sharedJson.has(rel)) continue;
      const target = join(targetRoot, rel);
      const sourceBytes = readFileSync(source);

      // Workspace memory is project-owned after seeding, and active-space is a
      // per-user runtime pointer. Seed missing files but never overwrite them.
      if (rel === "aidlc/active-space" || rel.startsWith("aidlc/spaces/")) {
        if (!existsSync(target)) actions.push({ kind: "copy", source, target });
        continue;
      }

      managedFiles[rel] = sha256(sourceBytes);
      if (!existsSync(target)) {
        actions.push({ kind: "copy", source, target });
      } else if (readFileSync(target).equals(managedContent(rel, sourceBytes, activeSpace))) {
        // Already current, including an active-space-adjusted Cursor surface.
      } else if (priorReceipt?.managedFiles[rel] !== undefined || legacyInstall) {
        actions.push({
          kind: "write",
          target,
          content: managedContent(rel, sourceBytes, activeSpace),
        });
      } else {
        collisions.push(rel);
      }
    }
  }

  const hooksTarget = join(targetRoot, ".cursor", "hooks.json");
  const cliTarget = join(targetRoot, ".cursor", "cli.json");
  const hooks = mergeHooks(join(DIST_ROOT, ".cursor", "hooks.json"), hooksTarget);
  const cli = mergeCli(join(DIST_ROOT, ".cursor", "cli.json"), cliTarget);
  actions.push({ kind: "write", target: hooksTarget, content: hooks });
  actions.push({ kind: "write", target: cliTarget, content: cli });

  const agentsSource = readFileSync(join(DIST_ROOT, "AGENTS.md"), "utf-8");
  const agentsTarget = join(targetRoot, "AGENTS.md");
  const agentsExisting = existsSync(agentsTarget) ? readFileSync(agentsTarget, "utf-8") : "";
  actions.push({
    kind: "write",
    target: agentsTarget,
    content: replaceOrAppendMarked(
      agentsExisting,
      agentsSource,
      AGENTS_BEGIN,
      AGENTS_END,
    ),
  });

  const gitignoreSource = readFileSync(join(DIST_ROOT, ".gitignore"), "utf-8");
  const aidlcBlockStart = gitignoreSource.indexOf("# AI-DLC");
  if (aidlcBlockStart === -1) throw new Error("shipped .gitignore has no AI-DLC section");
  const gitignoreTarget = join(targetRoot, ".gitignore");
  const gitignoreExisting = existsSync(gitignoreTarget)
    ? readFileSync(gitignoreTarget, "utf-8")
    : "";
  actions.push({
    kind: "write",
    target: gitignoreTarget,
    content: replaceOrAppendMarked(
      gitignoreExisting || gitignoreSource.slice(0, aidlcBlockStart),
      gitignoreSource.slice(aidlcBlockStart),
      GITIGNORE_BEGIN,
      GITIGNORE_END,
    ),
  });

  if (collisions.length > 0) {
    throw new Error(
      `refusing to overwrite existing files that differ:\n${collisions.map((path) => `  ${path}`).join("\n")}`,
    );
  }

  actions.push({
    kind: "write",
    target: receiptTarget,
    content: `${JSON.stringify(
      { schemaVersion: 1, managedFiles } satisfies InstallReceipt,
      null,
      2,
    )}\n`,
  });

  for (const action of actions) {
    mkdirSync(dirname(action.target), { recursive: true });
    if (action.kind === "copy") cpSync(action.source, action.target);
    else writeFileSync(action.target, action.content, "utf-8");
  }
}

if (import.meta.main) {
  const target = process.argv[2];
  if (!target || target === "--help" || target === "-h") {
    console.log("Usage: bun dist/cursor/install.ts <project-directory>");
    process.exit(target ? 0 : 2);
  }
  try {
    install(target);
    console.log(`AI-DLC Cursor harness installed into ${resolve(target)}`);
  } catch (error) {
    console.error(`Cursor install failed: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}
