// Rebuild a curl command from a captured HTTP event (request inspector).

export interface HttpCapture {
  method?: unknown;
  url?: unknown;
  path?: unknown;
  headers?: unknown;
  body?: unknown;
}

function quote(shellWord: string): string {
  return `'${shellWord.replace(/'/g, `'\\''`)}'`;
}

export function buildCurl(capture: HttpCapture, baseUrl: string): string | null {
  if (typeof capture.method !== 'string') return null;
  const url =
    typeof capture.url === 'string'
      ? capture.url
      : typeof capture.path === 'string'
        ? `${baseUrl}${capture.path}`
        : null;
  if (!url) return null;
  const parts = [`curl -X ${capture.method} ${quote(url)}`];
  if (capture.headers !== null && typeof capture.headers === 'object') {
    for (const [name, value] of Object.entries(capture.headers as Record<string, unknown>)) {
      if (['host', 'content-length', 'connection'].includes(name.toLowerCase())) continue;
      if (typeof value !== 'string') continue;
      parts.push(`-H ${quote(`${name}: ${value}`)}`);
    }
  }
  if (capture.body !== undefined) {
    const text = typeof capture.body === 'string' ? capture.body : JSON.stringify(capture.body);
    parts.push(`--data ${quote(text)}`);
  }
  return parts.join(' \\\n  ');
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
