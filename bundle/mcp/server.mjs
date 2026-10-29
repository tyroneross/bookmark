#!/usr/bin/env node
import { createRequire as __bookmarkCreateRequire } from 'node:module';
const require = __bookmarkCreateRequire(import.meta.url);

// src/mcp/server.ts
import { createInterface } from "readline";

// src/config.ts
import { readFileSync as readFileSync2, writeFileSync, existsSync as existsSync2, mkdirSync, readdirSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { homedir } from "node:os";

// src/trails/identity.ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
var IDENTITY_BLOCK = /<!--\s*BOOKMARK_IDENTITY\s*\n([\s\S]*?)\n\s*-->/;
function parseIdentity(content) {
  const match = content.match(IDENTITY_BLOCK);
  if (!match) {
    return { identity: null, bodyWithoutIdentity: content };
  }
  const raw = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    if (!key) continue;
    raw[key] = value;
  }
  const scopeRaw = (raw.scope ?? "repo").toLowerCase();
  const scope = scopeRaw === "home" ? "home" : "repo";
  const identity = {
    scope,
    project: raw.project,
    repo_path: raw.repo_path,
    repo_name: raw.repo_name,
    branch: raw.branch,
    head: raw.head,
    base: raw.base,
    written: raw.written,
    written_by: raw.written_by,
    points_to_project: raw.points_to_project,
    points_to_repo: raw.points_to_repo,
    points_to_canonical: raw.points_to_canonical,
    raw
  };
  const bodyWithoutIdentity = content.slice(0, match.index) + content.slice(match.index + match[0].length);
  return { identity, bodyWithoutIdentity: bodyWithoutIdentity.replace(/^\s*\n+/, "") };
}
function validateRepoIdentity(identity, cwd) {
  if (identity.scope !== "repo") return null;
  if (!identity.repo_path) return null;
  const declared = resolve(identity.repo_path);
  const actual = resolve(cwd);
  if (declared === actual) return null;
  if (actual.startsWith(declared + "/")) return null;
  return `[Bookmark identity mismatch] This bookmark.context.md declares repo_path=${declared} but was loaded from cwd=${actual}. Verify you are in the correct project before acting on the context below.`;
}
function followPointer(identity) {
  if (identity.scope !== "home") return null;
  if (!identity.points_to_canonical) return null;
  const target = identity.points_to_canonical;
  if (!existsSync(target)) return null;
  try {
    const content = readFileSync(target, "utf-8");
    const mtime = statSync(target).mtimeMs;
    const staleness_hours = Math.round((Date.now() - mtime) / (1e3 * 60 * 60));
    const { identity: targetIdentity } = parseIdentity(content);
    return {
      canonical_path: target,
      content,
      identity: targetIdentity,
      staleness_hours
    };
  } catch {
    return null;
  }
}

// src/config.ts
var DEFAULTS = {
  storagePath: ".bookmark",
  thresholds: [0.2, 0.3, 0.4, 0.5, 0.6],
  maxThreshold: 0.6,
  intervalMinutes: 5,
  maxDecisions: 15,
  maxOpenItems: 10,
  maxFilesTracked: 20,
  maxErrorsTracked: 10,
  maxActiveSnapshots: 200,
  archiveAfterDays: 30,
  snapshotOnSessionEnd: true,
  restoreOnSessionStart: true,
  tokenThresholds: [0.75],
  contextLimitTokens: void 0,
  verboseLogging: false
};
function parseFractions(value) {
  return value.split(",").map(Number).map((n) => n > 1 ? n / 100 : n).filter((n) => Number.isFinite(n) && n > 0 && n < 1).sort((a, b) => a - b);
}
function resolveProjectRoot(cwd) {
  const home = homedir();
  let dir = cwd;
  while (dir && dir !== dirname(dir)) {
    if (existsSync2(join(dir, ".bookmark")) || existsSync2(join(dir, ".git")) || existsSync2(join(dir, "package.json"))) {
      return dir;
    }
    if (dir === home) break;
    dir = dirname(dir);
  }
  return cwd;
}
function loadConfig(cwd) {
  const config = { ...DEFAULTS };
  if (cwd) {
    const root = resolveProjectRoot(cwd);
    const projectConfigPath = join(root, ".bookmark", "config.json");
    if (existsSync2(projectConfigPath)) {
      try {
        const projectConfig = JSON.parse(readFileSync2(projectConfigPath, "utf-8"));
        Object.assign(config, projectConfig);
      } catch {
      }
    }
  }
  if (process.env.BOOKMARK_INTERVAL) {
    config.intervalMinutes = parseInt(process.env.BOOKMARK_INTERVAL, 10) || config.intervalMinutes;
  }
  if (process.env.BOOKMARK_THRESHOLD) {
    const vals = process.env.BOOKMARK_THRESHOLD.split(",").map(Number).filter((n) => !isNaN(n));
    if (vals.length > 0) config.thresholds = vals;
  }
  if (process.env.BOOKMARK_TOKEN_THRESHOLD) {
    const vals = parseFractions(process.env.BOOKMARK_TOKEN_THRESHOLD);
    if (vals.length > 0) config.tokenThresholds = vals;
  }
  if (process.env.BOOKMARK_CONTEXT_LIMIT) {
    const limit = Number.parseInt(process.env.BOOKMARK_CONTEXT_LIMIT, 10);
    if (Number.isFinite(limit) && limit > 0) config.contextLimitTokens = limit;
  }
  if (process.env.BOOKMARK_STORAGE_PATH) {
    config.storagePath = process.env.BOOKMARK_STORAGE_PATH;
  }
  if (process.env.BOOKMARK_VERBOSE === "true") {
    config.verboseLogging = true;
  }
  const configuredTokenThresholds = Array.isArray(config.tokenThresholds) ? parseFractions(config.tokenThresholds.join(",")) : [];
  config.tokenThresholds = configuredTokenThresholds.length > 0 ? configuredTokenThresholds : [...DEFAULTS.tokenThresholds];
  if (config.contextLimitTokens !== void 0 && (!Number.isFinite(config.contextLimitTokens) || config.contextLimitTokens <= 0)) {
    config.contextLimitTokens = void 0;
  }
  return config;
}
function getStoragePath(cwd, config) {
  const cfg = config ?? loadConfig(cwd);
  if (cfg.storagePath.startsWith("/")) {
    return cfg.storagePath;
  }
  const root = resolveProjectRoot(cwd);
  return join(root, cfg.storagePath);
}

// src/registry.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync3, writeFileSync as writeFileSync2 } from "node:fs";
import { basename, dirname as dirname2, join as join2 } from "node:path";
import { homedir as homedir2 } from "node:os";
var REGISTRY_VERSION = "1.0.0";
var MAX_ENTRIES = 500;
function resolveProjectName(cwd) {
  const home = homedir2();
  const pkgPath = join2(cwd, "package.json");
  if (existsSync3(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync3(pkgPath, "utf-8"));
      if (pkg.name && pkg.name.trim()) {
        return pkg.name.replace(/^@[^/]+\//, "").trim();
      }
    } catch {
    }
  }
  let dir = cwd;
  const root = dirname2(home);
  while (dir && dir !== root && dir !== dirname2(dir)) {
    if (existsSync3(join2(dir, ".git"))) {
      return basename(dir);
    }
    dir = dirname2(dir);
  }
  const cwdBase = basename(cwd);
  if (cwd === home || cwdBase === basename(home)) {
    return "home";
  }
  return cwdBase;
}
function getRegistryPath() {
  return join2(homedir2(), ".bookmark", "registry.json");
}
function ensureRegistryDir() {
  const dir = join2(homedir2(), ".bookmark");
  if (!existsSync3(dir)) mkdirSync2(dir, { recursive: true });
}
function loadRegistry() {
  const path = getRegistryPath();
  if (!existsSync3(path)) {
    return { version: REGISTRY_VERSION, last_updated: 0, snapshots: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync3(path, "utf-8"));
    if (!parsed.snapshots) parsed.snapshots = [];
    return parsed;
  } catch {
    return { version: REGISTRY_VERSION, last_updated: 0, snapshots: [] };
  }
}
function saveRegistry(registry) {
  ensureRegistryDir();
  registry.last_updated = Date.now();
  writeFileSync2(getRegistryPath(), JSON.stringify(registry, null, 2), "utf-8");
}
function appendToRegistry(snapshot, canonicalFile) {
  try {
    const registry = loadRegistry();
    const entry = {
      id: snapshot.snapshot_id,
      timestamp: snapshot.timestamp,
      trigger: snapshot.trigger,
      project_path: snapshot.project_path,
      project_name: resolveProjectName(snapshot.project_path),
      canonical_file: canonicalFile,
      files_changed_count: snapshot.files_changed.length
    };
    registry.snapshots = [entry, ...registry.snapshots.filter((e) => e.id !== entry.id)];
    if (registry.snapshots.length > MAX_ENTRIES) {
      registry.snapshots.length = MAX_ENTRIES;
    }
    registry.last_project = {
      path: snapshot.project_path,
      name: entry.project_name,
      last_activity_at: snapshot.timestamp
    };
    saveRegistry(registry);
  } catch {
  }
}
function touchLastProject(projectPath) {
  try {
    const registry = loadRegistry();
    registry.last_project = {
      path: projectPath,
      name: resolveProjectName(projectPath),
      last_activity_at: Date.now()
    };
    saveRegistry(registry);
  } catch {
  }
}

