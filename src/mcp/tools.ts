/**
 * Bookmark MCP Tool Definitions
 *
 * Each tool maps to existing Bookmark programmatic APIs.
 * Responses are formatted as concise text for LLM consumption.
 */

import { loadConfig, getStoragePath } from "../config.js";
import { captureSnapshot } from "../snapshot/capture.js";
import { compressToMarkdown } from "../snapshot/compress.js";
import {
  loadSnapshot,
  loadLatestSnapshot,
  listSnapshots,
  getSnapshotCount,
} from "../snapshot/storage.js";
import { restoreContext } from "../restore/index.js";
import { loadState } from "../threshold/state.js";
import type { SnapshotTrigger } from "../types.js";

// --- Response helpers ---

function textResponse(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResponse(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

// --- Tool definitions ---

export const TOOLS = [
  {
    name: "snapshot",
    description:
      "Capture a context snapshot of the current session. Extracts decisions, open items, file changes, and progress from the transcript. Use before major refactors, before ending a session, or when you want to preserve current context.",
    inputSchema: {
      type: "object" as const,
      properties: {
        trigger: {
          type: "string",
          enum: ["manual", "pre_refactor"],
          description:
            "Why the snapshot is being taken (default: 'manual')",
        },
      },
    },
    annotations: {
      title: "Capture Snapshot",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "restore",
    description:
      "Restore context from the latest or a specific snapshot. Returns the session context including intent, progress, decisions, and open items. Use to recover context after compaction or when resuming work.",
    inputSchema: {
      type: "object" as const,
      properties: {
        snapshot_id: {
          type: "string",
          description:
            "Specific snapshot ID to restore from (default: latest)",
        },
      },
    },
    annotations: {
      title: "Restore Context",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "status",
    description:
      "Snapshot stats — count, last capture time, freshness, and storage info. Quick overview of the snapshot inventory.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
    annotations: {
      title: "Snapshot Status",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "list",
    description:
      "List all snapshots with timestamps, triggers, and context remaining percentage. Most recent first.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of snapshots to return (default: 10)",
        },
      },
    },
    annotations: {
      title: "List Snapshots",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "show",
    description:
      "Show full snapshot content — decisions, progress, open items, file changes, and errors. Provides the complete context from a specific or the latest snapshot.",
    inputSchema: {
      type: "object" as const,
      properties: {
        snapshot_id: {
          type: "string",
          description: "Snapshot ID to show (default: latest)",
        },
      },
    },
    annotations: {
      title: "Show Snapshot",
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
];

// --- Tool handlers ---

export async function handleToolCall(
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
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

async function handleSnapshot(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const cwd = process.cwd();
  const trigger = (args.trigger as SnapshotTrigger) || "manual";

  // Find the transcript file — look in standard Claude Code location
  const transcriptDir = process.env.CLAUDE_TRANSCRIPT_DIR;
  const sessionId = process.env.CLAUDE_SESSION_ID || "unknown";

  if (!transcriptDir) {
    return errorResponse(
      "Cannot capture snapshot: CLAUDE_TRANSCRIPT_DIR not available. Snapshots require an active Claude Code session with transcript access."
    );
  }

  const fs = await import("fs");
  const path = await import("path");

  // Find the most recent transcript file
  let transcriptPath = "";
  try {
    const files = fs.readdirSync(transcriptDir)
      .filter((f: string) => f.endsWith(".jsonl"))
      .sort()
      .reverse();

    if (files.length > 0) {
      transcriptPath = path.join(transcriptDir, files[0]);
    }
  } catch {
    // Fall back to environment variable
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
    sessionId,
  });

  return textResponse(
    [
      `Snapshot captured: ${snapshot.snapshot_id}`,
      `Trigger: ${trigger}`,
      `Files tracked: ${snapshot.files_changed.length}`,
      `Tools: ${Object.keys(snapshot.tools_summary).length}`,
    ]
      .join("\n")
  );
}

async function handleRestore(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const cwd = process.cwd();
  const snapshotId = args.snapshot_id as string | undefined;

  if (snapshotId) {
    // Load specific snapshot and compress to markdown
    const config = loadConfig(cwd);
    const storagePath = getStoragePath(cwd, config);
    const snapshot = loadSnapshot(storagePath, snapshotId);

    if (!snapshot) {
      return errorResponse(`Snapshot "${snapshotId}" not found.`);
    }

    const markdown = compressToMarkdown(snapshot);
    return textResponse(markdown);
  }

  // Restore latest context using the standard restoration logic
  const result = restoreContext({
    cwd,
    format: "markdown",
  });

  if (result.systemMessage) {
    return textResponse(result.systemMessage);
  }

  return textResponse("No snapshots found to restore from.");
}

async function handleStatus(): Promise<{
  content: Array<{ type: string; text: string }>;
}> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const storagePath = getStoragePath(cwd, config);

  const count = getSnapshotCount(storagePath);
  const state = loadState(storagePath);
  const latest = loadLatestSnapshot(storagePath);

  const lines = [`Snapshot inventory: ${count} snapshots`];

  if (latest) {
    const age = Date.now() - latest.timestamp;
    const ageStr =
      age < 60000
        ? "< 1 minute ago"
        : age < 3600000
          ? `${Math.round(age / 60000)} minutes ago`
          : `${Math.round(age / 3600000)} hours ago`;
    lines.push(`Last snapshot: ${ageStr} (${latest.snapshot_id})`);
    lines.push(`Last trigger: ${latest.trigger}`);
  } else {
    lines.push("No snapshots captured yet.");
  }

  lines.push(`Compaction count: ${state.compaction_count}`);
  lines.push(`Current threshold: ${Math.round(state.current_threshold * 100)}%`);
  lines.push(
    `Snapshot interval: ${state.snapshot_interval_minutes} minutes`
  );

  return textResponse(lines.join("\n"));
}

async function handleList(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const storagePath = getStoragePath(cwd, config);
  const limit = (args.limit as number) || 10;

  const snapshots = listSnapshots(storagePath, limit);

  if (snapshots.length === 0) {
    return textResponse("No snapshots found.");
  }

  const lines = [`Snapshots (${snapshots.length}, most recent first):`];

  for (const s of snapshots) {
    const date = new Date(s.timestamp).toISOString().replace("T", " ").slice(0, 19);
    const ctx = s.context_remaining_pct
      ? ` | ${Math.round(s.context_remaining_pct * 100)}% ctx`
      : "";
    lines.push(`- ${s.id} | ${date} | ${s.trigger}${ctx}`);
  }

  return textResponse(lines.join("\n"));
}

async function handleShow(
  args: Record<string, unknown>
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const cwd = process.cwd();
  const config = loadConfig(cwd);
  const storagePath = getStoragePath(cwd, config);
  const snapshotId = args.snapshot_id as string | undefined;

  const snapshot = snapshotId
    ? loadSnapshot(storagePath, snapshotId)
    : loadLatestSnapshot(storagePath);

  if (!snapshot) {
    return errorResponse(
      snapshotId
        ? `Snapshot "${snapshotId}" not found.`
        : "No snapshots found."
    );
  }

  return textResponse(compressToMarkdown(snapshot));
}
