#!/usr/bin/env -S deno run --allow-all

/**
 * GitHub Contribution Stats Collector
 *
 * Finds public repos created by the authenticated user and their organisations
 * during a date range, then counts their issues, discussions, pull requests
 * and main-branch commits in those repos.  Only repos where at least one stat
 * is non-zero are kept.
 *
 * CLI arguments
 *   --start-date  YYYY-MM-DD  Start of range (default: first day of last month)
 *   --end-date    YYYY-MM-DD  End of range   (default: last day of last month)
 *   --output      path        YAML stats file to write; omit for stdout-only mode
 *
 * Environment variables (can be loaded from a .env file via dotenv)
 *   GITHUB_TOKEN  GitHub personal access token (used by gh CLI automatically)
 */

import 'npm:dotenv/config';
import { $, argv } from 'npm:zx';
import { parse as parseYaml, stringify as stringifyYaml } from 'jsr:@std/yaml';
import { buildURLData, sleep } from 'npm:web-utility';
import { readFile, writeFile } from 'node:fs/promises';

$.verbose = true;

// ── Global error handler ──────────────────────────────────────────────────────

globalThis.addEventListener('unhandledrejection', ({ reason }) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// ── Types ─────────────────────────────────────────────────────────────────────

interface RepoStats {
  start: string;
  end: string;
  name: string;
  issues: number;
  discussions: number;
  pull_requests: number;
  commits: number;
}

interface RepoNode {
  nameWithOwner: string;
  createdAt: string;
  isPrivate: boolean;
  defaultBranchRef: { name: string } | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Script lives at .github/scripts/; repo root is two levels up
const ROOT = new URL('../../', import.meta.url).pathname;
const README_FILE = `${ROOT}README.md`;
const README_HEADING = '## GitHub 贡献统计';

// ── Config ────────────────────────────────────────────────────────────────────

const startArg = argv['start-date'] as string | undefined;
const endArg = argv['end-date'] as string | undefined;
const outputArg = argv.output as string | undefined;

function getDateRange(): { start: string; end: string } {
  if (startArg && endArg) return { start: startArg, end: endArg };
  // Default: previous calendar month
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth(); // previous month, 1-indexed (1–12)
  const pad = (n: number) => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${lastDay}`,
  };
}

// ── Date / timestamp helpers ──────────────────────────────────────────────────

/** Returns an ISO-8601 timestamp for the start (`endOfDay=false`) or end (`endOfDay=true`) of a date string. */
const toISOTimestamp = (date: string, endOfDay = false) =>
  endOfDay ? `${date}T23:59:59Z` : `${date}T00:00:00Z`;

// ── GitHub CLI helpers ────────────────────────────────────────────────────────

/** Run a GraphQL query via `gh api graphql`. */
async function gql<T = unknown>(query: string, extraArgs: string[] = []): Promise<T> {
  const result = await $`gh api graphql -f query=${query} ${extraArgs}`;
  return (JSON.parse(result.stdout) as { data: T }).data;
}

/** Rate-limited wrapper for GitHub Search API (30 requests/min max). */
const SEARCH_INTERVAL_S = 2.1;
let _lastSearchAt = 0;

async function ghSearch<T = unknown>(path: string): Promise<T> {
  const elapsedS = (Date.now() - _lastSearchAt) / 1000;
  if (elapsedS < SEARCH_INTERVAL_S) await sleep(SEARCH_INTERVAL_S - elapsedS);
  _lastSearchAt = Date.now();
  const result = await $`gh api ${path}`;
  return JSON.parse(result.stdout) as T;
}

// ── Repo discovery ────────────────────────────────────────────────────────────

const REPOS_QUERY = `
  query($owner: String!, $after: String) {
    repositoryOwner(login: $owner) {
      repositories(
        first: 100
        after: $after
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          nameWithOwner
          createdAt
          isPrivate
          defaultBranchRef { name }
        }
      }
    }
  }
`;

/**
 * Async generator that yields public repos owned by `owner` whose createdAt
 * falls within [since, until].  Both timestamps are ISO-8601 strings.
 */
async function* yieldReposInDateRange(
  owner: string,
  since: string,
  until: string,
): AsyncGenerator<RepoNode> {
  let cursor: string | null = null;
  const sinceDate = new Date(since);
  const untilDate = new Date(until);

  while (true) {
    const args = ['-f', `owner=${owner}`];
    if (cursor) args.push('-f', `after=${cursor}`);

    const data = await gql<{
      repositoryOwner: {
        repositories: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: RepoNode[];
        };
      };
    }>(REPOS_QUERY, args);

    const { nodes, pageInfo } = data.repositoryOwner.repositories;
    let pastRange = false;

    for (const repo of nodes) {
      const created = new Date(repo.createdAt);
      if (created > untilDate) continue; // newer than range, skip
      if (created < sinceDate) { pastRange = true; break; } // older than range, stop
      if (!repo.isPrivate) yield repo; // only yield public repos
    }

    if (pastRange || !pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }
}

// ── Contribution counters ─────────────────────────────────────────────────────

/** Count issues (all states) authored by `login` in `repo` (nameWithOwner) during the period. */
async function countIssues(
  repo: string,
  login: string,
  start: string,
  end: string,
): Promise<number> {
  const data = await ghSearch<{ total_count: number }>(
    `/search/issues?q=repo:${repo}+is:issue+author:${login}+created:${start}..${end}&per_page=1`,
  );
  return data.total_count;
}

/** Count pull-requests (all states) authored by `login` in `repo` during the period. */
async function countPRs(
  repo: string,
  login: string,
  start: string,
  end: string,
): Promise<number> {
  const data = await ghSearch<{ total_count: number }>(
    `/search/issues?q=repo:${repo}+is:pr+author:${login}+created:${start}..${end}&per_page=1`,
  );
  return data.total_count;
}

const DISCUSSIONS_QUERY = `
  query($owner: String!, $name: String!, $after: String) {
    repository(owner: $owner, name: $name) {
      discussions(
        first: 100
        after: $after
        orderBy: { field: CREATED_AT, direction: DESC }
      ) {
        pageInfo { hasNextPage endCursor }
        nodes { author { login } createdAt }
      }
    }
  }
`;

/**
 * Count discussions started by `login` in `owner/name` during the period.
 * Uses GraphQL because the REST search API does not support discussions author filter.
 */
async function countDiscussions(
  owner: string,
  name: string,
  login: string,
  since: string,
  until: string,
): Promise<number> {
  let total = 0;
  let cursor: string | null = null;
  const sinceDate = new Date(toISOTimestamp(since));
  const untilDate = new Date(toISOTimestamp(until, true));

  while (true) {
    const args = ['-f', `owner=${owner}`, '-f', `name=${name}`];
    if (cursor) args.push('-f', `after=${cursor}`);

    const data = await gql<{
      repository: {
        discussions: {
          pageInfo: { hasNextPage: boolean; endCursor: string };
          nodes: { author: { login: string } | null; createdAt: string }[];
        };
      };
    }>(DISCUSSIONS_QUERY, args);

    const { nodes, pageInfo } = data.repository.discussions;
    let pastRange = false;

    for (const d of nodes) {
      const created = new Date(d.createdAt);
      if (created > untilDate) continue;
      if (created < sinceDate) { pastRange = true; break; }
      if (d.author?.login === login) total++;
    }

    if (pastRange || !pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return total;
}

/** Count commits by `login` on `branch` in `owner/name` during the period. */
async function countCommits(
  owner: string,
  name: string,
  branch: string,
  login: string,
  start: string,
  end: string,
): Promise<number> {
  const path =
    `/repos/${owner}/${name}/commits?` +
    buildURLData({
      sha: branch,
      author: login,
      since: toISOTimestamp(start),
      until: toISOTimestamp(end, true),
      per_page: 100,
    });
  const result = await $`gh api --paginate ${path} --jq '.[].sha'`;
  return result.stdout.trim().split('\n').filter(Boolean).length;
}

// ── YAML persistence ──────────────────────────────────────────────────────────

async function loadStats(filePath: string): Promise<RepoStats[]> {
  try {
    const content = await readFile(filePath, 'utf8');
    return (parseYaml(content) as RepoStats[]) ?? [];
  } catch {
    return [];
  }
}

async function saveStats(filePath: string, stats: RepoStats[]): Promise<void> {
  await writeFile(filePath, stringifyYaml(stats));
  console.log(`✅ Saved stats to ${filePath}`);
}

// ── README update ─────────────────────────────────────────────────────────────

/**
 * Generator that yields the lines of the README contribution section.
 *
 * Structure:
 *   ## GitHub 贡献统计          ← fixed H2
 *   <details><summary>YYYY</summary>
 *   ### YYYY                   ← H3 per year (collapsed)
 *   <details><summary>YYYY-MM</summary>
 *   #### YYYY-MM               ← H4 per month (collapsed)
 *   1. [org/repo](https://github.com/org/repo)
 *       - issues: 3
 *   </details>
 *   </details>
 */
function* buildReadmeSectionLines(entries: RepoStats[]): Generator<string> {
  // Group entries by month (YYYY-MM)
  const byMonth = new Map<string, RepoStats[]>();
  for (const entry of entries) {
    const month = entry.start.slice(0, 7);
    const list = byMonth.get(month) ?? [];
    list.push(entry);
    byMonth.set(month, list);
  }

  // Group months by year
  const byYear = new Map<string, string[]>();
  for (const month of byMonth.keys()) {
    const year = month.slice(0, 4);
    const list = byYear.get(year) ?? [];
    list.push(month);
    byYear.set(year, list);
  }

  yield `${README_HEADING}\n`;

  for (const year of [...byYear.keys()].sort().reverse()) {
    yield `\n<details><summary>${year}</summary>\n\n### ${year}\n`;

    for (const month of (byYear.get(year) ?? []).sort().reverse()) {
      yield `\n<details><summary>${month}</summary>\n\n#### ${month}\n\n`;

      let i = 0;
      for (const repo of (byMonth.get(month) ?? [])) {
        i++;
        yield `${i}. [${repo.name}](https://github.com/${repo.name})
    - issues: ${repo.issues}
    - discussions: ${repo.discussions}
    - pull_requests: ${repo.pull_requests}
    - commits: ${repo.commits}
`;
      }

      yield `\n</details>\n`;
    }

    yield `\n</details>\n`;
  }
}

