import { $, fs } from 'npm:zx';
import { parse as parseYaml, stringify as stringifyYaml } from 'npm:yaml';
import WebUtility from 'npm:web-utility';

import { gql, ghSearch, toISOTimestamp } from './utility.ts';

const { buildURLData } = WebUtility;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RepoStats {
  createdAt: string;
  name: string;
  issues: number;
  discussions: number;
  pull_requests: number;
  reviewed_prs: number;
  review_comments: number;
  commits: number;
}

export interface RepoNode {
  nameWithOwner: string;
  createdAt: string;
  defaultBranchRef: { name: string } | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

export const MARKDOWN_HEADING = '## GitHub 贡献统计';

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
type RepoNodeWithPrivacy = RepoNode & { isPrivate: boolean };

interface ReposQueryData {
  repositoryOwner: {
    repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      nodes: RepoNodeWithPrivacy[];
    };
  };
}

/**
 * Async generator that yields public repos owned by `owner` whose createdAt
 * falls within [since, until].  Both timestamps are ISO-8601 strings.
 */
export async function* yieldReposInDateRange(
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

    const { repositoryOwner } = await gql<ReposQueryData>(REPOS_QUERY, args);
    const { nodes, pageInfo } = repositoryOwner.repositories;
    let pastRange = false;

    for (const repo of nodes) {
      const created = new Date(repo.createdAt);
      if (created > untilDate) continue; // newer than range, skip
      if (created < sinceDate) {
        pastRange = true;
        break;
      } // older than range, stop
      if (!repo.isPrivate) yield repo; // only yield public repos
    }
    if (pastRange || !pageInfo.hasNextPage) break;

    cursor = pageInfo.endCursor;
  }
}

// ── Contribution counters ─────────────────────────────────────────────────────

/** Count issues (all states) authored by `login` in `repo` (nameWithOwner) during the period. */
export async function countIssues(
  repo: string,
  login: string,
  start: string,
  end: string,
): Promise<number> {
  const { total_count } = await ghSearch<{ total_count: number }>(
    `/search/issues?${buildURLData({
      q: `repo:${repo} is:issue author:${login} created:${start}..${end}`,
      per_page: 1,
    })}`,
  );
  return total_count;
}

/** Count pull-requests (all states) authored by `login` in `repo` during the period. */
export async function countPRs(
  repo: string,
  login: string,
  start: string,
  end: string,
): Promise<number> {
  const { total_count } = await ghSearch<{ total_count: number }>(
    `/search/issues?${buildURLData({
      q: `repo:${repo} is:pr author:${login} created:${start}..${end}`,
      per_page: 1,
    })}`,
  );
  return total_count;
}

