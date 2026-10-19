import { readFileSync } from 'node:fs';

// Resolves to apps/api/package.json both from src/ (tsx) and dist/ (node).
const packageJsonUrl = new URL('../package.json', import.meta.url);

function readVersion(): string {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonUrl, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0-dev';
  } catch {
    return '0.0.0-dev';
  }
}

export const API_VERSION = readVersion();