function buildReadmeSection(entries: RepoStats[]): string {
  return [...buildReadmeSectionLines(entries)].join('');
}

async function updateReadme(entries: RepoStats[]): Promise<void> {
  let readme = await readFile(README_FILE, 'utf8');
  const section = buildReadmeSection(entries);

  const idx = readme.indexOf(README_HEADING);
  readme =
    idx !== -1
      ? readme.slice(0, idx) + section
      : readme.trimEnd() + '\n\n' + section;

  await writeFile(README_FILE, readme);
  console.log(`✅ Updated ${README_FILE}`);
}

// ── Main (top-level await) ────────────────────────────────────────────────────

const { start, end } = getDateRange();
console.log(`📅 Date range: ${start} → ${end}`);

// 1. Authenticated user + organisations
const viewerData = await gql<{
  viewer: { login: string; organizations: { nodes: { login: string }[] } };
}>(`{ viewer { login organizations(first: 100) { nodes { login } } } }`);

const login = viewerData.viewer.login;
const orgs = (viewerData.viewer.organizations?.nodes ?? []).map((o) => o.login);

console.log(`👤 User: ${login}`);
if (orgs.length) console.log(`🏢 Orgs: ${orgs.join(', ')}`);

// 2. Collect public repos created during the period
const owners = [login, ...orgs];
const allRepos: RepoNode[] = [];