// src/snapshot/capture.ts
import { join as join8 } from "node:path";

// src/transcript/parser.ts
import { readFileSync as readFileSync4, existsSync as existsSync4, statSync as statSync2 } from "node:fs";
function parseTranscript(transcriptPath, options) {
  if (!existsSync4(transcriptPath)) {
    return { entries: [], bytesRead: 0, totalBytes: 0 };
  }
  const startOffset = options?.startOffset ?? 0;
  const stat = statSync2(transcriptPath);
  const totalBytes = stat.size;
  if (startOffset >= totalBytes) {
    return { entries: [], bytesRead: totalBytes, totalBytes };
  }
  const raw = readFileSync4(transcriptPath, "utf-8");
  const lines = raw.split("\n");
  const entries = [];
  let currentByteOffset = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line + "\n", "utf-8");
    if (currentByteOffset < startOffset) {
      currentByteOffset += lineBytes;
      continue;
    }
    currentByteOffset += lineBytes;
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const normalized = normalizeEntry(parsed);
      if (normalized) {
        entries.push(normalized);
      }
      const message = parsed.message;
      if (message?.content && Array.isArray(message.content)) {
        const toolIdToName = /* @__PURE__ */ new Map();
        for (const block of message.content) {
          if (block.type === "tool_use" && block.id && block.name) {
            toolIdToName.set(block.id, block.name);
          }
        }
        for (const block of message.content) {
          if (block.type === "tool_use" && block.name) {
            entries.push({
              type: "tool_use",
              timestamp: parsed.timestamp ?? void 0,
              content: "",
              tool_name: block.name,
              tool_input: block.input,
              session_id: parsed.sessionId ?? void 0
            });
          }
          if (block.type === "tool_result") {
            const resultContent = typeof block.content === "string" ? block.content : Array.isArray(block.content) ? block.content.map((c) => c.text ?? "").filter(Boolean).join("\n") : "";
            const toolUseId = block.tool_use_id;
            const resolvedName = toolUseId ? toolIdToName.get(toolUseId) : void 0;
            entries.push({
              type: "tool_result",
              timestamp: parsed.timestamp ?? void 0,
              content: resultContent,
              tool_name: resolvedName ?? toolUseId,
              session_id: parsed.sessionId ?? void 0
            });
          }
        }
      }
    } catch {
    }
  }
  return {
    entries,
    bytesRead: totalBytes,
    totalBytes
  };
}
function normalizeEntry(raw) {
  const type = inferType(raw);
  if (!type) return null;
  const content = extractTextContent(raw);
  const message = raw.message;
  let toolName = raw.tool_name ?? raw.name ?? void 0;
  let toolInput = raw.tool_input ?? raw.input ?? void 0;
  if (!toolName && message?.content && Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === "tool_use") {
        toolName = block.name;
        toolInput = block.input;
        break;
      }
    }
  }
  return {
    type,
    timestamp: raw.timestamp ?? void 0,
    content,
    tool_name: toolName,
    tool_input: toolInput,
    session_id: raw.sessionId ?? raw.session_id ?? void 0
  };
}
function inferType(raw) {
  if (raw.type && typeof raw.type === "string") {
    const t = raw.type.toLowerCase();
    if (t === "user" || t === "human") return "user";
    if (t === "assistant" || t === "ai") return "assistant";
    if (t === "tool_use") return "tool_use";
    if (t === "tool_result") return "tool_result";
    if (t === "system") return "system";
  }
  if (raw.role && typeof raw.role === "string") {
    const r = raw.role.toLowerCase();
    if (r === "user" || r === "human") return "user";
    if (r === "assistant") return "assistant";
    if (r === "system") return "system";
  }
  if (raw.tool_name || raw.name) return "tool_use";
  if (raw.tool_use_id) return "tool_result";
  return null;
}
function extractTextContent(raw) {
  const message = raw.message;
  const content = raw.content ?? message?.content ?? raw.text ?? "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === "string") return block;
      if (block.text) return block.text;
      if (block.thinking) return block.thinking;
      if (block.content && typeof block.content === "string") return block.content;
      return "";
    }).filter(Boolean).join("\n");
  }
  return "";
}

