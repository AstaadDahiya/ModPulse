/**
 * modmail.ts — Modmail alerts and weekly digest for ModPulse.
 *
 * Two alert types:
 *   1. Anomaly alert — fires immediately when metric > 2x baseline (with floor)
 *   2. Weekly digest — fires Monday 9am UTC summarizing past week
 *
 * Uses `context.reddit.sendPrivateMessage({ to: '/r/subreddit' })` to send
 * modmail to the entire mod team (proven pattern from ModMacros).
 */

import type { TriggerContext } from '@devvit/public-api';
import type { AnomalyResult } from './anomaly.js';
import {
  getSnapshots,
  getWeekAlerts,
  getBaseline,
  setLastDigestTime,
  getWarmupDays,
} from './storage.js';

// ─── Anomaly Alert ──────────────────────────────────────────────────────────

/**
 * Send an anomaly alert modmail to the mod team.
 */
export async function sendAnomalyAlert(
  ctx: TriggerContext,
  anomalies: AnomalyResult[],
  subredditName: string
): Promise<void> {
  if (anomalies.length === 0) return;

  const alertLines = anomalies.map((a) => {
    const pct = a.metric === 'New Account Ratio' ? '%' : '';
    return [
      `📊 **Metric:** ${a.metric}`,
      `📈 **Current Value:** ${a.currentValue}${pct}`,
      `📉 **7-Day Baseline:** ${a.baselineValue}${pct}`,
      `🔺 **Deviation:** ${a.multiplier}x baseline`,
      '',
    ].join('\n');
  });

  const now = new Date();
  const timeStr = now.toUTCString();

  const body = [
    `⚠️ **ModPulse has detected ${anomalies.length > 1 ? 'anomalies' : 'an anomaly'} in r/${subredditName}:**`,
    '',
    ...alertLines,
    `⏰ **Detected at:** ${timeStr}`,
    '',
    '🩺 Open your ModPulse dashboard post to view detailed metrics and take action.',
  ].join('\n');

  try {
    await ctx.reddit.sendPrivateMessage({
      to: `/r/${subredditName}`,
      subject: `🚨 ModPulse Alert: ${anomalies.map((a) => a.metric).join(', ')}`,
      text: body,
    });
  } catch (err) {
    console.error('Failed to send anomaly alert modmail:', err);
  }
}

// ─── Weekly Digest ──────────────────────────────────────────────────────────

/**
 * Send the weekly digest modmail summarizing the past week's activity.
 */
export async function sendWeeklyDigest(
  ctx: TriggerContext,
  subredditName: string
): Promise<void> {
  const warmupDays = await getWarmupDays(ctx);
  const baseline = await getBaseline(ctx);
  const snapshots = await getSnapshots(ctx);
  const alerts = await getWeekAlerts(ctx);

  // Calculate this week's averages
  const weekSnapshots = snapshots.length > 0 ? snapshots : [];
  const avgPosts =
    weekSnapshots.length > 0
      ? weekSnapshots.reduce((s, x) => s + x.postsPerHour, 0) / weekSnapshots.length
      : 0;
  const avgReports =
    weekSnapshots.length > 0
      ? weekSnapshots.reduce((s, x) => s + x.reportsPerHour, 0) / weekSnapshots.length
      : 0;
  const avgRatio =
    weekSnapshots.length > 0
      ? weekSnapshots.reduce((s, x) => s + x.newAccountRatio, 0) / weekSnapshots.length
      : 0;

  // Compute health score for digest
  let healthScore = 100;
  if (baseline) {
    if (avgPosts > baseline.avgPostsPerHour * 2) healthScore -= 25;
    else if (avgPosts > baseline.avgPostsPerHour * 1.5) healthScore -= 10;
    if (avgReports > baseline.avgReportsPerHour * 2) healthScore -= 25;
    else if (avgReports > baseline.avgReportsPerHour * 1.5) healthScore -= 10;
    if (avgRatio > baseline.avgNewAccountRatio * 2) healthScore -= 25;
    else if (avgRatio > baseline.avgNewAccountRatio * 1.5) healthScore -= 10;
  }
  healthScore = Math.max(0, healthScore);

  // Date range
  const endDate = new Date();
  const startDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const dateRange = `${formatDate(startDate)} — ${formatDate(endDate)}`;

  // Build digest body
  const lines: string[] = [
    `🩺 **Community Health Report** — ${dateRange}`,
    '',
  ];

  if (warmupDays < 7) {
    lines.push(`⏳ **Note:** ModPulse has been collecting data for ${warmupDays}/7 days. Baselines are still warming up.`);
    lines.push('');
  }

  lines.push(
    `📊 **Health Score:** ${healthScore}/100`,
    '',
    '📈 **This Week\'s Averages:**',
    `  • Posts/hour: ${avgPosts.toFixed(1)}`,
    `  • Reports/hour: ${avgReports.toFixed(1)}`,
    `  • New account ratio: ${(avgRatio * 100).toFixed(1)}%`,
    '',
  );

  if (alerts.length > 0) {
    lines.push(`⚠️ **Alerts This Week:** ${alerts.length}`);
    for (const alert of alerts.slice(0, 10)) {
      const alertDate = new Date(alert.timestamp);
      lines.push(`  • ${formatDate(alertDate)}: ${alert.metric} — ${alert.currentValue} (baseline: ${alert.baselineValue})`);
    }
  } else {
    lines.push('✅ **No alerts this week** — community activity within normal ranges.');
  }

  lines.push(
    '',
    `📊 **Data Points Collected:** ${weekSnapshots.length} snapshots`,
    '',
    '🩺 Open your ModPulse dashboard post for real-time metrics.',
  );

  try {
    await ctx.reddit.sendPrivateMessage({
      to: `/r/${subredditName}`,
      subject: `📊 ModPulse Weekly Digest — r/${subredditName}`,
      text: lines.join('\n'),
    });
    await setLastDigestTime(ctx, Date.now());
  } catch (err) {
    console.error('Failed to send weekly digest modmail:', err);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatDate(d: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