for (const owner of owners) {
  console.log(`\n🔍 Repos for ${owner} …`);
  try {
    for await (const repo of yieldReposInDateRange(
      owner,
      toISOTimestamp(start),
      toISOTimestamp(end, true),
    )) {
      allRepos.push(repo);
    }
    console.log(`   collected so far: ${allRepos.length}`);
  } catch (e) {
    console.warn(`   ⚠ Could not access repos for ${owner}: ${(e as Error).message}`);
  }
}

console.log(`\n📦 Total new public repos: ${allRepos.length}`);

// 3. Count contributions in each repo; skip repos with all-zero stats
const newEntries: RepoStats[] = [];

for (const repo of allRepos) {
  const [owner, name] = repo.nameWithOwner.split('/');
  const branch = repo.defaultBranchRef?.name ?? '';
  console.log(`\n  📁 ${repo.nameWithOwner} (branch: ${branch || 'none'})`);

  // Search API calls run sequentially to respect the rate limit
  let issues = 0;
  try { issues = await countIssues(repo.nameWithOwner, login, start, end); }
  catch (e) { console.warn(`    ⚠ Issues for ${repo.nameWithOwner}: ${(e as Error).message}`); }

  let prs = 0;
  try { prs = await countPRs(repo.nameWithOwner, login, start, end); }
  catch (e) { console.warn(`    ⚠ PRs for ${repo.nameWithOwner}: ${(e as Error).message}`); }

  // Discussions (GraphQL) and commits (REST paginate) run concurrently
  const [discussionsResult, commitsResult] = await Promise.allSettled([
    countDiscussions(owner, name, login, start, end),
    branch ? countCommits(owner, name, branch, login, start, end) : Promise.resolve(0),
  ]);

  const discussions =
    discussionsResult.status === 'fulfilled'
      ? discussionsResult.value
      : (console.warn(`    ⚠ Discussions for ${owner}/${name}: ${(discussionsResult.reason as Error).message}`), 0);

  const commits =
    commitsResult.status === 'fulfilled'
      ? commitsResult.value
      : (console.warn(`    ⚠ Commits for ${owner}/${name}: ${(commitsResult.reason as Error).message}`), 0);

  console.log(
    `     Issues: ${issues}  PRs: ${prs}  Discussions: ${discussions}  Commits: ${commits}`,
  );

  // Skip repos where the authenticated user made no contributions
  if (issues + prs + discussions + commits === 0) {
    console.log(`     ↳ skipped (all-zero stats)`);
    continue;
  }

  newEntries.push({ start, end, name: repo.nameWithOwner, issues, discussions, pull_requests: prs, commits });
}

// 4. Print summary
console.log('\n📊 Results:');
for (const entry of newEntries) {
  console.log(
    `  ${entry.name}: issues=${entry.issues} discussions=${entry.discussions}` +
    ` pull_requests=${entry.pull_requests} commits=${entry.commits}`,
  );
}

// 5. Persist only when an output file was specified
if (outputArg) {
  const statsFile = outputArg.startsWith('/') ? outputArg : `${ROOT}${outputArg}`;

  // Load existing data, remove stale entries for the same period, then append
  const existing = await loadStats(statsFile);
  const filtered = existing.filter((e) => !(e.start === start && e.end === end));
  const updated = [...filtered, ...newEntries];

  await saveStats(statsFile, updated);
  await updateReadme(updated);
} else {
  console.log('\nℹ️  No --output specified — no files written.');
}
