/**
 * anomaly.ts — Anomaly detection with raw floor thresholds.
 *
 * Detection rule: (current > baseline × 2) AND (current > floor)
 * This prevents spam alerts on tiny/new subreddits where baseline ≈ 0.
 *
 * Floors:
 *   - Posts/hour: 10
 *   - Reports/hour: 5
 *   - New account ratio: 0.20 (20%)
 *
 * Health score: 0-100
 *   - Starts at 100
 *   - Each metric deducts points based on deviation from baseline
 *   - Status: normal (<1.5x), elevated (1.5x-2x), critical (>2x)
 */

import type { MetricSnapshot } from './storage.js';
import type { BaselineData, AlertRecord } from './message.js';
import { newId } from './storage.js';

// ─── Floor thresholds ───────────────────────────────────────────────────────

const FLOOR_POSTS_PER_HOUR = 10;
const FLOOR_REPORTS_PER_HOUR = 5;
const FLOOR_NEW_ACCOUNT_RATIO = 0.20;

// ─── Multiplier thresholds ──────────────────────────────────────────────────

const ELEVATED_MULTIPLIER = 1.5;
const CRITICAL_MULTIPLIER = 2.0;

// ─── Status helpers ─────────────────────────────────────────────────────────

type MetricStatus = 'normal' | 'elevated' | 'critical';

function getStatus(current: number, baseline: number): MetricStatus {
  if (baseline <= 0) return 'normal';
  const ratio = current / baseline;
  if (ratio >= CRITICAL_MULTIPLIER) return 'critical';
  if (ratio >= ELEVATED_MULTIPLIER) return 'elevated';
  return 'normal';
}

// ─── Anomaly detection ──────────────────────────────────────────────────────

export type AnomalyResult = {
  metric: string;
  currentValue: number;
  baselineValue: number;
  multiplier: number;
};

/**
 * Detect anomalies: metric exceeds 2x baseline AND exceeds raw floor.
 * Returns an array of detected anomalies (may be empty).
 */
export function detectAnomalies(
  snapshot: MetricSnapshot,
  baseline: BaselineData
): AnomalyResult[] {
  const anomalies: AnomalyResult[] = [];

  // Posts per hour
  if (
    snapshot.postsPerHour > baseline.avgPostsPerHour * CRITICAL_MULTIPLIER &&
    snapshot.postsPerHour > FLOOR_POSTS_PER_HOUR
  ) {
    anomalies.push({
      metric: 'Posts per Hour',
      currentValue: snapshot.postsPerHour,
      baselineValue: baseline.avgPostsPerHour,
      multiplier: baseline.avgPostsPerHour > 0
        ? Math.round((snapshot.postsPerHour / baseline.avgPostsPerHour) * 100) / 100
        : Infinity,
    });
  }

  // Reports per hour
  if (
    snapshot.reportsPerHour > baseline.avgReportsPerHour * CRITICAL_MULTIPLIER &&
    snapshot.reportsPerHour > FLOOR_REPORTS_PER_HOUR
  ) {
    anomalies.push({
      metric: 'Reports per Hour',
      currentValue: snapshot.reportsPerHour,
      baselineValue: baseline.avgReportsPerHour,
      multiplier: baseline.avgReportsPerHour > 0
        ? Math.round((snapshot.reportsPerHour / baseline.avgReportsPerHour) * 100) / 100
        : Infinity,
    });
  }

  // New account ratio
  if (
    snapshot.newAccountRatio > baseline.avgNewAccountRatio * CRITICAL_MULTIPLIER &&
    snapshot.newAccountRatio > FLOOR_NEW_ACCOUNT_RATIO
  ) {
    anomalies.push({
      metric: 'New Account Ratio',
      currentValue: Math.round(snapshot.newAccountRatio * 100),
      baselineValue: Math.round(baseline.avgNewAccountRatio * 100),
      multiplier: baseline.avgNewAccountRatio > 0
        ? Math.round((snapshot.newAccountRatio / baseline.avgNewAccountRatio) * 100) / 100
        : Infinity,
    });
  }

  return anomalies;
}

/**
 * Convert anomaly results into AlertRecord objects for storage.
 */
export function createAlertRecords(anomalies: AnomalyResult[]): AlertRecord[] {
  const now = Date.now();
  return anomalies.map((a) => ({
    id: newId(),
    metric: a.metric,
    currentValue: a.currentValue,
    baselineValue: a.baselineValue,
    timestamp: now,
    resolved: false,
  }));
}

// ─── Health score calculation ───────────────────────────────────────────────

export type HealthResult = {
  score: number;
  postsStatus: MetricStatus;
  reportsStatus: MetricStatus;
  newAccStatus: MetricStatus;
};

/**
 * Calculate community health score (0-100).
 *
 * Scoring:
 *   - Start at 100
 *   - Each elevated metric: -10 points
 *   - Each critical metric: -25 points
 *   - Minimum score: 0
 */
export function calculateHealthScore(
  snapshot: MetricSnapshot,
  baseline: BaselineData | null
): HealthResult {
  if (!baseline) {
    return {
      score: 100,
      postsStatus: 'normal',
      reportsStatus: 'normal',
      newAccStatus: 'normal',
    };
  }

  const postsStatus = getStatus(snapshot.postsPerHour, baseline.avgPostsPerHour);
  const reportsStatus = getStatus(snapshot.reportsPerHour, baseline.avgReportsPerHour);
  const newAccStatus = getStatus(snapshot.newAccountRatio, baseline.avgNewAccountRatio);

  let score = 100;
  const statuses = [postsStatus, reportsStatus, newAccStatus];
  for (const s of statuses) {
    if (s === 'elevated') score -= 10;
    if (s === 'critical') score -= 25;
  }

  return {
    score: Math.max(0, score),
    postsStatus,
    reportsStatus,
    newAccStatus,
  };
}

/**
 * Get overall health status label from score.
 */
export function getHealthStatus(score: number): 'healthy' | 'elevated' | 'critical' {
  if (score >= 70) return 'healthy';
  if (score >= 40) return 'elevated';
  return 'critical';
}