/** Count pull-requests (all states) reviewed by `login` in `repo` during the period. */
export async function countReviewedPRs(
  repo: string,
  login: string,
  start: string,
  end: string,
): Promise<number> {
  const { total_count } = await ghSearch<{ total_count: number }>(
    `/search/issues?${buildURLData({
      q: `repo:${repo} is:pr reviewed-by:${login} created:${start}..${end}`,
      per_page: 1,
    })}`,
  );
  return total_count;
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
interface DiscussionNode {
  author: { login: string } | null;
  createdAt: string;
}

interface DiscussionsQueryData {
  repository: {
    discussions: {
      pageInfo: { hasNextPage: boolean; endCursor: string };
      nodes: DiscussionNode[];
    };
  };
}

/**
 * Count discussions started by `login` in `owner/name` during the period.
 * Uses GraphQL because the REST search API does not support discussions author filter.
 */
export async function countDiscussions(
  owner: string,
  name: string,
  login: string,
  since: string,
  until: string,
): Promise<number> {
  const sinceDate = new Date(toISOTimestamp(since));
  const untilDate = new Date(toISOTimestamp(until, true));
  let total = 0;
  let cursor: string | null = null;

  while (true) {
    const args = ['-f', `owner=${owner}`, '-f', `name=${name}`];
    if (cursor) args.push('-f', `after=${cursor}`);

    const { repository } = await gql<DiscussionsQueryData>(
      DISCUSSIONS_QUERY,
      args,
    );
    const { nodes, pageInfo } = repository.discussions;
    let pastRange = false;

    for (const d of nodes) {
      const created = new Date(d.createdAt);
      if (created > untilDate) continue;
      if (created < sinceDate) {
        pastRange = true;
        break;
      }
      if (d.author?.login === login) total++;
    }
    if (pastRange || !pageInfo.hasNextPage) break;

    cursor = pageInfo.endCursor;
  }

  return total;
}

/** Count pull-request review comments by `login` in `owner/name` during the period. */
export async function countReviewComments(
  owner: string,
  name: string,
  login: string,
  start: string,
  end: string,
): Promise<number> {
  const path = `/repos/${owner}/${name}/pulls/comments?${buildURLData({
    since: toISOTimestamp(start),
    per_page: 100,
  })}`;
  const jqFilter = `.[] | select(.user.login == "${login}" and .created_at <= "${toISOTimestamp(end, true)}") | .id`;

  const result = await $`gh api --paginate ${path} --jq ${jqFilter}`;

  return result.stdout.trim().split('\n').filter(Boolean).length;
}

/** Count commits by `login` on `branch` in `owner/name` during the period. */
export async function countCommits(
  owner: string,
  name: string,
  branch: string,
  login: string,
  start: string,
  end: string,
): Promise<number> {
  const path = `/repos/${owner}/${name}/commits?${buildURLData({
    sha: branch,
    author: login,
    since: toISOTimestamp(start),
    until: toISOTimestamp(end, true),
    per_page: 100,
  })}`;
  const result = await $`gh api --paginate ${path} --jq '.[].sha'`;

  return result.stdout.trim().split('\n').filter(Boolean).length;
}

// ── YAML persistence ──────────────────────────────────────────────────────────

export async function loadStats(filePath: string): Promise<RepoStats[]> {
  try {
    const content = await fs.readFile(filePath, 'utf8');

    return (parseYaml(content) as RepoStats[]) ?? [];
  } catch {
    return [];
  }
}

export async function saveStats(
  filePath: string,
  stats: RepoStats[],
): Promise<void> {
  const sorted = stats.toSorted((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  await fs.writeFile(filePath, stringifyYaml(sorted));

  console.log(`✅ Saved stats to ${filePath}`);
}

// ── Markdown section builder ──────────────────────────────────────────────────

/**
 * Generator that yields the blocks of the Markdown contribution section.
 * Blocks are separated by `\n\n` when joined.
 *
 * Structure:
 *   ## GitHub 贡献统计
 *   <details><summary>YYYY</summary>
 *   ### YYYY
 *   <details><summary>YYYY-MM</summary>
 *   #### YYYY-MM
 *   1. [org/repo](https://github.com/org/repo)
 *       - issues: 3
 *   </details>
 *   </details>
 */
export function* buildMarkdownSectionLines(
  entries: RepoStats[],
): Generator<string> {
  // Group entries by month (YYYY-MM)
  const byMonth = new Map<string, RepoStats[]>();

  for (const entry of entries) {
    const month = entry.createdAt.slice(0, 7);
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

  yield MARKDOWN_HEADING;

  for (const year of [...byYear.keys()].sort().reverse()) {
    yield `<details><summary>${year}</summary>

### ${year}`;

    for (const month of (byYear.get(year) ?? []).sort().reverse()) {
      yield `<details><summary>${month}</summary>

#### ${month}`;

      for (const [i, repo] of (byMonth.get(month) ?? []).entries())
        yield `${i + 1}. [${repo.name}](https://github.com/${repo.name})
    - issues: ${repo.issues}
    - discussions: ${repo.discussions}
    - pull_requests: ${repo.pull_requests}
    - reviewed_prs: ${repo.reviewed_prs}
    - review_comments: ${repo.review_comments}
    - commits: ${repo.commits}`;

      yield '</details>';
    }

    yield '</details>';
  }
}

export async function updateMarkdown(
  filePath: string,
  entries: RepoStats[],
): Promise<void> {
  let markdown = await fs.readFile(filePath, 'utf8');

  const section = [...buildMarkdownSectionLines(entries)].join('\n\n');

  const index = markdown.indexOf(MARKDOWN_HEADING);
  markdown =
    index !== -1
      ? markdown.slice(0, index) + section
      : markdown.trimEnd() + '\n\n' + section;

  await fs.writeFile(filePath, markdown);

  console.log(`✅ Updated ${filePath}`);
}
