#!/usr/bin/env node
'use strict';

/**
 * GitHub Contribution Stats Collector
 *
 * Finds repos created by the authenticated user and their organisations
 * during a given date range, then counts their issues, discussions,
 * pull requests and main-branch commits in those repos.
 *
 * Environment variables
 *   GITHUB_TOKEN   – required; personal access token or Actions token
 *   START_DATE     – YYYY-MM-DD; if omitted, defaults to first day of last month
 *   END_DATE       – YYYY-MM-DD; if omitted, defaults to last day of last month
 *   MANUAL         – set to "true" when triggered manually (stdout only, no file writes)
 */

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GITHUB_TOKEN;
const MANUAL = process.env.MANUAL === 'true';
const ROOT = path.join(__dirname, '..', '..');
const STATS_FILE = path.join(ROOT, 'github-stats.yml');
const README_FILE = path.join(ROOT, 'README.md');

// ── Date helpers ─────────────────────────────────────────────────────────────

function getDateRange() {
  if (process.env.START_DATE && process.env.END_DATE) {
    return { start: process.env.START_DATE, end: process.env.END_DATE };
  }
  // Default: previous calendar month
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 12 : now.getMonth(); // 1-indexed
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${pad(month)}-01`,
    end: `${year}-${pad(month)}-${lastDay}`,
  };
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

async function ghFetch(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub REST ${res.status} – ${url}\n${body}`);
  }
  return res.json();
}

async function graphql(query, variables = {}) {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub GraphQL HTTP ${res.status}\n${body}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    // Surface errors but still return partial data when available
    const msg = json.errors.map(e => e.message).join('; ');
    if (!json.data) throw new Error(`GraphQL error: ${msg}`);
    console.warn(`  ⚠ GraphQL partial error: ${msg}`);
  }
  return json.data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Thin wrapper around ghFetch that enforces the GitHub Search API rate limit
 * (30 authenticated requests/minute = minimum 2 s between calls).
 * The delay is only inserted when the previous search call was recent.
 */
let _lastSearchAt = 0;
async function ghSearchFetch(url) {
  const SEARCH_INTERVAL_MS = 2100;
  const elapsed = Date.now() - _lastSearchAt;
  if (elapsed < SEARCH_INTERVAL_MS) await sleep(SEARCH_INTERVAL_MS - elapsed);
  _lastSearchAt = Date.now();
  return ghFetch(url);
}

// ── Repo discovery ────────────────────────────────────────────────────────────

/**
 * Returns repos owned by `owner` whose createdAt falls within [since, until].
 * Both timestamps are ISO-8601 strings (e.g. "2024-01-01T00:00:00Z").
 */
async function getReposInDateRange(owner, since, until) {
  const repos = [];
  let cursor = null;
  const sinceDate = new Date(since);
  const untilDate = new Date(until);

  while (true) {
    const data = await graphql(
      `query($owner: String!, $after: String) {
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
              defaultBranchRef { name }
            }
          }
        }
      }`,
      { owner, after: cursor },
    );

    const { nodes, pageInfo } = data.repositoryOwner.repositories;
    let pastRange = false;

    for (const repo of nodes) {
      const created = new Date(repo.createdAt);
      if (created > untilDate) continue; // newer than range, skip
      if (created < sinceDate) { pastRange = true; break; } // older than range, stop
      repos.push(repo);
    }

    if (pastRange || !pageInfo.hasNextPage) break;
    cursor = pageInfo.endCursor;
  }

  return repos;
}

// ── Contribution counters ─────────────────────────────────────────────────────

/** Count issues authored by `login` in `repo` (nameWithOwner) during the period. */
async function countIssues(repo, login, start, end) {
  try {
    const data = await ghSearchFetch(
      `https://api.github.com/search/issues?q=repo:${repo}+is:issue+author:${login}+created:${start}..${end}&per_page=1`,
    );
    return data.total_count;
  } catch (e) {
    console.warn(`    ⚠ Issues for ${repo}: ${e.message}`);
    return 0;
  }
}

/** Count pull-requests authored by `login` in `repo` during the period. */
async function countPRs(repo, login, start, end) {
  try {
    const data = await ghSearchFetch(
      `https://api.github.com/search/issues?q=repo:${repo}+is:pr+author:${login}+created:${start}..${end}&per_page=1`,
    );
    return data.total_count;
  } catch (e) {
    console.warn(`    ⚠ PRs for ${repo}: ${e.message}`);
    return 0;
  }
}

