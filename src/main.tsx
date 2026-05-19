/**
 * index.tsx — ModPulse app entry point.
 *
 * Wires together:
 *   1. Devvit.configure() — enables Reddit API + Redis
 *   2. Event triggers — PostSubmit, PostReport, CommentSubmit (event-driven, no polling)
 *   3. Scheduler jobs — metric snapshots (30min), baseline (daily), digest (weekly Monday)
 *   4. Custom post type — WebView wrapper for React dashboard
 *   5. Menu item — "View Community Health"
 *   6. AppInstall trigger — create dashboard post, schedule jobs, send welcome modmail
 */

import { Devvit, useState, useWebView } from '@devvit/public-api';
import type { DevvitMessage, WebViewMessage } from './message.js';
import {
  incrementCounter,
  todayKey,
  currentHourKey,
  getBaseline,
  getRecentSnapshots,
  getTopReportedPosts,
  getRecentAlerts,
  getWarmupDays,
  incrementPostReports,
  setInstallDate,
  setDashboardPostId,
  getDashboardPostId,
  saveSchedulerJobIds,
  getSchedulerJobIds,
  saveAlert,
  clearReportedPosts,
} from './storage.js';
import { collectSnapshot, computeBaseline } from './metrics.js';
import { detectAnomalies, createAlertRecords, calculateHealthScore, getHealthStatus } from './anomaly.js';
import { sendAnomalyAlert, sendWeeklyDigest } from './modmail.js';

// ─── Configure capabilities ────────────────────────────────────────────────

Devvit.configure({
  redditAPI: true,
  redis: true,
});

// ─── Event Triggers (event-driven, zero API polling) ────────────────────────

// PostSubmit — increment hourly post counter
Devvit.addTrigger({
  event: 'PostSubmit',
  onEvent: async (event, context) => {
    try {
      const today = todayKey();
      const hour = currentHourKey();
      await incrementCounter(context, `mp:post_count:${today}:${hour}`);
    } catch (err) {
      console.error('PostSubmit trigger error:', err);
    }
  },
});

// PostReport — increment hourly report counter + track reported post
Devvit.addTrigger({
  event: 'PostReport',
  onEvent: async (event, context) => {
    try {
      const today = todayKey();
      const hour = currentHourKey();
      await incrementCounter(context, `mp:report_count:${today}:${hour}`);

      // Track this post in the reported posts sorted set
      if (event.post) {
        const postId = event.post.id;
        const title = event.post.title ?? 'Untitled';
        const authorName = (event.post as any).authorName ?? (event.post as any).author ?? 'unknown';
        await incrementPostReports(context, postId, title, authorName);
      }
    } catch (err) {
      console.error('PostReport trigger error:', err);
    }
  },
});

// CommentSubmit — track comment volume + new account ratio
Devvit.addTrigger({
  event: 'CommentSubmit',
  onEvent: async (event, context) => {
    try {
      const today = todayKey();
      await incrementCounter(context, `mp:comment_count:${today}`);

      // Check account age — flag if < 7 days old
      if (event.author) {
        try {
          const author = await context.reddit.getUserById(event.author.id);
          if (author && author.createdAt) {
            const ageMs = Date.now() - author.createdAt.getTime();
            const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
            if (ageMs < sevenDaysMs) {
              await incrementCounter(context, `mp:new_acc_comments:${today}`);
            }
          }
        } catch {
          // Silently fail on user lookup — don't block comment processing
        }
      }
    } catch (err) {
      console.error('CommentSubmit trigger error:', err);
    }
  },
});

// ─── Scheduler Jobs ─────────────────────────────────────────────────────────

// Every 30 minutes: collect metrics snapshot + check for anomalies
Devvit.addSchedulerJob({
  name: 'modpulse-collect-metrics',
  onRun: async (_event, context) => {
    try {
      const snapshot = await collectSnapshot(context);
      const baseline = await getBaseline(context);

      if (baseline && baseline.avgPostsPerHour > 0) {
        const anomalies = detectAnomalies(snapshot, baseline);
        if (anomalies.length > 0) {
          // Store alerts
          const alertRecords = createAlertRecords(anomalies);
          for (const alert of alertRecords) {
            await saveAlert(context, alert);
          }
          // Send modmail
          try {
            const subreddit = await context.reddit.getCurrentSubreddit();
            await sendAnomalyAlert(context, anomalies, subreddit.name);
          } catch (mailErr) {
            console.error('Failed to send anomaly modmail:', mailErr);
          }
        }
      }
    } catch (err) {
      console.error('Metric collection job error:', err);
    }
  },
});

