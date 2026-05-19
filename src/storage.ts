/**
 * storage.ts — Redis helpers for ModPulse.
 *
 * Uses sorted sets for time-series snapshots (not JSON arrays).
 * Uses string counters with TTL for daily metrics.
 * Uses sorted sets for report tracking per post.
 *
 * Redis key layout:
 *   mp:snapshots                 — ZSet: score=timestamp, member=JSON(MetricSnapshot)
 *   mp:baseline                  — String: JSON(BaselineData)
 *   mp:post_count:{YYYY-MM-DD}:{HH} — String: hourly post counter
 *   mp:report_count:{YYYY-MM-DD}:{HH} — String: hourly report counter
 *   mp:comment_count:{YYYY-MM-DD} — String: daily comment counter
 *   mp:new_acc_comments:{YYYY-MM-DD} — String: daily new-account comment counter
 *   mp:reported_posts            — ZSet: score=reportCount, member=postId
 *   mp:reported_post_meta:{id}   — String: JSON({ title, authorName })
 *   mp:alerts                    — ZSet: score=timestamp, member=JSON(AlertRecord)
 *   mp:last_digest               — String: timestamp of last weekly digest
 *   mp:dashboard_post_id         — String: ID of pinned dashboard post
 *   mp:install_date              — String: timestamp of first install
 *   mp:scheduler_jobs            — String: JSON(string[]) list of scheduled job IDs
 */

import type { Context, TriggerContext } from '@devvit/public-api';
import type { AlertRecord, BaselineData, ReportedPost } from './message.js';

// ─── Constants ──────────────────────────────────────────────────────────────

/** 8 days in seconds — TTL for daily/hourly counter keys. */
const COUNTER_TTL_SECONDS = 691200;

/** 7 days in milliseconds. */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Max snapshots to keep (7 days × 48 per day = 336). */
const MAX_SNAPSHOTS = 336;

/** Max alerts to keep in the sorted set. */
const MAX_ALERTS = 100;

// ─── Helpers ────────────────────────────────────────────────────────────────

type RedisContext = Context | TriggerContext;