// src/transcript/extractor.ts
import { relative, isAbsolute } from "node:path";
function toProjectRelative(filePath, projectPath) {
  if (!projectPath || !filePath) return filePath;
  if (!isAbsolute(filePath)) return filePath;
  if (!filePath.startsWith(projectPath)) return filePath;
  const rel = relative(projectPath, filePath);
  return rel === "" ? "." : rel;
}
var FILE_TOOL_NAMES = /* @__PURE__ */ new Set(["Write", "Edit", "write", "edit"]);
var FILE_CREATING_BASH_PATTERNS = [
  /\b(?:mkdir|touch|mv|cp|cat\s+>|echo\s+>|tee)\b/
];
function extractFilesAndTools(entries, options) {
  const projectPath = options?.projectPath;
  return {
    files_changed: extractFilesChanged(entries, projectPath),
    tools_summary: extractToolsSummary(entries)
  };
}
function extractFilesChanged(entries, projectPath) {
  const fileMap = /* @__PURE__ */ new Map();
  const fileLinesChanged = /* @__PURE__ */ new Map();
  const fileStructuralChanges = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type === "tool_use") {
      const toolName = entry.tool_name ?? "";
      const input = entry.tool_input ?? {};
      if (FILE_TOOL_NAMES.has(toolName)) {
        const filePath = input.file_path ?? input.path ?? "";
        if (filePath) {
          if (projectPath && !filePath.startsWith(projectPath)) continue;
          const ops = fileMap.get(filePath) ?? /* @__PURE__ */ new Set();
          ops.add(toolName.toLowerCase());
          fileMap.set(filePath, ops);
          const newStr = input.new_string ?? input.content ?? "";
          const oldStr = input.old_string ?? "";
          const linesAdded = newStr ? newStr.split("\n").length : 0;
          const linesRemoved = oldStr ? oldStr.split("\n").length : 0;
          const delta = Math.abs(linesAdded - linesRemoved) + Math.min(linesAdded, linesRemoved);
          fileLinesChanged.set(filePath, (fileLinesChanged.get(filePath) ?? 0) + delta);
          const changes = fileStructuralChanges.get(filePath) ?? /* @__PURE__ */ new Set();
          extractStructuralHints(newStr, oldStr, changes);
          if (changes.size > 0) {
            fileStructuralChanges.set(filePath, changes);
          }
        }
      }
      if (toolName === "Bash" || toolName === "bash") {
        const cmd = input.command ?? "";
        for (const pattern of FILE_CREATING_BASH_PATTERNS) {
          if (pattern.test(cmd)) {
            const parts = cmd.split(/\s+/);
            const lastPart = parts[parts.length - 1];
            if (lastPart && !lastPart.startsWith("-")) {
              if (projectPath && !lastPart.startsWith(projectPath)) break;
              const ops = fileMap.get(lastPart) ?? /* @__PURE__ */ new Set();
              ops.add("create");
              fileMap.set(lastPart, ops);
            }
            break;
          }
        }
      }
    }
  }
  const result = [];
  for (const [path, ops] of fileMap) {
    const changes = fileStructuralChanges.get(path);
    const summary = changes && changes.size > 0 ? [...changes].slice(0, 4).join(", ") : void 0;
    result.push({
      // Store relative to projectPath so snapshots survive a project move.
      // The original absolute path is preserved in `absolute_path` for
      // diagnostic use; consumers should prefer `path` joined to the
      // current project_path.
      path: toProjectRelative(path, projectPath),
      operations: [...ops],
      lines_changed: fileLinesChanged.get(path) ?? 0,
      summary
    });
  }
  return result.slice(0, 20);
}
function extractStructuralHints(newStr, oldStr, changes) {
  if (!newStr && !oldStr) return;
  const newLines = new Set(newStr.split("\n").map((l) => l.trim()));
  const oldLines = new Set(oldStr.split("\n").map((l) => l.trim()));
  const STRUCTURAL_PATTERNS = [
    { pattern: /^export\s+(?:async\s+)?function\s+(\w+)/, prefix: "+fn" },
    { pattern: /^(?:async\s+)?function\s+(\w+)/, prefix: "+fn" },
    { pattern: /^export\s+(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/, prefix: "+fn" },
    { pattern: /^(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/, prefix: "+fn" },
    { pattern: /^export\s+class\s+(\w+)/, prefix: "+class" },
    { pattern: /^class\s+(\w+)/, prefix: "+class" },
    { pattern: /^export\s+interface\s+(\w+)/, prefix: "+interface" },
    { pattern: /^interface\s+(\w+)/, prefix: "+interface" },
    { pattern: /^export\s+type\s+(\w+)/, prefix: "+type" },
    { pattern: /^type\s+(\w+)/, prefix: "+type" },
    { pattern: /^import\s+.*from\s+['"]([^'"]+)['"]/, prefix: "+import" }
  ];
  for (const line of newLines) {
    if (oldLines.has(line)) continue;
    for (const { pattern, prefix } of STRUCTURAL_PATTERNS) {
      const match = line.match(pattern);
      if (match) {
        changes.add(`${prefix} ${match[1]}`);
        break;
      }
    }
  }
  if (oldStr) {
    for (const line of oldLines) {
      if (newLines.has(line)) continue;
      for (const { pattern, prefix } of STRUCTURAL_PATTERNS) {
        const match = line.match(pattern);
        if (match) {
          const removePrefix = prefix.replace("+", "-");
          if (!changes.has(`${prefix} ${match[1]}`)) {
            changes.add(`${removePrefix} ${match[1]}`);
          }
          break;
        }
      }
    }
  }
}
function extractToolsSummary(entries) {
  const summary = {};
  for (const entry of entries) {
    if (entry.type === "tool_use" && entry.tool_name) {
      summary[entry.tool_name] = (summary[entry.tool_name] ?? 0) + 1;
    }
  }
  return summary;
}

// src/snapshot/storage.ts
import { readFileSync as readFileSync5, existsSync as existsSync5, mkdirSync as mkdirSync4, readdirSync as readdirSync2 } from "node:fs";

// src/util/atomic-write.ts
import { chmodSync, mkdirSync as mkdirSync3, renameSync as renameSync2, unlinkSync, writeFileSync as writeFileSync3 } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename as basename2, dirname as dirname3, join as join3 } from "node:path";
function writeFileAtomic(path, data, mode) {
  const dir = dirname3(path);
  mkdirSync3(dir, { recursive: true });
  const temp = join3(dir, `.${basename2(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync3(temp, data, { encoding: typeof data === "string" ? "utf-8" : void 0, mode: mode ?? 438 });
    if (mode !== void 0) chmodSync(temp, mode);
    renameSync2(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
    }
    throw err;
  }
}

// src/snapshot/storage.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { join as join4 } from "node:path";
var INDEX_VERSION = "1.0.0";
function generateSnapshotId() {
  const now = /* @__PURE__ */ new Date();
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const milliseconds = pad(now.getMilliseconds(), 3);
  const entropy = randomBytes2(2).toString("hex");
  return `SNAP_${date}_${time}_${milliseconds}_${entropy}`;
}
function getSnapshotsDir(storagePath) {
  return join4(storagePath, "snapshots");
}
function getLatestPath(storagePath) {
  return join4(storagePath, "LATEST.md");
}
function getIndexPath(storagePath) {
  return join4(storagePath, "index.json");
}
function ensureStorageDirs(storagePath) {
  const dirs = [
    storagePath,
    join4(storagePath, "snapshots"),
    join4(storagePath, "archive")
  ];
  for (const dir of dirs) {
    if (!existsSync5(dir)) {
      mkdirSync4(dir, { recursive: true });
    }
  }
}
function storeSnapshot(storagePath, snapshot) {
  ensureStorageDirs(storagePath);
  const snapshotId = snapshot.snapshot_id || generateSnapshotId();
  const snapshotPath = join4(getSnapshotsDir(storagePath), `${snapshotId}.json`);
  writeFileAtomic(snapshotPath, JSON.stringify(snapshot, null, 2));
  updateIndex(storagePath, snapshot);
  return snapshotId;
}
function loadSnapshot(storagePath, snapshotId) {
  if (!/^SNAP_\d{8}_\d{6}(?:_\d{3}_[a-f0-9]{4})?$/.test(snapshotId)) {
    return null;
  }
  const snapshotPath = join4(getSnapshotsDir(storagePath), `${snapshotId}.json`);
  if (!existsSync5(snapshotPath)) return null;
  try {
    return JSON.parse(readFileSync5(snapshotPath, "utf-8"));
  } catch {
    return null;
  }
}
function loadLatestSnapshot(storagePath) {
  const index = loadIndex(storagePath);
  if (!index || index.snapshots.length === 0) return null;
  const latestEntry = index.snapshots[0];
  return loadSnapshot(storagePath, latestEntry.id);
}
function listSnapshots(storagePath, limit = 10) {
  const index = loadIndex(storagePath);
  if (!index) return [];
  return index.snapshots.slice(0, limit);
}
function writeLatestMd(storagePath, content) {
  ensureStorageDirs(storagePath);
  writeFileAtomic(getLatestPath(storagePath), content);
}
function readLatestMd(storagePath) {
  const path = getLatestPath(storagePath);
  if (!existsSync5(path)) return null;
  try {
    return readFileSync5(path, "utf-8");
  } catch {
    return null;
  }
}
function loadIndex(storagePath) {
  const indexPath = getIndexPath(storagePath);
  if (!existsSync5(indexPath)) return null;
  try {
    return JSON.parse(readFileSync5(indexPath, "utf-8"));
  } catch {
    return null;
  }
}
function updateIndex(storagePath, snapshot) {
  const indexPath = getIndexPath(storagePath);
  let index = loadIndex(storagePath) ?? {
    version: INDEX_VERSION,
    project_path: snapshot.project_path,
    last_updated: Date.now(),
    stats: {
      total_snapshots: 0,
      compaction_cycles: 0,
      last_compaction: 0,
      last_snapshot: 0,
      last_time_based: 0
    },
    snapshots: []
  };
  const entry = {
    id: snapshot.snapshot_id,
    timestamp: snapshot.timestamp,
    trigger: snapshot.trigger,
    compaction_cycle: snapshot.compaction_cycle,
    files_changed_count: snapshot.files_changed.length,
    context_remaining_pct: snapshot.context_remaining_pct,
    token_estimate: snapshot.token_estimate
  };
  index.snapshots.unshift(entry);
  index.stats.total_snapshots = index.snapshots.length;
  index.stats.last_snapshot = snapshot.timestamp;
  index.last_updated = Date.now();
  if (snapshot.trigger === "pre_compact") {
    index.stats.compaction_cycles = snapshot.compaction_cycle;
    index.stats.last_compaction = snapshot.timestamp;
  }
  if (snapshot.trigger === "time_interval") {
    index.stats.last_time_based = snapshot.timestamp;
  }
  if (index.snapshots.length > 50) {
    index.snapshots.length = 50;
  }
  writeFileAtomic(indexPath, JSON.stringify(index, null, 2));
}
function getSnapshotCount(storagePath) {
  const snapshotsDir = getSnapshotsDir(storagePath);
  if (!existsSync5(snapshotsDir)) return 0;
  try {
    return readdirSync2(snapshotsDir).filter((f) => f.startsWith("SNAP_") && f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

// src/snapshot/compress.ts
import { basename as basename3 } from "node:path";
function compressToMarkdown(snapshot) {
  const lines = [];
  const date = new Date(snapshot.timestamp).toISOString();
  lines.push(`# File Changes - ${date}`);
  lines.push("");
  lines.push(`> ${snapshot.snapshot_id} | cycle ${snapshot.compaction_cycle} | ${snapshot.trigger}`);
  lines.push("");
  if (snapshot.context_used_pct !== void 0 && snapshot.context_limit_tokens) {
    const usedPct = Math.round(snapshot.context_used_pct * 100);
    lines.push(`> Context: ${usedPct}% used | ${snapshot.model ?? "unknown model"} | limit ${formatTokens(snapshot.context_limit_tokens)}`);
    lines.push("");
  }
  if (snapshot.files_changed.length > 0) {
    const totalLines = snapshot.files_changed.reduce((sum, f) => sum + (f.lines_changed ?? 0), 0);
    lines.push(`## Files Changed (${snapshot.files_changed.length} files, ~${totalLines} lines)`);
    for (const f of snapshot.files_changed.slice(0, 10)) {
      const shortPath = shortenPath(f.path, snapshot.project_path);
      const ops = f.operations.join("/");
      const lc = f.lines_changed ? ` ~${f.lines_changed}L` : "";
      lines.push(`- \`${shortPath}\` (${ops}${lc})`);
    }
    if (snapshot.files_changed.length > 10) {
      lines.push(`- ...+${snapshot.files_changed.length - 10} more`);
    }
    lines.push("");
  }
  if (Object.keys(snapshot.tools_summary).length > 0) {
    const topTools = Object.entries(snapshot.tools_summary).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tool, count]) => `${tool}: ${count}`).join(", ");
    lines.push(`> Tools: ${topTools}`);
    lines.push("");
  }
  lines.push("*bookmark \u2014 file tracking snapshot*");
  return lines.join("\n");
}
function formatTokens(value) {
  if (value >= 1e6) return `${value / 1e6}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}K`;
  return String(value);
}
function shortenPath(filePath, projectPath) {
  if (projectPath && filePath.startsWith(projectPath)) {
    return filePath.slice(projectPath.length).replace(/^\//, "");
  }
  return basename3(filePath);
}

// src/trails/writer.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync5, readFileSync as readFileSync6, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join5 } from "node:path";
function writeTrails(storagePath, snapshot) {
  const trailsDir = ensureTrailsDir(storagePath);
  writeFileTrail(trailsDir, snapshot);
}
function writeFileTrail(trailsDir, snapshot) {
  const trailPath = join5(trailsDir, "files.md");
  const fileMap = loadFileEntries(trailPath);
  for (const f of snapshot.files_changed) {
    const shortPath = f.path.startsWith(snapshot.project_path) ? f.path.slice(snapshot.project_path.length).replace(/^\//, "") : f.path;
    const existing = fileMap.get(shortPath);
    if (existing) {
      const ops = /* @__PURE__ */ new Set([...existing.operations, ...f.operations]);
      existing.operations = [...ops];
      existing.lines_changed = Math.max(existing.lines_changed ?? 0, f.lines_changed ?? 0);
      if (f.summary) {
        if (existing.summary) {
          const existingHints = new Set(existing.summary.split(", "));
          const newHints = f.summary.split(", ");
          for (const h of newHints) existingHints.add(h);
          existing.summary = [...existingHints].slice(0, 6).join(", ");
        } else {
          existing.summary = f.summary;
        }
      }
    } else {
      fileMap.set(shortPath, {
        path: shortPath,
        operations: [...f.operations],
        lines_changed: f.lines_changed,
        summary: f.summary
      });
    }
  }
  const files = [...fileMap.values()].sort(
    (a, b) => (b.lines_changed ?? 0) - (a.lines_changed ?? 0)
  );
  const totalLines = files.reduce((sum, f) => sum + (f.lines_changed ?? 0), 0);
  const lines = [];
  lines.push("# File Trail");
  lines.push(`> ${files.length} files, ~${totalLines} lines changed total`);
  lines.push("");
  for (const f of files) {
    const lc = f.lines_changed ? ` ~${f.lines_changed}L` : "";
    let line = `- \`${f.path}\` (${f.operations.join("/")}${lc})`;
    if (f.summary) {
      line += ` \u2014 ${f.summary}`;
    }
    lines.push(line);
  }
  writeFileSync4(trailPath, lines.join("\n"), "utf-8");
  const topFiles = files.filter((f) => f.summary).slice(0, 5).map((f) => ({ path: f.path, summary: f.summary }));
  return { count: files.length, totalLines, topFiles };
}
function loadFileEntries(trailPath) {
  if (!existsSync6(trailPath)) return /* @__PURE__ */ new Map();
  try {
    const content = readFileSync6(trailPath, "utf-8");
    const fileMap = /* @__PURE__ */ new Map();
    for (const line of content.split("\n")) {
      const match = line.match(/^- `(.+?)` \(([^)]+)\)/);
      if (match) {
        const path = match[1];
        const opsStr = match[2];
        const ops = opsStr.replace(/\s*~\d+L/, "").split("/");
        const lcMatch = opsStr.match(/~(\d+)L/);
        const linesChanged = lcMatch ? parseInt(lcMatch[1], 10) : void 0;
        const summaryMatch = line.match(/\) — (.+)$/);
        const summary = summaryMatch ? summaryMatch[1] : void 0;
        fileMap.set(path, { path, operations: ops, lines_changed: linesChanged, summary });
      }
    }
    return fileMap;
  } catch {
    return /* @__PURE__ */ new Map();
  }
}
function ensureTrailsDir(storagePath) {
  const trailsDir = join5(storagePath, "trails");
  if (!existsSync6(trailsDir)) {
    mkdirSync5(trailsDir, { recursive: true });
  }
  return trailsDir;
}

