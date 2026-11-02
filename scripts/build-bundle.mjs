#!/usr/bin/env node
// Build the self-contained plugin runtime in bundle/. It is committed so a
// plugin installed from GitHub runs this repo's code without npm or node_modules.
// Each entry sits two levels deep, like dist/, because the code finds
// package.json and hosts/ by going two directories up from its own file.
// CI rebuilds it and fails if the committed copy differs.
import { build } from 'esbuild';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// esbuild writes module-path comments relative to its working directory, so a
// build run from another folder produced a different bundle (commit d5fb58e
// carried `../../git-folder/bookmark/node_modules/...`). Pin it to the repo root.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const entries = {
  'cli/index': 'src/cli/index.ts',
  'mcp/server': 'src/mcp/server.ts',
};

await build({
  absWorkingDir: repoRoot,
  entryPoints: entries,
  outdir: 'bundle',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  legalComments: 'none',
  logLevel: 'warning',
  banner: {
    // esbuild keeps each entry's own `#!/usr/bin/env node` line above this banner.
    js: "import { createRequire as __bookmarkCreateRequire } from 'node:module';\nconst require = __bookmarkCreateRequire(import.meta.url);",
  },
});
