import { readFileSync } from 'node:fs';

// Keep CLI and MCP metadata consistent with the installed release.
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
export const VERSION = manifest.version;