// src/threshold/state.ts
import { readFileSync as readFileSync7, readdirSync as readdirSync3, existsSync as existsSync7, statSync as statSync3 } from "node:fs";
import { join as join7 } from "node:path";

// src/handoff/paths.ts
import { createHash } from "node:crypto";
import { homedir as homedir3 } from "node:os";
import { isAbsolute as isAbsolute2, join as join6, resolve as resolve2 } from "node:path";
var SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,128}$/;
function safeSegment(value) {
  if (SAFE_SEGMENT.test(value) && value !== "." && value !== "..") return value;
  return `h-${createHash("sha256").update(value).digest("hex").slice(0, 32)}`;
}
function getSessionsDir(storagePath) {
  return join6(storagePath, "sessions");
}
function getSessionDir(storagePath, sessionId) {
  return join6(getSessionsDir(storagePath), safeSegment(sessionId));
}
function getSessionStopMarkerPath(storagePath, sessionId) {
  return join6(getSessionDir(storagePath, sessionId), "stop-requested");
}
function getLineageDir(storagePath) {
  return join6(storagePath, "lineage");
}
function lineageKey(options) {
  if (options.pid && options.paneId) return `pane:${options.paneId}:pid:${options.pid}`;
  if (options.pid) return `pid:${options.pid}`;
  if (options.sessionId) return `session:${options.sessionId}`;
  return null;
}
function getLineagePath(storagePath, key) {
  const name = key.split(":").map(safeSegment).join(":");
  return join6(getLineageDir(storagePath), `${name}.json`);
}
function currentPaneId(env = process.env) {
  const pane = env.EASY_TERMINAL_PANE_ID?.trim();
  return pane ? pane : void 0;
}
function currentClaudePid(env = process.env) {
  const pid = env.CLAUDE_PID?.trim();
  return pid ? pid : void 0;
}
function easyTerminalStateDir(env = process.env) {
  const override = env.ET_STATE_DIR?.trim() || env.ET_APP_STATE_DIR?.trim();
  if (override) {
    const expanded = override.startsWith("~/") ? join6(homedir3(), override.slice(2)) : override;
    return isAbsolute2(expanded) ? expanded : resolve2(expanded);
  }
  return join6(homedir3(), "Library", "Application Support", "EasyTerminal");
}
function paneFileName(paneId) {
  return SAFE_SEGMENT.test(paneId) && paneId !== "." && paneId !== ".." ? paneId : null;
}