/**
 * Count discussions started by `login` in `owner/name` during the period.
 * Uses GraphQL because the REST search API does not support discussions filters.
 */
async function countDiscussions(owner, name, login, since, until) {
  try {
    let total = 0;
    let cursor = null;
    const sinceDate = new Date(`${since}T00:00:00Z`);
    const untilDate = new Date(`${until}T23:59:59Z`);

    while (true) {
      const data = await graphql(
        `query($owner: String!, $name: String!, $after: String) {
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
        }`,
        { owner, name, after: cursor },
      );

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
  } catch (e) {
    console.warn(`    ⚠ Discussions for ${owner}/${name}: ${e.message}`);
    return 0;
  }
}

/** Count commits by `login` on `branch` in `owner/name` during the period. */
async function countCommits(owner, name, branch, login, start, end) {
  if (!branch) return 0;
  try {
    let count = 0;
    let page = 1;
    while (true) {
      const commits = await ghFetch(
        `https://api.github.com/repos/${owner}/${name}/commits` +
        `?sha=${branch}&author=${login}` +
        `&since=${start}T00:00:00Z&until=${end}T23:59:59Z` +
        `&per_page=100&page=${page}`,
      );
      count += commits.length;
      if (commits.length < 100) break;
      page++;
    }
    return count;
  } catch (e) {
    console.warn(`    ⚠ Commits for ${owner}/${name}: ${e.message}`);
    return 0;
  }
}

// ── YAML serialisation (no external deps) ────────────────────────────────────

/**
 * Parses the fixed YAML schema used by github-stats.yml:
 *
 *   "2024":
 *     "2024-01":
 *       repositories: 3
 *       issues: 10
 *       discussions: 2
 *       pull_requests: 5
 *       commits: 42
 */
function parseStatsYaml(content) {
  const result = {};
  let currentYear = null;
  let currentMonth = null;

  for (const raw of content.split('\n')) {
    const line = raw.trimEnd();
    const yearMatch = line.match(/^"?(\d{4})"?:$/);
    if (yearMatch) {
      currentYear = yearMatch[1];
      result[currentYear] = {};
      currentMonth = null;
      continue;
    }
    const monthMatch = line.match(/^  "?(\d{4}-\d{2})"?:$/);
    if (monthMatch && currentYear) {
      currentMonth = monthMatch[1];
      result[currentYear][currentMonth] = {};
      continue;
    }
    const fieldMatch = line.match(/^    (\w+): (\d+)$/);
    if (fieldMatch && currentYear && currentMonth) {
      result[currentYear][currentMonth][fieldMatch[1]] = parseInt(fieldMatch[2], 10);
    }
  }

  return result;
}

function formatStatsYaml(data) {
  const lines = [];
  for (const year of Object.keys(data).sort()) {
    lines.push(`"${year}":`);
    for (const month of Object.keys(data[year]).sort()) {
      lines.push(`  "${month}":`);
      const s = data[year][month];
      for (const key of ['repositories', 'issues', 'discussions', 'pull_requests', 'commits']) {
        lines.push(`    ${key}: ${s[key] ?? 0}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

function upsertStatsFile(month, stats) {
  let data = {};
  if (fs.existsSync(STATS_FILE)) {
    data = parseStatsYaml(fs.readFileSync(STATS_FILE, 'utf8'));
  }
  const year = month.slice(0, 4);
  if (!data[year]) data[year] = {};
  data[year][month] = stats;
  fs.writeFileSync(STATS_FILE, formatStatsYaml(data), 'utf8');
  console.log(`✅ Updated ${STATS_FILE}`);
}

// ── README update ─────────────────────────────────────────────────────────────

const README_HEADING = '## GitHub 贡献统计';

/**
 * Builds the full README section from parsed stats data.
 *
 * Structure (per spec):
 *   ## GitHub 贡献统计          ← fixed H2 at end of README
 *   <details><summary>YYYY</summary>
 *   ### YYYY                   ← H3 per year
 *   <details><summary>YYYY-MM</summary>
 *   #### YYYY-MM               ← H4 per month
 *   … table …
 *   </details>
 *   </details>
 */
function buildReadmeSection(data) {
  let md = `${README_HEADING}\n`;

  for (const year of Object.keys(data).sort().reverse()) {
    md += `\n<details><summary>${year}</summary>\n\n`;
    md += `### ${year}\n`;

    for (const month of Object.keys(data[year]).sort().reverse()) {
      const s = data[year][month];
      md += `\n<details><summary>${month}</summary>\n\n`;
      md += `#### ${month}\n\n`;
      md += `| 指标 | 数量 |\n`;
      md += `|------|------|\n`;
      md += `| 新建仓库 | ${s.repositories ?? 0} |\n`;
      md += `| Issues | ${s.issues ?? 0} |\n`;
      md += `| Discussions | ${s.discussions ?? 0} |\n`;
      md += `| Pull Requests | ${s.pull_requests ?? 0} |\n`;
      md += `| Commits | ${s.commits ?? 0} |\n`;
      md += `\n</details>\n`;
    }

    md += `\n</details>\n`;
  }

  return md;
}

function updateReadme(data) {
  let readme = fs.readFileSync(README_FILE, 'utf8');
  const section = buildReadmeSection(data);

  const idx = readme.indexOf(README_HEADING);
  if (idx !== -1) {
    // Replace existing section
    readme = readme.slice(0, idx) + section;
  } else {
    // Append new section
    readme = readme.trimEnd() + '\n\n' + section;
  }

  fs.writeFileSync(README_FILE, readme, 'utf8');
  console.log(`✅ Updated ${README_FILE}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!TOKEN) {
    console.error('❌ GITHUB_TOKEN environment variable is required');
    process.exit(1);
  }

  const { start, end } = getDateRange();
  console.log(`📅 Date range: ${start} → ${end}`);

  // 1. Authenticated user + organisations
  const { viewer } = await graphql(`{
    viewer {
      login
      organizations(first: 30) {
        nodes { login }
      }
    }
  }`);

  const login = viewer.login;
  const orgs = (viewer.organizations?.nodes ?? []).map(o => o.login);

  console.log(`👤 User: ${login}`);
  if (orgs.length) console.log(`🏢 Orgs: ${orgs.join(', ')}`);

  // 2. Collect repos created during the period
  const owners = [login, ...orgs];
  const allRepos = [];

  for (const owner of owners) {
    console.log(`\n🔍 Repos for ${owner} …`);
    try {
      const repos = await getReposInDateRange(
        owner,
        `${start}T00:00:00Z`,
        `${end}T23:59:59Z`,
      );
      console.log(`   ${repos.length} repo(s) created in range`);
      allRepos.push(...repos);
    } catch (e) {
      console.warn(`   ⚠ Could not access repos for ${owner}: ${e.message}`);
    }
  }

  console.log(`\n📦 Total new repos: ${allRepos.length}`);

  // 3. Count contributions in each repo
  let totalIssues = 0;
  let totalPRs = 0;
  let totalDiscussions = 0;
  let totalCommits = 0;

  for (const repo of allRepos) {
    const [owner, name] = repo.nameWithOwner.split('/');
    const branch = repo.defaultBranchRef?.name;
    console.log(`\n  📁 ${repo.nameWithOwner} (branch: ${branch ?? 'none'})`);

    // Run search-based counters sequentially to respect rate limits;
    // commits use a different endpoint so they can run concurrently.
    const issues = await countIssues(repo.nameWithOwner, login, start, end);
    const prs = await countPRs(repo.nameWithOwner, login, start, end);
    const [discussions, commits] = await Promise.all([
      countDiscussions(owner, name, login, start, end),
      countCommits(owner, name, branch, login, start, end),
    ]);

    console.log(`     Issues: ${issues}  PRs: ${prs}  Discussions: ${discussions}  Commits: ${commits}`);
    totalIssues += issues;
    totalPRs += prs;
    totalDiscussions += discussions;
    totalCommits += commits;
  }

  const result = {
    repositories: allRepos.length,
    issues: totalIssues,
    discussions: totalDiscussions,
    pull_requests: totalPRs,
    commits: totalCommits,
  };

  // 4. Output summary
  console.log('\n📊 Summary:');
  console.log(`   新建仓库 (New repos):  ${result.repositories}`);
  console.log(`   Issues:               ${result.issues}`);
  console.log(`   Discussions:          ${result.discussions}`);
  console.log(`   Pull Requests:        ${result.pull_requests}`);
  console.log(`   Commits (main branch): ${result.commits}`);

  if (MANUAL) {
    console.log('\nℹ️  Manual run — no files written.');
    return;
  }

  // 5. Persist results
  const month = start.slice(0, 7); // "YYYY-MM"
  upsertStatsFile(month, result);

  const statsData = parseStatsYaml(fs.readFileSync(STATS_FILE, 'utf8'));
  updateReadme(statsData);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