// Daily at midnight UTC: recompute 7-day baseline
Devvit.addSchedulerJob({
  name: 'modpulse-compute-baseline',
  onRun: async (_event, context) => {
    try {
      await computeBaseline(context);
      console.log('ModPulse: Daily baseline recomputed.');
    } catch (err) {
      console.error('Baseline computation job error:', err);
    }
  },
});

// Weekly Monday 9am UTC: send digest + clear reported posts
Devvit.addSchedulerJob({
  name: 'modpulse-weekly-digest',
  onRun: async (_event, context) => {
    try {
      const subreddit = await context.reddit.getCurrentSubreddit();
      await sendWeeklyDigest(context, subreddit.name);
      await clearReportedPosts(context);
      console.log('ModPulse: Weekly digest sent.');
    } catch (err) {
      console.error('Weekly digest job error:', err);
    }
  },
});

// ─── Custom Post Type (WebView wrapper) ─────────────────────────────────────

Devvit.addCustomPostType({
  name: 'ModPulse Dashboard',
  height: 'tall',
  render: (context) => {
    const [subredditName] = useState(async () => {
      try {
        const sub = await context.reddit.getCurrentSubreddit();
        return sub.name;
      } catch {
        return 'unknown';
      }
    });

    const webView = useWebView<WebViewMessage, DevvitMessage>({
      url: 'page.html',

      async onMessage(message, webView) {
        switch (message.type) {
          case 'webViewReady':
          case 'refreshData': {
            try {
              // Gather all dashboard data from Redis
              const baseline = await getBaseline(context);
              const recentSnapshots = await getRecentSnapshots(context, 24);
              const topReported = await getTopReportedPosts(context, 3);
              const alerts = await getRecentAlerts(context, 10);
              const warmupDays = await getWarmupDays(context);

              // Get the latest snapshot for current values
              const latestSnapshot = recentSnapshots.length > 0
                ? recentSnapshots[recentSnapshots.length - 1]
                : { timestamp: Date.now(), postsPerHour: 0, reportsPerHour: 0, newAccountRatio: 0 };

              // Calculate health
              const health = calculateHealthScore(latestSnapshot, baseline);

              // Build metric series for sparklines
              const postsHistory = recentSnapshots.map((s) => s.postsPerHour);
              const reportsHistory = recentSnapshots.map((s) => s.reportsPerHour);
              const ratioHistory = recentSnapshots.map((s) => Math.round(s.newAccountRatio * 100));

              webView.postMessage({
                type: 'initialData',
                data: {
                  subredditName: subredditName ?? 'unknown',
                  healthScore: health.score,
                  healthStatus: getHealthStatus(health.score),
                  warmupDaysComplete: warmupDays,
                  metrics: {
                    postsPerHour: {
                      current: latestSnapshot.postsPerHour,
                      baseline: baseline?.avgPostsPerHour ?? 0,
                      status: health.postsStatus,
                      history: postsHistory,
                    },
                    reportsPerHour: {
                      current: latestSnapshot.reportsPerHour,
                      baseline: baseline?.avgReportsPerHour ?? 0,
                      status: health.reportsStatus,
                      history: reportsHistory,
                    },
                    newAccountRatio: {
                      current: Math.round(latestSnapshot.newAccountRatio * 100),
                      baseline: baseline ? Math.round(baseline.avgNewAccountRatio * 100) : 0,
                      status: health.newAccStatus,
                      history: ratioHistory,
                    },
                  },
                  baseline: baseline,
                  topReportedPosts: topReported,
                  recentAlerts: alerts,
                  lastUpdated: Date.now(),
                },
              });
            } catch (err) {
              console.error('Failed to gather dashboard data:', err);
              // Send safe default so WebView always renders
              webView.postMessage({
                type: 'initialData',
                data: {
                  subredditName: subredditName ?? 'unknown',
                  healthScore: 100,
                  healthStatus: 'healthy' as const,
                  warmupDaysComplete: 0,
                  metrics: {
                    postsPerHour: { current: 0, baseline: 0, status: 'normal' as const, history: [0] },
                    reportsPerHour: { current: 0, baseline: 0, status: 'normal' as const, history: [0] },
                    newAccountRatio: { current: 0, baseline: 0, status: 'normal' as const, history: [0] },
                  },
                  baseline: null,
                  topReportedPosts: [],
                  recentAlerts: [],
                  lastUpdated: Date.now(),
                },
              });
            }
            break;
          }

          case 'lockPost': {
            try {
              const post = await context.reddit.getPostById(message.data.postId);
              await post.lock();
              webView.postMessage({
                type: 'actionResult',
                data: { action: 'lockPost', success: true, message: `Post locked: ${post.title}` },
              });
            } catch (err) {
              webView.postMessage({
                type: 'actionResult',
                data: { action: 'lockPost', success: false, message: `Failed to lock post: ${err}` },
              });
            }
            break;
          }

          case 'restrictSubreddit': {
            try {
              const sub = await context.reddit.getCurrentSubreddit();
              await sub.updateSettings({ type: 'restricted' });
              webView.postMessage({
                type: 'actionResult',
                data: { action: 'restrictSubreddit', success: true, message: `r/${sub.name} set to restricted mode.` },
              });
            } catch (err) {
              webView.postMessage({
                type: 'actionResult',
                data: { action: 'restrictSubreddit', success: false, message: `Failed to restrict: ${err}` },
              });
            }
            break;
          }

          case 'sendTeamAlert': {
            try {
              const sub = await context.reddit.getCurrentSubreddit();
              const baseline = await getBaseline(context);
              const recentSnapshots = await getRecentSnapshots(context, 1);
              const latest = recentSnapshots[0];
              const health = latest ? calculateHealthScore(latest, baseline) : { score: 100 };

              await context.reddit.sendPrivateMessage({
                to: `/r/${sub.name}`,
                subject: '📢 ModPulse: Manual Team Alert',
                text: [
                  `A moderator has triggered a manual team alert via ModPulse.`,
                  '',
                  `🩺 **Current Health Score:** ${health.score}/100`,
                  '',
                  latest
                    ? [
                        `📊 **Current Metrics:**`,
                        `  • Posts/hour: ${latest.postsPerHour}`,
                        `  • Reports/hour: ${latest.reportsPerHour}`,
                        `  • New account ratio: ${Math.round(latest.newAccountRatio * 100)}%`,
                      ].join('\n')
                    : 'No metric data available yet.',
                  '',
                  'Please check the ModPulse dashboard for details.',
                ].join('\n'),
              });
              webView.postMessage({
                type: 'actionResult',
                data: { action: 'sendTeamAlert', success: true, message: 'Team alert sent via modmail.' },
              });
            } catch (err) {
              webView.postMessage({
                type: 'actionResult',
                data: { action: 'sendTeamAlert', success: false, message: `Failed to send alert: ${err}` },
              });
            }
            break;
          }

          default:
            console.error(`Unknown WebView message type: ${(message as any).type}`);
        }
      },
    });

    // Blocks preview — shown while WebView loads
    return (
      <vstack grow padding="small">
        <vstack grow alignment="middle center">
          <text size="xlarge" weight="bold">
            🩺 ModPulse
          </text>
          <spacer />
          <text size="medium">Community Health Dashboard</text>
          <spacer />
          <button onPress={() => webView.mount()}>Open Dashboard</button>
        </vstack>
      </vstack>
    );
  },
});

