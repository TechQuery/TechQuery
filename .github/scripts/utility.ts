import { $, path, fs } from 'npm:zx';
import WebUtility from 'npm:web-utility';

const { Second, sleep } = WebUtility;

/**
 * Returns an ISO-8601 timestamp for the start or end (`endOfDay=true`) of a date string.
 */
export const toISOTimestamp = (date: string, endOfDay = false) =>
  endOfDay ? `${date}T23:59:59Z` : `${date}T00:00:00Z`;

export async function resolvePath(
  root: string,
  folder: string,
  file: string,
): Promise<string> {
  const absolutePath = path.isAbsolute(folder)
    ? folder
    : path.resolve(root, folder);

  try {
    const stats = await fs.stat(absolutePath);

    return stats.isDirectory()
      ? path.join(absolutePath, file)
      : absolutePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return absolutePath;

    throw error;
  }
}

/**
 * Run a GraphQL query via `gh api graphql`.
 */
export async function gql<T = unknown>(
  query: string,
  extraArgs: string[] = [],
): Promise<T> {
  const result = await $`gh api graphql -f query=${query} ${extraArgs}`;

  return (JSON.parse(result.stdout) as { data: T }).data;
}

// ── Rate-limited Search API wrapper ──────────────────────────────────────────

const SEARCH_INTERVAL_S = 2.1;
let _lastSearchAt = 0;

/**
 * Rate-limited wrapper for GitHub Search API (30 requests/min max).
 */
export async function ghSearch<T = unknown>(path: string): Promise<T> {
  const elapsedS = (Date.now() - _lastSearchAt) / Second;

  if (elapsedS < SEARCH_INTERVAL_S) await sleep(SEARCH_INTERVAL_S - elapsedS);

  _lastSearchAt = Date.now();

  const result = await $`gh api ${path}`;

  return JSON.parse(result.stdout) as T;
}