// src/threshold/state.ts
var STATE_VERSION = "1.0.0";
var MAX_SESSION_HISTORY = 10;
function defaultState() {
  return {
    version: STATE_VERSION,
    session_id: "",
    compaction_count: 0,
    current_threshold: 0.2,
    last_snapshot_time: 0,
    last_event_time: 0,
    snapshot_interval_minutes: 5,
    session_history: []
  };
}
function getStatePath(storagePath) {
  return join7(storagePath, "state.json");
}
function loadState(storagePath) {
  const statePath = getStatePath(storagePath);
  if (!existsSync7(statePath)) {
    return defaultState();
  }
  try {
    const raw = readFileSync7(statePath, "utf-8");
    const parsed = JSON.parse(raw);
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}
function saveState(storagePath, state) {
  writeFileAtomic(getStatePath(storagePath), JSON.stringify(state, null, 2));
}
function loadSessionState(storagePath, sessionId) {
  if (!sessionId) return loadState(storagePath);
  const sessionDir = getSessionDir(storagePath, sessionId);
  if (existsSync7(getStatePath(sessionDir))) return loadState(sessionDir);
  const legacy = loadState(storagePath);
  return {
    ...defaultState(),
    session_id: sessionId,
    snapshot_interval_minutes: legacy.snapshot_interval_minutes
  };
}
function saveSessionState(storagePath, sessionId, state) {
  if (!sessionId) {
    saveState(storagePath, state);
    return;
  }
  saveState(getSessionDir(storagePath, sessionId), state);
}
function loadLatestSessionState(storagePath) {
  const sessionsDir = join7(storagePath, "sessions");
  let newest = null;
  try {
    for (const name of readdirSync3(sessionsDir)) {
      const statePath = join7(sessionsDir, name, "state.json");
      try {
        const mtime = statSync3(statePath).mtimeMs;
        if (!newest || mtime > newest.mtime) newest = { dir: join7(sessionsDir, name), mtime };
      } catch {
      }
    }
  } catch {
  }
  return newest ? loadState(newest.dir) : loadState(storagePath);
}
function incrementCompaction(state, thresholds) {
  const newCount = state.compaction_count + 1;
  const thresholdIndex = Math.min(newCount, thresholds.length - 1);
  return {
    ...state,
    compaction_count: newCount,
    current_threshold: thresholds[thresholdIndex],
    // The first prompt after compaction can still see the final pre-compaction
    // usage record. Keep handled thresholds until a lower usage record proves
    // the new context cycle is active.
    token_thresholds_triggered: state.token_thresholds_triggered
  };
}
function resetForNewSession(state, sessionId, thresholds) {
  const history = [...state.session_history];
  if (state.session_id) {
    const currentEntry = {
      session_id: state.session_id,
      started: state.session_history.find((s) => s.session_id === state.session_id)?.started ?? state.last_event_time,
      ended: Date.now(),
      compaction_count: state.compaction_count,
      snapshots_taken: 0
      // Incremented by incrementSnapshotCount on each capture
    };
    history.unshift(currentEntry);
    if (history.length > MAX_SESSION_HISTORY) {
      history.length = MAX_SESSION_HISTORY;
    }
  }
  return {
    ...state,
    session_id: sessionId,
    compaction_count: 0,
    current_threshold: thresholds[0],
    last_event_time: Date.now(),
    session_history: history,
    token_thresholds_triggered: [],
    latest_model: void 0,
    latest_context_tokens: void 0,
    latest_context_limit_tokens: void 0,
    latest_context_used_pct: void 0,
    latest_context_observed_at: void 0,
    unknown_context_limit_notified_model: void 0
  };
}
function updateSnapshotTime(state) {
  return {
    ...state,
    last_snapshot_time: Date.now(),
    last_event_time: Date.now()
  };
}
function incrementSnapshotCount(state) {
  if (!state.session_id) return state;
  const history = state.session_history.map((entry) => {
    if (entry.session_id === state.session_id) {
      return { ...entry, snapshots_taken: entry.snapshots_taken + 1 };
    }
    return entry;
  });
  return { ...state, session_history: history };
}

// src/snapshot/capture.ts
async function captureSnapshot(options) {
  const config = loadConfig(options.cwd);
  const storagePath = getStoragePath(options.cwd, config);
  const state = loadSessionState(storagePath, options.sessionId);
  const { entries } = parseTranscript(options.transcriptPath);
  const extraction = extractFilesAndTools(entries, { projectPath: options.cwd });
  const snapshotId = generateSnapshotId();
  const priorSnapshot = loadLatestSnapshot(storagePath);
  const snapshot = {
    snapshot_id: snapshotId,
    timestamp: Date.now(),
    session_id: options.sessionId ?? state.session_id ?? "unknown",
    project_path: options.cwd,
    trigger: options.trigger,
    compaction_cycle: state.compaction_count,
    files_changed: extraction.files_changed,
    tools_summary: extraction.tools_summary,
    prior_snapshot_id: priorSnapshot?.snapshot_id,
    context_remaining_pct: options.contextUsage?.remainingFraction,
    context_used_pct: options.contextUsage?.usedFraction,
    token_estimate: options.contextUsage?.usedTokens,
    context_limit_tokens: options.contextUsage?.contextLimitTokens,
    model: options.contextUsage?.model
  };
  const hasContent = snapshot.files_changed.length > 0 || snapshot.trigger === "manual" || snapshot.trigger === "token_threshold";
  if (hasContent) {
    storeSnapshot(storagePath, snapshot);
    const markdown = compressToMarkdown(snapshot);
    writeLatestMd(storagePath, markdown);
    writeTrails(storagePath, snapshot);
    const canonicalFile = join8(getSnapshotsDir(storagePath), `${snapshot.snapshot_id}.json`);
    appendToRegistry(snapshot, canonicalFile);
  }
  const updatedState = updateSnapshotTime(state);
  const finalState = incrementSnapshotCount(updatedState);
  saveSessionState(storagePath, options.sessionId, finalState);
  return snapshot;
}

// src/restore/index.ts
import { existsSync as existsSync10, readFileSync as readFileSync11, statSync as statSync5, unlinkSync as unlinkSync3 } from "node:fs";
import { join as join12 } from "node:path";

// src/trails/reader.ts
import { existsSync as existsSync8, readFileSync as readFileSync8 } from "node:fs";
import { join as join9 } from "node:path";
function readContextMd(storagePath) {
  const contextPath = join9(storagePath, "bookmark.context.md");
  if (!existsSync8(contextPath)) return null;
  try {
    const content = readFileSync8(contextPath, "utf-8");
    if (!content.trim()) return null;
    return content;
  } catch {
    return null;
  }
}

// src/handoff/reset-marker.ts
import { readFileSync as readFileSync9, renameSync as renameSync3, statSync as statSync4 } from "node:fs";
import { join as join10 } from "node:path";

// src/handoff/toggle.ts
var ET_MARKER_MAX_AGE_MS = 10 * 60 * 1e3;
var ET_DRIVING_MAX_AGE_MS = 60 * 1e3;

// src/handoff/reset-marker.ts
function readResetMarker(env = process.env, now = Date.now()) {
  const pane = env.EASY_TERMINAL_PANE_ID?.trim();
  const fileName = pane ? paneFileName(pane) : null;
  if (!fileName) return null;
  const markerPath = join10(easyTerminalStateDir(env), "context-handoff", "resets", `${fileName}.json`);
  try {
    if (now - statSync4(markerPath).mtimeMs > ET_MARKER_MAX_AGE_MS) return null;
    const parsed = JSON.parse(readFileSync9(markerPath, "utf-8"));
    if (typeof parsed.path !== "string" || !parsed.path || typeof parsed.sha256 !== "string" || !parsed.sha256) {
      return null;
    }
    return {
      markerPath,
      path: parsed.path,
      sha256: parsed.sha256.trim().toLowerCase(),
      writtenAt: typeof parsed.written_at === "string" ? parsed.written_at : void 0,
      provider: typeof parsed.provider === "string" ? parsed.provider : void 0
    };
  } catch {
    return null;
  }
}
function consumeResetMarker(marker) {
  try {
    renameSync3(marker.markerPath, `${marker.markerPath}.consumed`);
  } catch {
  }
}

// src/handoff/lineage.ts
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync9, mkdirSync as mkdirSync6, readFileSync as readFileSync10, readdirSync as readdirSync4, renameSync as renameSync4, unlinkSync as unlinkSync2 } from "node:fs";
import { join as join11 } from "node:path";
var INDEX_MARKER = "<!-- BOOKMARK_INDEX generated -->";
function sha256File(path) {
  return createHash2("sha256").update(readFileSync10(path)).digest("hex");
}
function isGeneratedIndex(content) {
  return content.startsWith(INDEX_MARKER);
}
function verifyLine(path, sha) {
  return `Verify first: \`shasum -a 256 '${path}'\` must print ${sha}. If it differs or the file is missing, stop and ask the owner; do not act on it.`;
}
function readLineage(storagePath, key) {
  return parseRecord(getLineagePath(storagePath, key));
}
function listLineage(storagePath) {
  const dir = getLineageDir(storagePath);
  let names;
  try {
    names = readdirSync4(dir).filter((name) => name.endsWith(".json") && !name.startsWith("."));
  } catch {
    return [];
  }
  return names.map((name) => parseRecord(join11(dir, name))).filter((record) => record !== null && existsSync9(record.handoff_path)).sort((a, b) => b.sealed_at.localeCompare(a.sealed_at));
}
function buildHandoffIndex(storagePath, now = /* @__PURE__ */ new Date()) {
  const records = listLineage(storagePath);
  const lines = [
    INDEX_MARKER,
    "# Bookmark handoff index",
    "",
    `Generated ${now.toISOString()}. This file is an index, not a handoff.`,
    "Each session writes its own handoff; resume only from the one linked to your pane or session,",
    "and verify its sha256 before acting on it.",
    ""
  ];
  if (records.length === 0) {
    lines.push("No sealed handoffs.");
  }
  for (const record of records) {
    lines.push(
      `- ${record.sealed_at} (${formatAge(now.getTime() - Date.parse(record.sealed_at))} ago) ${record.key} \xB7 session ${record.session_id} \xB7 pane ${record.pane ?? "none"} \xB7 sha256 ${record.sha256}`,
      `  ${record.handoff_path}`
    );
  }
  return lines.join("\n") + "\n";
}
function parseRecord(path) {
  try {
    const parsed = JSON.parse(readFileSync10(path, "utf-8"));
    if (typeof parsed.session_id !== "string" || typeof parsed.handoff_path !== "string" || typeof parsed.sha256 !== "string" || typeof parsed.sealed_at !== "string") {
      return null;
    }
    return {
      key: parsed.key ?? lineageKey({
        paneId: parsed.pane ?? void 0,
        pid: parsed.pid ?? void 0,
        sessionId: parsed.session_id
      }),
      session_id: parsed.session_id,
      pane: parsed.pane ?? null,
      pid: parsed.pid ?? null,
      handoff_path: parsed.handoff_path,
      sha256: parsed.sha256,
      head: parsed.head ?? null,
      sealed_at: parsed.sealed_at
    };
  } catch {
    return null;
  }
}
function formatAge(ms) {
  const minutes = Math.max(0, Math.round(ms / 6e4));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

// src/restore/index.ts
var STALENESS_HARD_BLOCK_HOURS = 72;
var STALENESS_SOFT_WARN_HOURS = 24;
function restoreContext(options) {
  const config = loadConfig(options.cwd);
  const storagePath = getStoragePath(options.cwd, config);
  const sessionId = options.sessionId;
  const lineageRecords = listLineage(storagePath);
  handleSessionTransition(storagePath, options, config.thresholds);
  const stopRequestedPath = join12(storagePath, ".stop-requested");
  if (existsSync10(stopRequestedPath)) {
    try {
      unlinkSync3(stopRequestedPath);
    } catch {
    }
  }
  if (sessionId) {
    const sessionMarker = getSessionStopMarkerPath(storagePath, sessionId);
    if (existsSync10(sessionMarker)) {
      try {
        unlinkSync3(sessionMarker);
      } catch {
      }
    }
  }
  if (!config.restoreOnSessionStart) return {};
  if (options.source === "resume") return {};
  const env = options.env ?? process.env;
  const source = options.source ?? "startup";
  if (source === "clear") {
    const marker = readResetMarker(env);
    if (marker) {
      const message = buildVerifiedRestoration(
        [
          `[Bookmark: resuming the handoff Easy Terminal named for this pane before the reset]`,
          `Pane: ${env.EASY_TERMINAL_PANE_ID?.trim() ?? "none"}`,
          `Path: ${marker.path}`,
          `sha256: ${marker.sha256}`,
          ...marker.writtenAt ? [`Reset requested: ${marker.writtenAt}${marker.provider ? ` (${marker.provider})` : ""}`] : []
        ],
        marker.path,
        marker.sha256
      );
      consumeResetMarker(marker);
      trackRestore(storagePath, sessionId, message.length);
      touchLastProject(options.cwd);
      return { systemMessage: message };
    }
  }
  if (lineageRecords.length > 0) {
    const paneId = options.paneId ?? currentPaneId(env);
    const pid = options.pid ?? currentClaudePid(env);
    const key = lineageKey({ paneId, pid, sessionId });
    const record = key ? readLineage(storagePath, key) : null;
    if (source === "compact" && record?.session_id !== sessionId) return {};
    const message = record ? buildLineageRestoration(key, record) : [
      `[Bookmark: no handoff is linked to this pane/session (${key ?? "no pane or session id"}); pick one from the list]`,
      "Do not guess. Ask the owner which handoff to resume if none clearly matches, and verify its sha256 first.",
      "",
      buildHandoffIndex(storagePath)
    ].join("\n");
    trackRestore(storagePath, sessionId, message.length);
    touchLastProject(options.cwd);
    return { systemMessage: message };
  }
  const rawContextMd = readContextMd(storagePath);
  if (rawContextMd && !isGeneratedIndex(rawContextMd) && isContextMdUseful(rawContextMd)) {
    const contextPath = join12(storagePath, "bookmark.context.md");
    const { identity, bodyWithoutIdentity } = parseIdentity(rawContextMd);
    if (identity?.scope === "home") {
      const target = followPointer(identity);
      if (target) {
        const targetAge = target.staleness_hours ?? 0;
        if (targetAge >= STALENESS_HARD_BLOCK_HOURS) {
          trackRestore(storagePath, sessionId, 0);
          return { systemMessage: buildHardStalenessMessage(target.canonical_path, targetAge) };
        }
        const { bodyWithoutIdentity: targetBody } = parseIdentity(target.content);
        const header = buildPointerFollowHeader(identity, target.canonical_path, targetAge);
        const message2 = `${header}

${targetBody}`;
        trackRestore(storagePath, sessionId, message2.length);
        if (identity.points_to_canonical) {
          touchLastProject(derivProjectFromCanonical(identity.points_to_canonical));
        }
        return { systemMessage: message2 };
      }
    }
    const ageHours = getAgeHours(contextPath);
    if (ageHours !== null && ageHours >= STALENESS_HARD_BLOCK_HOURS) {
      trackRestore(storagePath, sessionId, 0);
      return { systemMessage: buildHardStalenessMessage(contextPath, ageHours) };
    }
    const mismatchWarning = identity ? validateRepoIdentity(identity, options.cwd) : null;
    const softWarning = ageHours !== null && ageHours >= STALENESS_SOFT_WARN_HOURS ? `[Note: This bookmark context is ${ageHours}h old and may be outdated.]` : null;
    const prefixes = [mismatchWarning, softWarning].filter(Boolean).join("\n\n");
    const message = prefixes ? `${prefixes}

${bodyWithoutIdentity}` : bodyWithoutIdentity;
    trackRestore(storagePath, sessionId, message.length);
    touchLastProject(options.cwd);
    return { systemMessage: message };
  }
  if (rawContextMd && !isGeneratedIndex(rawContextMd)) {
    trackBoilerplateCaught(storagePath, sessionId);
  }
  const snapshotCount = getSnapshotCount(storagePath);
  const latestMd = readLatestMd(storagePath);
  if (latestMd) {
    const message = buildFallbackRestoration(latestMd, snapshotCount);
    trackRestore(storagePath, sessionId, message.length);
    touchLastProject(options.cwd);
    return { systemMessage: message };
  }
  return {};
}
function derivProjectFromCanonical(canonicalPath) {
  const marker = `/.bookmark/`;
  const idx = canonicalPath.lastIndexOf(marker);
  return idx > 0 ? canonicalPath.slice(0, idx) : canonicalPath;
}
function buildLineageRestoration(key, record) {
  const sealedMs = Date.parse(record.sealed_at);
  const ageHours = Number.isFinite(sealedMs) ? Math.round((Date.now() - sealedMs) / (1e3 * 60 * 60)) : null;
  if (ageHours !== null && ageHours >= STALENESS_HARD_BLOCK_HOURS) {
    return buildHardStalenessMessage(record.handoff_path, ageHours);
  }
  const lines = [
    `[Bookmark: resuming the handoff linked to ${key}]`,
    ...ageHours !== null && ageHours >= STALENESS_SOFT_WARN_HOURS ? [`[Note: This handoff was sealed ${ageHours}h ago and may be outdated.]`] : [],
    `Session: ${record.session_id}`,
    `Pane: ${record.pane ?? "none"}`,
    `Path: ${record.handoff_path}`,
    `sha256: ${record.sha256}`,
    `Sealed: ${record.sealed_at}${record.head ? ` at HEAD ${record.head}` : ""}`
  ];
  return buildVerifiedRestoration(lines, record.handoff_path, record.sha256);
}
function buildVerifiedRestoration(headerLines, path, expectedSha) {
  const lines = [...headerLines];
  let body = null;
  if (!existsSync10(path)) {
    lines.push("WARNING: the handoff file is missing.");
  } else {
    try {
      const actual = sha256File(path);
      if (actual !== expectedSha) {
        lines.push(`WARNING: the file's current sha256 is ${actual}, not the sealed ${expectedSha}. It changed after sealing.`);
      }
      body = readFileSync11(path, "utf-8");
    } catch {
      lines.push("WARNING: the handoff file could not be read.");
    }
  }
  lines.push(verifyLine(path, expectedSha));
  return body === null ? lines.join("\n") : `${lines.join("\n")}

${body}`;
}
function trackRestore(storagePath, sessionId, charCount) {
  try {
    const state = loadSessionState(storagePath, sessionId);
    state.restores_performed = (state.restores_performed ?? 0) + 1;
    state.tokens_injected = (state.tokens_injected ?? 0) + Math.round(charCount / 4);
    saveSessionState(storagePath, sessionId, state);
  } catch {
  }
}
function trackBoilerplateCaught(storagePath, sessionId) {
  try {
    const state = loadSessionState(storagePath, sessionId);
    state.boilerplate_caught = (state.boilerplate_caught ?? 0) + 1;
    saveSessionState(storagePath, sessionId, state);
  } catch {
  }
}
function isContextMdUseful(content) {
  if (content.length < 200) return false;
  if (content.startsWith("[Bookmark Context") && !content.includes("## ")) return false;
  const markers = ["## ", "**Task", "**Status", "**Progress", "done", "remaining", "- "];
  return markers.some((m) => content.includes(m));
}
function getAgeHours(path) {
  try {
    const mtime = statSync5(path).mtimeMs;
    return Math.round((Date.now() - mtime) / (1e3 * 60 * 60));
  } catch {
    return null;
  }
}
function buildHardStalenessMessage(path, ageHours) {
  return [
    `[Bookmark: auto-restore BLOCKED \u2014 source is ${ageHours}h stale (threshold ${STALENESS_HARD_BLOCK_HOURS}h).]`,
    "",
    `The bookmark file at ${path} is too old to treat as current context.`,
    "Stale auto-restore creates confident wrong starts \u2014 worse than no restore at all.",
    "",
    "To proceed, either:",
    "- Run `/bookmark:list` and pick a specific snapshot explicitly",
    `- Read the stale file manually if you still want its content: \`cat "${path}"\``,
    "- Ask the user what they were working on most recently"
  ].join("\n");
}
function buildPointerFollowHeader(pointer, canonicalPath, ageHours) {
  const lines = [
    `[Bookmark: followed home-scope pointer \u2192 repo-scope bookmark]`,
    "",
    `Canonical file: ${canonicalPath}`
  ];
  if (pointer.points_to_project) {
    lines.push(`Project: ${pointer.points_to_project}`);
  }
  if (ageHours >= STALENESS_SOFT_WARN_HOURS) {
    lines.push(`Age: ${ageHours}h (approaching staleness threshold of ${STALENESS_HARD_BLOCK_HOURS}h)`);
  }
  return lines.join("\n");
}
function buildFallbackRestoration(latestMd, snapshotCount) {
  const lines = [];
  lines.push("[Bookmark: Context recovered from previous session]");
  lines.push("");
  lines.push(latestMd);
  if (snapshotCount > 1) {
    lines.push("");
    lines.push(`> ${snapshotCount} snapshots available. \`/bookmark:list\` for history.`);
  }
  return lines.join("\n");
}
function handleSessionTransition(storagePath, options, thresholds) {
  const source = options.source ?? "startup";
  const sessionId = options.sessionId ?? `session_${Date.now()}`;
  const state = loadSessionState(storagePath, options.sessionId);
  let updatedState;
  switch (source) {
    case "startup":
    case "clear":
      updatedState = state.session_id === sessionId ? { ...state, current_threshold: thresholds[0], last_event_time: Date.now() } : resetForNewSession(state, sessionId, thresholds);
      break;
    case "compact":
      updatedState = incrementCompaction(state, thresholds);
      updatedState.session_id = sessionId;
      break;
    case "resume":
      updatedState = { ...state, session_id: sessionId, last_event_time: Date.now() };
      break;
    default:
      updatedState = state;
  }
  if (!existsSync10(storagePath)) return;
  saveSessionState(storagePath, options.sessionId, updatedState);
}

// src/mcp/tools.ts
function identityMismatchWarning(storagePath, cwd) {
  const raw = readContextMd(storagePath);
  if (!raw) return null;
  const { identity } = parseIdentity(raw);
  if (!identity) return null;
  return validateRepoIdentity(identity, cwd);
}
function prefixWarning(warning, body) {
  return warning ? `${warning}

${body}` : body;
}
function textResponse(text) {
  return { content: [{ type: "text", text }] };
}
function errorResponse(text) {
  return { content: [{ type: "text", text }], isError: true };
}
var TOOLS = [
  {
    name: "snapshot",
    description: "Capture a context snapshot of the current session. Extracts decisions, open items, file changes, and progress from the transcript. Use before major refactors, before ending a session, or when you want to preserve current context.",
    inputSchema: {
      type: "object",
      properties: {
        trigger: {
          type: "string",
          enum: ["manual", "pre_refactor"],
          description: "Why the snapshot is being taken (default: 'manual')"
        }
      }
    },
    annotations: {
      title: "Capture Snapshot",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    }
  },
  {
    name: "restore",
    description: "Restore context from the latest or a specific snapshot. Returns the session context including intent, progress, decisions, and open items. Use to recover context after compaction or when resuming work.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot_id: {
          type: "string",
          description: "Specific snapshot ID to restore from (default: latest)"
        }
      }
    },
    annotations: {
      title: "Restore Context",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "status",
    description: "Snapshot stats \u2014 count, last capture time, freshness, and storage info. Quick overview of the snapshot inventory.",
    inputSchema: {
      type: "object",
      properties: {}
    },
    annotations: {
      title: "Snapshot Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "list",
    description: "List all snapshots with timestamps, triggers, and context remaining percentage. Most recent first.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of snapshots to return (default: 10)"
        }
      }
    },
    annotations: {
      title: "List Snapshots",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  {
    name: "show",
    description: "Show full snapshot content \u2014 decisions, progress, open items, file changes, and errors. Provides the complete context from a specific or the latest snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        snapshot_id: {
          type: "string",
          description: "Snapshot ID to show (default: latest)"
        }
      }
    },
    annotations: {
      title: "Show Snapshot",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  }
];
async function handleToolCall(name, args) {
  try {
    switch (name) {
      case "snapshot":
        return await handleSnapshot(args);
      case "restore":
        return await handleRestore(args);
      case "status":
        return await handleStatus();
      case "list":
        return await handleList(args);
      case "show":
        return await handleShow(args);
      default:
        return errorResponse(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return errorResponse(
      err instanceof Error ? err.message : "Tool execution failed"
    );
  }
}
async function handleSnapshot(args) {
  const cwd = process.cwd();
  const trigger = args.trigger || "manual";
  const transcriptDir = process.env.CLAUDE_TRANSCRIPT_DIR;
  const sessionId = process.env.CLAUDE_SESSION_ID || "unknown";
  if (!transcriptDir) {
    return errorResponse(
      "Cannot capture snapshot: CLAUDE_TRANSCRIPT_DIR not available. Snapshots require an active Claude Code session with transcript access."
    );
  }
  const fs = await import("fs");
  const path = await import("path");
  let transcriptPath = "";
  try {
    const files = fs.readdirSync(transcriptDir).filter((f) => f.endsWith(".jsonl")).sort().reverse();
    if (files.length > 0) {
      transcriptPath = path.join(transcriptDir, files[0]);
    }
  } catch {
  }
  if (!transcriptPath) {
    return errorResponse(
      "No transcript file found. Snapshots require an active session transcript."
    );
  }
  const snapshot = await captureSnapshot({
    trigger,
    transcriptPath,
    cwd,
    sessionId
  });
  return textResponse(
    [
      `Snapshot captured: ${snapshot.snapshot_id}`,
      `Trigger: ${trigger}`,
      `Files tracked: ${snapshot.files_changed.length}`,
      `Tools: ${Object.keys(snapshot.tools_summary).length}`
    ].join("\n")
  );
}
async function handleRestore(args) {
  const cwd = process.cwd();
  const snapshotId = args.snapshot_id;
  if (snapshotId) {
    const config = loadConfig(cwd);
    const storagePath = getStoragePath(cwd, config);
    const snapshot = loadSnapshot(storagePath, snapshotId);
    if (!snapshot) {
      return errorResponse(`Snapshot "${snapshotId}" not found.`);
    }
    const warning = identityMismatchWarning(storagePath, cwd);
    const markdown = compressToMarkdown(snapshot);
    return textResponse(prefixWarning(warning, markdown));
  }
  const result = restoreContext({
    cwd,
    format: "markdown"
  });
  if (result.systemMessage) {
    return textResponse(result.systemMessage);
  }
  return textResponse("No snapshots found to restore from.");
}
async function handleStatus() {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const storagePath = getStoragePath(cwd, config);
  const count = getSnapshotCount(storagePath);
  const state = loadLatestSessionState(storagePath);
  const latest = loadLatestSnapshot(storagePath);
  const warning = identityMismatchWarning(storagePath, cwd);
  const lines = [`Snapshot inventory: ${count} snapshots`];
  lines.push(`Storage: ${storagePath}`);
  if (latest) {
    const age = Date.now() - latest.timestamp;
    const ageStr = age < 6e4 ? "< 1 minute ago" : age < 36e5 ? `${Math.round(age / 6e4)} minutes ago` : `${Math.round(age / 36e5)} hours ago`;
    lines.push(`Last snapshot: ${ageStr} (${latest.snapshot_id})`);
    lines.push(`Last trigger: ${latest.trigger}`);
  } else {
    lines.push("No snapshots captured yet.");
  }
  lines.push(`Compaction count: ${state.compaction_count}`);
  lines.push(`New-session threshold: ${config.tokenThresholds.map((value) => `${Math.round(value * 100)}% used`).join(", ")} when limit is known`);
  if (state.latest_context_used_pct !== void 0) {
    lines.push(`Latest context usage: ${Math.round(state.latest_context_used_pct * 100)}%`);
    if (state.latest_model) lines.push(`Active model: ${state.latest_model}`);
  } else if (state.latest_model && state.latest_context_tokens !== void 0) {
    lines.push(`Latest context usage: ${state.latest_context_tokens} tokens; context limit unknown`);
    lines.push(`Active model: ${state.latest_model}`);
    lines.push("Required action: bookmark config --context-limit <tokens>");
  }
  lines.push(
    `Snapshot interval: ${state.snapshot_interval_minutes} minutes`
  );
  return textResponse(prefixWarning(warning, lines.join("\n")));
}
async function handleList(args) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const storagePath = getStoragePath(cwd, config);
  const limit = args.limit || 10;
  const snapshots = listSnapshots(storagePath, limit);
  const warning = identityMismatchWarning(storagePath, cwd);
  if (snapshots.length === 0) {
    return textResponse(prefixWarning(warning, `No snapshots found in ${storagePath}.`));
  }
  const projectName = resolveProjectName(cwd);
  const lines = [`Snapshots (${snapshots.length}, most recent first) in ${storagePath}:`];
  for (const s of snapshots) {
    const date = new Date(s.timestamp).toISOString().replace("T", " ").slice(0, 19);
    const ctx = s.context_remaining_pct ? ` | ${Math.round(s.context_remaining_pct * 100)}% ctx` : "";
    lines.push(`- ${s.id} | ${date} | ${s.trigger}${ctx} | ${projectName}`);
  }
  return textResponse(prefixWarning(warning, lines.join("\n")));
}
async function handleShow(args) {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const storagePath = getStoragePath(cwd, config);
  const snapshotId = args.snapshot_id;
  const snapshot = snapshotId ? loadSnapshot(storagePath, snapshotId) : loadLatestSnapshot(storagePath);
  if (!snapshot) {
    return errorResponse(
      snapshotId ? `Snapshot "${snapshotId}" not found.` : "No snapshots found."
    );
  }
  const warning = identityMismatchWarning(storagePath, cwd);
  return textResponse(prefixWarning(warning, compressToMarkdown(snapshot)));
}

// src/mcp/server.ts
var rl = createInterface({ input: process.stdin, terminal: false });
var buffer = "";
rl.on("line", (line) => {
  buffer += line;
  try {
    const msg = JSON.parse(buffer);
    buffer = "";
    handleMessage(msg);
  } catch {
  }
});
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}
var SERVER_INFO = {
  name: "bookmark",
  version: "0.3.2"
};
var CAPABILITIES = {
  tools: {}
};
async function handleMessage(msg) {
  if (msg.jsonrpc !== "2.0") return;
  const { id, method, params } = msg;
  try {
    switch (method) {
      case "initialize": {
        sendResult(id, {
          protocolVersion: "2025-11-25",
          serverInfo: SERVER_INFO,
          capabilities: CAPABILITIES
        });
        break;
      }
      case "notifications/initialized": {
        break;
      }
      case "tools/list": {
        sendResult(id, { tools: TOOLS });
        break;
      }
      case "tools/call": {
        const { name, arguments: args } = params;
        const result = await handleToolCall(name, args || {});
        sendResult(id, result);
        break;
      }
      default: {
        if (id !== void 0) {
          sendError(id, -32601, `Method not found: ${method}`);
        }
      }
    }
  } catch (err) {
    if (id !== void 0) {
      sendError(
        id,
        -32e3,
        err instanceof Error ? err.message : "Internal error"
      );
    }
  }
}
process.stderr.write("Bookmark MCP server started\n");