// ─── Menu Item ──────────────────────────────────────────────────────────────

Devvit.addMenuItem({
  label: '🩺 View Community Health',
  location: 'subreddit',
  forUserType: 'moderator',
  onPress: async (_event, context) => {
    const dashboardPostId = await getDashboardPostId(context);
    if (dashboardPostId) {
      context.ui.navigateTo(`https://reddit.com/comments/${dashboardPostId}`);
    } else {
      // Create a new dashboard post if one doesn't exist
      try {
        const subreddit = await context.reddit.getCurrentSubreddit();
        const post = await context.reddit.submitPost({
          title: '🩺 ModPulse — Community Health Dashboard',
          subredditName: subreddit.name,
          preview: (
            <vstack height="100%" width="100%" alignment="center middle" padding="large">
              <text size="xlarge" weight="bold">🩺 ModPulse</text>
              <spacer size="medium" />
              <text size="medium">Loading dashboard…</text>
            </vstack>
          ),
        });
        await setDashboardPostId(context, post.id);
        context.ui.navigateTo(post);
      } catch (err) {
        console.error('Failed to create dashboard post:', err);
        context.ui.showToast('❌ Failed to create dashboard. Please try again.');
      }
    }
  },
});

// ─── AppInstall / AppUpgrade ────────────────────────────────────────────────

