#!/usr/bin/env node
// Regenerate hooks/hooks.json (the plugin hooks file shared by the Claude Code
// and Codex plugin surfaces) from hosts/claude.json. Run after `npm run build`:
//   node scripts/gen-plugin-hooks.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginHooksConfig } from '../dist/host/install.js';
import { loadManifest } from '../dist/host/manifest.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
writeFileSync(join(root, 'hooks', 'hooks.json'), JSON.stringify(pluginHooksConfig(loadManifest('claude')), null, 2) + '\n');
