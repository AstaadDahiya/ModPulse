/**
 * message.ts — Type contracts for postMessage between Devvit server and WebView client.
 *
 * All communication between the Blocks wrapper (dashboard.tsx) and the
 * React dashboard (webroot/page.html) flows through these typed messages.
 */

// ─── Devvit → WebView ──────────────────────────────────────────────────────

export type DevvitMessage =
  | {
      type: 'initialData';
      data: {
        subredditName: string;
        healthScore: number;
        healthStatus: 'healthy' | 'elevated' | 'critical';
        warmupDaysComplete: number; // 0-7, < 7 means still in warmup
        metrics: {
          postsPerHour: MetricSeries;
          reportsPerHour: MetricSeries;
          newAccountRatio: MetricSeries;
        };
        baseline: BaselineData | null;
        topReportedPosts: ReportedPost[];
        recentAlerts: AlertRecord[];
        lastUpdated: number; // Unix ms
      };
    }
  | {
      type: 'actionResult';
      data: {
        action: string;
        success: boolean;
        message: string;
      };
    };

// ─── WebView → Devvit ──────────────────────────────────────────────────────

export type WebViewMessage =
  | { type: 'webViewReady' }
  | { type: 'lockPost'; data: { postId: string } }
  | { type: 'restrictSubreddit' }
  | { type: 'sendTeamAlert' }
  | { type: 'refreshData' };

// ─── Shared types ───────────────────────────────────────────────────────────

export type MetricSeries = {
  current: number;
  baseline: number;
  status: 'normal' | 'elevated' | 'critical';
  /** Last 24 data points (12 hours at 30-min intervals) for sparkline. */
  history: number[];
};

export type BaselineData = {
  avgPostsPerHour: number;
  avgReportsPerHour: number;
  avgNewAccountRatio: number;
  computedAt: number;
};

export type ReportedPost = {
  postId: string;
  title: string;
  reportCount: number;
  authorName: string;
};

export type AlertRecord = {
  id: string;
  metric: string;
  currentValue: number;
  baselineValue: number;
  timestamp: number;
  resolved: boolean;
};

/**
 * Web view MessageEvent listener data type. The Devvit API wraps all messages
 * from Blocks to the web view.
 */
export type DevvitSystemMessage = {
  data: { message: DevvitMessage };
  /** Reserved type for messages sent via `context.ui.webView.postMessage`. */
  type?: 'devvit-message' | string;
};
