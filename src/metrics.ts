/**
 * metrics.ts — Event-driven metric collection for ModPulse.
 *
 * No API polling. All data comes from Redis counters populated by triggers:
 *   - PostSubmit → increments hourly post counter
 *   - PostReport → increments hourly report counter
 *   - CommentSubmit → increments daily comment counter + new-account counter
 *
 * The scheduler calls `collectSnapshot()` every 30 min to read current
 * counters and store a MetricSnapshot in the sorted set.
 */

import type { TriggerContext } from '@devvit/public-api';
import type { MetricSnapshot } from './storage.js';
import {
  todayKey,
  currentHourKey,
  getCounter,
  saveSnapshot,
  getSnapshots,
  saveBaseline,
} from './storage.js';
import type { BaselineData } from './message.js';

/**
 * Collect current metrics from Redis counters and store a snapshot.
 * Called every 30 minutes by the scheduler.
 */
export async function collectSnapshot(ctx: TriggerContext): Promise<MetricSnapshot> {
  const today = todayKey();
  const hour = currentHourKey();

  // Read hourly post count for current hour
  const postsThisHour = await getCounter(ctx, `mp:post_count:${today}:${hour}`);

  // Read hourly report count for current hour
  const reportsThisHour = await getCounter(ctx, `mp:report_count:${today}:${hour}`);

  // Read daily comment + new account counts to compute ratio
  const totalComments = await getCounter(ctx, `mp:comment_count:${today}`);
  const newAccComments = await getCounter(ctx, `mp:new_acc_comments:${today}`);
  const newAccountRatio = totalComments > 0 ? newAccComments / totalComments : 0;

  const snapshot: MetricSnapshot = {
    timestamp: Date.now(),
    postsPerHour: postsThisHour,
    reportsPerHour: reportsThisHour,
    newAccountRatio: Math.round(newAccountRatio * 1000) / 1000, // 3 decimal places
  };

  await saveSnapshot(ctx, snapshot);
  return snapshot;
}

/**
 * Compute the 7-day rolling baseline from all stored snapshots.
 * Called daily by the scheduler.
 */
export async function computeBaseline(ctx: TriggerContext): Promise<BaselineData> {
  const snapshots = await getSnapshots(ctx);

  if (snapshots.length === 0) {
    const baseline: BaselineData = {
      avgPostsPerHour: 0,
      avgReportsPerHour: 0,
      avgNewAccountRatio: 0,
      computedAt: Date.now(),
    };
    await saveBaseline(ctx, baseline);
    return baseline;
  }

  const sum = snapshots.reduce(
    (acc, s) => ({
      posts: acc.posts + s.postsPerHour,
      reports: acc.reports + s.reportsPerHour,
      ratio: acc.ratio + s.newAccountRatio,
    }),
    { posts: 0, reports: 0, ratio: 0 }
  );

  const count = snapshots.length;
  const baseline: BaselineData = {
    avgPostsPerHour: Math.round((sum.posts / count) * 100) / 100,
    avgReportsPerHour: Math.round((sum.reports / count) * 100) / 100,
    avgNewAccountRatio: Math.round((sum.ratio / count) * 1000) / 1000,
    computedAt: Date.now(),
  };

  await saveBaseline(ctx, baseline);
  return baseline;
}