async function setupApp(context: any, subredditName: string): Promise<void> {
  // 1. Cancel any existing scheduled jobs (prevent duplicates on reinstall/upgrade)
  try {
    const existingJobs = await getSchedulerJobIds(context);
    for (const jobId of existingJobs) {
      try {
        await context.scheduler.cancelJob(jobId);
      } catch {
        // Job may not exist anymore — ignore
      }
    }
  } catch {
    // No existing jobs — fine
  }

  // 2. Schedule recurring jobs
  const jobIds: string[] = [];
  try {
    const metricsJob = await context.scheduler.runJob({
      name: 'modpulse-collect-metrics',
      cron: '*/30 * * * *', // every 30 min
    });
    jobIds.push(metricsJob);
  } catch (err) {
    console.error('Failed to schedule metrics job:', err);
  }

  try {
    const baselineJob = await context.scheduler.runJob({
      name: 'modpulse-compute-baseline',
      cron: '0 0 * * *', // daily at midnight UTC
    });
    jobIds.push(baselineJob);
  } catch (err) {
    console.error('Failed to schedule baseline job:', err);
  }

  try {
    const digestJob = await context.scheduler.runJob({
      name: 'modpulse-weekly-digest',
      cron: '0 9 * * 1', // Monday 9am UTC
    });
    jobIds.push(digestJob);
  } catch (err) {
    console.error('Failed to schedule digest job:', err);
  }

  // Save job IDs for cleanup on next install/upgrade
  await saveSchedulerJobIds(context, jobIds);

  // 3. Set install date (for warmup tracking — only on first install)
  await setInstallDate(context);

  // 4. Compute an initial baseline (will be zero/empty, but primes the key)
  try {
    await computeBaseline(context);
  } catch {
    // OK if fails on first run
  }
}

Devvit.addTrigger({
  event: 'AppInstall',
  onEvent: async (event, context) => {
    try {
      const subredditName = event.subreddit?.name;
      if (!subredditName) {
        console.error('AppInstall: no subreddit name');
        return;
      }

      await setupApp(context, subredditName);

      // Create dashboard custom post
      try {
        const post = await context.reddit.submitPost({
          title: '🩺 ModPulse — Community Health Dashboard',
          subredditName,
          preview: (
            <vstack height="100%" width="100%" alignment="center middle" padding="large">
              <text size="xlarge" weight="bold">🩺 ModPulse</text>
              <spacer size="medium" />
              <text size="medium">Loading dashboard…</text>
            </vstack>
          ),
        });

        await setDashboardPostId(context, post.id);

        // Pin it
        try {
          await post.sticky();
        } catch {
          console.error('Could not sticky dashboard post (slots may be full)');
        }
      } catch (postErr) {
        console.error('Failed to create dashboard post:', postErr);
      }

      // Send welcome modmail
      try {
        await context.reddit.sendPrivateMessage({
          to: `/r/${subredditName}`,
          subject: '🩺 ModPulse Installed!',
          text: [
            `**ModPulse** has been installed on r/${subredditName}! 🎉`,
            '',
            '**What is ModPulse?**',
            'A real-time community health monitoring dashboard for your mod team. It tracks posts/hour, reports/hour, and new account activity — alerting you automatically when metrics spike.',
            '',
            '**Getting started:**',
            '1. Open the pinned "🩺 ModPulse — Community Health Dashboard" post',
            '2. Click "Open Dashboard" to view real-time metrics',
            '3. Anomaly alerts will be sent via modmail automatically',
            '4. Weekly digests arrive every Monday at 9am UTC',
            '',
            '⏳ **Note:** ModPulse needs ~7 days to build a reliable baseline. During warmup, anomaly detection sensitivity will be limited.',
            '',
            'Happy moderating! 🛡️',
          ].join('\n'),
        });
      } catch {
        console.error('Welcome modmail failed');
      }

      console.log(`ModPulse installed on r/${subredditName}`);
    } catch (err) {
      console.error('AppInstall error:', err);
    }
  },
});

// Handle app upgrades — reschedule jobs without creating new post
Devvit.addTrigger({
  event: 'AppUpgrade',
  onEvent: async (event, context) => {
    try {
      const subredditName = event.subreddit?.name;
      if (!subredditName) return;

      await setupApp(context, subredditName);
      console.log(`ModPulse upgraded on r/${subredditName}`);
    } catch (err) {
      console.error('AppUpgrade error:', err);
    }
  },
});

// ─── Export ─────────────────────────────────────────────────────────────────

export default Devvit;