/** Returns YYYY-MM-DD for the current UTC date. */
export function todayKey(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Returns 2-digit UTC hour string. */
export function currentHourKey(): string {
  return String(new Date().getUTCHours()).padStart(2, '0');
}

/** Generate a unique ID. */
export function newId(): string {
  const hex = '0123456789abcdef';
  let id = '';
  for (let i = 0; i < 32; i++) {
    id += hex[Math.floor(Math.random() * 16)];
  }
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

// ─── Counter operations (with TTL) ─────────────────────────────────────────

/**
 * Increment a counter key and set TTL if it's new.
 * Used for hourly post counts, hourly report counts, daily comment counts.
 */
export async function incrementCounter(ctx: RedisContext, key: string): Promise<number> {
  const newVal = await ctx.redis.incrBy(key, 1);
  // Set TTL on every write — idempotent, refreshes expiry
  await ctx.redis.expire(key, COUNTER_TTL_SECONDS);
  return newVal;
}

/** Read a counter value. Returns 0 if key doesn't exist. */
export async function getCounter(ctx: RedisContext, key: string): Promise<number> {
  const val = await ctx.redis.get(key);
  return val ? parseInt(val, 10) : 0;
}

// ─── Snapshot operations (Sorted Set) ───────────────────────────────────────

export type MetricSnapshot = {
  timestamp: number;
  postsPerHour: number;
  reportsPerHour: number;
  newAccountRatio: number;
};

/** Add a new snapshot to the sorted set. Prunes entries older than 7 days. */
export async function saveSnapshot(ctx: RedisContext, snapshot: MetricSnapshot): Promise<void> {
  const member = JSON.stringify(snapshot);
  await ctx.redis.zAdd('mp:snapshots', { member, score: snapshot.timestamp });

  // Prune entries older than 7 days
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  await ctx.redis.zRemRangeByScore('mp:snapshots', -Infinity, cutoff);
}

/** Get all snapshots from the last 7 days, ordered by timestamp ascending. */
export async function getSnapshots(ctx: RedisContext): Promise<MetricSnapshot[]> {
  const results = await ctx.redis.zRange('mp:snapshots', 0, -1);
  return results.map((r) => JSON.parse(r.member) as MetricSnapshot);
}

/** Get the most recent N snapshots (for sparklines). */
export async function getRecentSnapshots(ctx: RedisContext, count: number): Promise<MetricSnapshot[]> {
  // zRange with reverse to get latest first, then reverse back for chronological order
  const results = await ctx.redis.zRange('mp:snapshots', 0, -1);
  const all = results.map((r) => JSON.parse(r.member) as MetricSnapshot);
  return all.slice(-count);
}

// ─── Baseline operations ────────────────────────────────────────────────────

/** Save the computed 7-day baseline. */
export async function saveBaseline(ctx: RedisContext, baseline: BaselineData): Promise<void> {
  await ctx.redis.set('mp:baseline', JSON.stringify(baseline));
}

/** Get the current baseline. Returns null if not yet computed. */
export async function getBaseline(ctx: RedisContext): Promise<BaselineData | null> {
  const raw = await ctx.redis.get('mp:baseline');
  if (!raw) return null;
  return JSON.parse(raw) as BaselineData;
}

// ─── Reported posts tracking (Sorted Set) ───────────────────────────────────

/** Increment report count for a post. */
export async function incrementPostReports(
  ctx: RedisContext,
  postId: string,
  title: string,
  authorName: string
): Promise<void> {
  // Use zIncrBy to atomically increment the score
  await ctx.redis.zIncrBy('mp:reported_posts', postId, 1);
  // Store post metadata
  await ctx.redis.set(
    `mp:reported_post_meta:${postId}`,
    JSON.stringify({ title, authorName })
  );
  await ctx.redis.expire(`mp:reported_post_meta:${postId}`, COUNTER_TTL_SECONDS);
}

/** Get the top N most-reported posts. */
export async function getTopReportedPosts(ctx: RedisContext, count: number): Promise<ReportedPost[]> {
  // Get highest-scored members (most reports)
  const results = await ctx.redis.zRange('mp:reported_posts', 0, count - 1, { reverse: true, by: 'rank' });
  const posts: ReportedPost[] = [];

  for (const r of results) {
    try {
      const metaRaw = await ctx.redis.get(`mp:reported_post_meta:${r.member}`);
      const meta = metaRaw ? JSON.parse(metaRaw) : { title: 'Unknown post', authorName: 'unknown' };
      posts.push({
        postId: r.member,
        title: meta.title,
        authorName: meta.authorName,
        reportCount: r.score,
      });
    } catch {
      posts.push({
        postId: r.member,
        title: 'Unknown post',
        authorName: 'unknown',
        reportCount: r.score,
      });
    }
  }

  return posts;
}

/** Clear reported posts (weekly reset). */
export async function clearReportedPosts(ctx: RedisContext): Promise<void> {
  await ctx.redis.del('mp:reported_posts');
}

// ─── Alert operations (Sorted Set) ──────────────────────────────────────────

/** Save a new alert to the sorted set. */
export async function saveAlert(ctx: RedisContext, alert: AlertRecord): Promise<void> {
  await ctx.redis.zAdd('mp:alerts', {
    member: JSON.stringify(alert),
    score: alert.timestamp,
  });
  // Prune old alerts (keep last MAX_ALERTS)
  const totalAlerts = await ctx.redis.zCard('mp:alerts');
  if (totalAlerts > MAX_ALERTS) {
    await ctx.redis.zRemRangeByRank('mp:alerts', 0, totalAlerts - MAX_ALERTS - 1);
  }
}

/** Get the most recent N alerts. */
export async function getRecentAlerts(ctx: RedisContext, count: number): Promise<AlertRecord[]> {
  const results = await ctx.redis.zRange('mp:alerts', 0, -1);
  const all = results.map((r) => JSON.parse(r.member) as AlertRecord);
  return all.slice(-count).reverse(); // most recent first
}

/** Get all alerts from the last 7 days (for digest). */
export async function getWeekAlerts(ctx: RedisContext): Promise<AlertRecord[]> {
  const cutoff = Date.now() - SEVEN_DAYS_MS;
  const results = await ctx.redis.zRange('mp:alerts', cutoff, Infinity, { by: 'score' });
  return results.map((r) => JSON.parse(r.member) as AlertRecord);
}

// ─── Install date tracking ──────────────────────────────────────────────────

/** Store the install date (called once on AppInstall). */
export async function setInstallDate(ctx: RedisContext): Promise<void> {
  const existing = await ctx.redis.get('mp:install_date');
  if (!existing) {
    await ctx.redis.set('mp:install_date', Date.now().toString());
  }
}

/** Get the install date. Returns null if not set. */
export async function getInstallDate(ctx: RedisContext): Promise<number | null> {
  const raw = await ctx.redis.get('mp:install_date');
  return raw ? parseInt(raw, 10) : null;
}

/** Calculate how many complete days of data we have (for warmup). */
export async function getWarmupDays(ctx: RedisContext): Promise<number> {
  const installDate = await getInstallDate(ctx);
  if (!installDate) return 0;
  const elapsed = Date.now() - installDate;
  return Math.min(7, Math.floor(elapsed / (24 * 60 * 60 * 1000)));
}

// ─── Dashboard post ID ──────────────────────────────────────────────────────

export async function setDashboardPostId(ctx: RedisContext, postId: string): Promise<void> {
  await ctx.redis.set('mp:dashboard_post_id', postId);
}

export async function getDashboardPostId(ctx: RedisContext): Promise<string | null> {
  const val = await ctx.redis.get('mp:dashboard_post_id');
  return val ?? null;
}

// ─── Last digest tracking ──────────────────────────────────────────────────

export async function getLastDigestTime(ctx: RedisContext): Promise<number | null> {
  const raw = await ctx.redis.get('mp:last_digest');
  return raw ? parseInt(raw, 10) : null;
}

export async function setLastDigestTime(ctx: RedisContext, timestamp: number): Promise<void> {
  await ctx.redis.set('mp:last_digest', timestamp.toString());
}

// ─── Scheduler job tracking (for dedup on reinstall) ────────────────────────

export async function saveSchedulerJobIds(ctx: RedisContext, jobIds: string[]): Promise<void> {
  await ctx.redis.set('mp:scheduler_jobs', JSON.stringify(jobIds));
}

export async function getSchedulerJobIds(ctx: RedisContext): Promise<string[]> {
  const raw = await ctx.redis.get('mp:scheduler_jobs');
  if (!raw) return [];
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}
