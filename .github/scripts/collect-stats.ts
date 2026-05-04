#!/usr/bin/env -S deno run --allow-all

/**
 * GitHub Contribution Stats Collector
 *
 * Finds public repos created by the authenticated user and their organisations
 * during a date range, then counts their issues, discussions, pull requests,
 * reviewed PRs, review comments and main-branch commits in those repos.
 * Only repos where at least one stat is non-zero are kept.
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
import { $, argv, path } from 'npm:zx';
import WebUtility from 'npm:web-utility';
import { fileURLToPath } from 'node:url';

import { gql, resolvePath, toISOTimestamp } from './utility.ts';
import {
  countCommits,
  countDiscussions,
  countIssues,
  countPRs,
  countReviewComments,
  countReviewedPRs,
  loadStats,
  saveStats,
  type RepoNode,
  type RepoStats,
  updateMarkdown,
  yieldReposInDateRange,
} from './core.ts';

const { changeDate, changeMonth, Day, formatDate, makeDateRange } = WebUtility;

$.verbose = true;

// ── Global error handler ──────────────────────────────────────────────────────

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  process.exit(1);
});

// ── Constants ─────────────────────────────────────────────────────────────────

// Script lives at .github/scripts/; repo root is two levels up
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MARKDOWN_FILE = path.join(ROOT, 'README.md');

// ── Config ────────────────────────────────────────────────────────────────────

const startArg = argv['start-date'] as string | undefined;
const endArg = argv['end-date'] as string | undefined;
const outputArg = argv.output as string | undefined;

function getDateRange(): { start: string; end: string } {
  if (startArg && endArg) return { start: startArg, end: endArg };
  // Default: previous calendar month via web-utility makeDateRange
  const lastMonthDate = changeMonth(new Date(), -1);
  const monthStr = formatDate(lastMonthDate, 'YYYY-MM');
  const [startDate, untilDate] = makeDateRange(monthStr);
  const start = formatDate(startDate, 'YYYY-MM-DD');
  const end = formatDate(changeDate(untilDate, Day, -1), 'YYYY-MM-DD');
  return { start, end };
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ViewerData {
  viewer: {
    login: string;
    organizations: { nodes: { login: string }[] };
  };
}

// ── Main (top-level await) ────────────────────────────────────────────────────

const { start, end } = getDateRange();
console.log(`📅 Date range: ${start} → ${end}`);

// 1. Authenticated user + organisations
const { viewer } = await gql<ViewerData>(
  `{ viewer { login organizations(first: 100) { nodes { login } } } }`,
);

const { login } = viewer;
const orgs = (viewer.organizations?.nodes ?? []).map((o) => o.login);

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
    ))
      allRepos.push(repo);

    console.log(`   collected so far: ${allRepos.length}`);
  } catch (error) {
    console.warn(
      `   ⚠ Could not access repos for ${owner}: ${(error as Error).message}`,
    );
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
  try {
    issues = await countIssues(repo.nameWithOwner, login, start, end);
  } catch (error) {
    console.warn(
      `    ⚠ Issues for ${repo.nameWithOwner}: ${(error as Error).message}`,
    );
  }

  let prs = 0;
  try {
    prs = await countPRs(repo.nameWithOwner, login, start, end);
  } catch (error) {
    console.warn(
      `    ⚠ PRs for ${repo.nameWithOwner}: ${(error as Error).message}`,
    );
  }

  let reviewedPRs = 0;
  try {
    reviewedPRs = await countReviewedPRs(repo.nameWithOwner, login, start, end);
  } catch (error) {
    console.warn(
      `    ⚠ Reviewed PRs for ${repo.nameWithOwner}: ${(error as Error).message}`,
    );
  }

  // Non-search calls run concurrently
  const [discussionsResult, reviewCommentsResult, commitsResult] =
    await Promise.allSettled([
      countDiscussions(owner, name, login, start, end),
      countReviewComments(owner, name, login, start, end),
      branch
        ? countCommits(owner, name, branch, login, start, end)
        : Promise.resolve(0),
    ]);

  let discussions = 0;
  if (discussionsResult.status === 'fulfilled')
    discussions = discussionsResult.value;
  else
    console.warn(
      `    ⚠ Discussions for ${owner}/${name}: ${(discussionsResult.reason as Error).message}`,
    );

  let reviewComments = 0;
  if (reviewCommentsResult.status === 'fulfilled')
    reviewComments = reviewCommentsResult.value;
  else
    console.warn(
      `    ⚠ Review comments for ${owner}/${name}: ${(reviewCommentsResult.reason as Error).message}`,
    );

  let commits = 0;
  if (commitsResult.status === 'fulfilled') commits = commitsResult.value;
  else
    console.warn(
      `    ⚠ Commits for ${owner}/${name}: ${(commitsResult.reason as Error).message}`,
    );

  console.log(
    `     Issues: ${issues}  PRs: ${prs}  Reviewed PRs: ${reviewedPRs}  ` +
      `Review comments: ${reviewComments}  Discussions: ${discussions}  Commits: ${commits}`,
  );

  // Skip repos where the authenticated user made no contributions
  if (
    issues + prs + reviewedPRs + reviewComments + discussions + commits ===
    0
  ) {
    console.log(`     ↳ skipped (all-zero stats)`);
    continue;
  }

  newEntries.push({
    createdAt: repo.createdAt,
    name: repo.nameWithOwner,
    issues,
    discussions,
    pull_requests: prs,
    reviewed_prs: reviewedPRs,
    review_comments: reviewComments,
    commits,
  });
}

// 4. Print summary
console.log('\n📊 Results:');
for (const entry of newEntries) console.table(entry);

// 5. Persist only when an output file was specified
if (outputArg) {
  const statsFile = await resolvePath(ROOT, outputArg, 'github-stats.yml');

  // Load existing data, remove any existing entries for the same repos, then append
  const existing = await loadStats(statsFile);
  const filtered = existing.filter(
    (e) => !newEntries.some((n) => n.name === e.name),
  );
  const updated = [...filtered, ...newEntries];

  await saveStats(statsFile, updated);
  await updateMarkdown(MARKDOWN_FILE, updated);
} else {
  console.log('\nℹ️  No --output specified — no files written.');
}
