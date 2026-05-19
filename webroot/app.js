const { useState, useEffect, useCallback } = React;
const h = React.createElement;

// ─── Devvit postMessage bridge ──────────────────────────────────────

function postToDevvit(message) {
  window.parent.postMessage(message, '*');
}

// ─── SVG Sparkline (no library needed) ──────────────────────────────

function Sparkline({ data, status }) {
  if (!data || data.length === 0) data = [0];
  const w = 200, ht = 40, pad = 2;
  const min = Math.min(...data);
  const max = Math.max(...data) || 1;
  const range = max - min || 1;
  const points = data.map((v, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * (w - pad * 2);
    const y = pad + (1 - (v - min) / range) * (ht - pad * 2);
    return { x, y };
  });
  const linePath = points.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ',' + p.y).join(' ');
  const areaPath = linePath + ' L' + points[points.length - 1].x + ',' + ht + ' L' + points[0].x + ',' + ht + ' Z';
  const color = status === 'critical' ? '#f85149' : status === 'elevated' ? '#d29922' : '#3fb950';
  const gradId = 'sg-' + status;

  return h('div', { className: 'chart-container' },
    h('svg', { width: '100%', height: ht, viewBox: '0 0 ' + w + ' ' + ht, preserveAspectRatio: 'none' },
      h('defs', null,
        h('linearGradient', { id: gradId, x1: '0', y1: '0', x2: '0', y2: '1' },
          h('stop', { offset: '0%', stopColor: color, stopOpacity: '0.3' }),
          h('stop', { offset: '100%', stopColor: color, stopOpacity: '0.02' })
        )
      ),
      h('path', { d: areaPath, fill: 'url(#' + gradId + ')', stroke: 'none' }),
      h('path', { d: linePath, fill: 'none', stroke: color, strokeWidth: '1.5', strokeLinejoin: 'round' })
    )
  );
}

// ─── Score Ring Component ───────────────────────────────────────────

function ScoreRing({ score, status }) {
  var radius = 34;
  var circumference = 2 * Math.PI * radius;
  var offset = circumference - (score / 100) * circumference;

  return h('div', { className: 'score-ring' },
    h('svg', { width: '80', height: '80', viewBox: '0 0 80 80' },
      h('circle', { className: 'score-bg', cx: '40', cy: '40', r: radius }),
      h('circle', {
        className: 'score-fill ' + status,
        cx: '40', cy: '40', r: radius,
        strokeDasharray: circumference,
        strokeDashoffset: offset
      })
    ),
    h('div', { className: 'score-value' },
      h('div', { className: 'number ' + status }, score),
      h('div', { className: 'label' }, '/100')
    )
  );
}

// ─── Metric Card Component ──────────────────────────────────────────

function MetricCard({ name, unit, current, baseline, status, history }) {
  return h('div', { className: 'metric-card' },
    h('div', { className: 'metric-header' },
      h('span', { className: 'metric-name' }, name),
      h('span', { className: 'status-dot ' + status })
    ),
    h('div', { className: 'metric-value' },
      current,
      h('span', { className: 'metric-unit' }, unit)
    ),
    h('div', { className: 'metric-baseline' }, 'baseline: ' + baseline + unit),
    h(Sparkline, { data: history && history.length > 0 ? history : [0], status: status })
  );
}

// ─── Toast Component ────────────────────────────────────────────────

function Toast({ message, type, visible }) {
  return h('div', { className: 'toast ' + type + (visible ? ' show' : '') },
    type === 'success' ? '✅' : '❌', ' ', message
  );
}

// ─── Warmup Banner Component ────────────────────────────────────────

function WarmupBanner({ daysComplete }) {
  var pct = Math.round((daysComplete / 7) * 100);
  return h('div', { className: 'warmup-banner' },
    h('div', { className: 'warmup-title' }, '⏳ Collecting Baseline Data'),
    h('div', { className: 'warmup-text' },
      'ModPulse needs 7 days to establish reliable baselines. Anomaly detection accuracy will improve as more data is collected.'
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
      h('div', { className: 'progress-bar', style: { flex: 1 } },
        h('div', { className: 'progress-fill', style: { width: pct + '%' } })
      ),
      h('span', { style: { fontSize: '11px', color: '#d29922', fontWeight: 600 } },
        daysComplete + '/7 days'
      )
    )
  );
}

// ─── Main Dashboard App ─────────────────────────────────────────────

function App() {
  var _s1 = useState(null);
  var data = _s1[0], setData = _s1[1];

  var _s2 = useState(true);
  var loading = _s2[0], setLoading = _s2[1];

  var _s3 = useState({ message: '', type: 'success', visible: false });
  var toast = _s3[0], setToast = _s3[1];

  var _s4 = useState('');
  var actionLoading = _s4[0], setActionLoading = _s4[1];

  var showToast = useCallback(function(message, type) {
    type = type || 'success';
    setToast({ message: message, type: type, visible: true });
    setTimeout(function() { setToast(function(t) { return { message: t.message, type: t.type, visible: false }; }); }, 3000);
  }, []);

  useEffect(function() {
    var handler = function(ev) {
      // Devvit wraps messages as: ev.data = { type: 'devvit-message', data: { message: {...} } }
      if (!ev.data || ev.data.type !== 'devvit-message') return;
      var msg = ev.data.data.message;
      if (msg.type === 'initialData') {
        setData(msg.data);
        setLoading(false);
      } else if (msg.type === 'actionResult') {
        setActionLoading('');
        showToast(msg.data.message, msg.data.success ? 'success' : 'error');
      }
    };
    window.addEventListener('message', handler);
    postToDevvit({ type: 'webViewReady' });
    return function() { window.removeEventListener('message', handler); };
  }, [showToast]);

  var handleLockPost = function(postId) {
    setActionLoading('lock-' + postId);
    postToDevvit({ type: 'lockPost', data: { postId: postId } });
  };
  var handleRestrict = function() {
    setActionLoading('restrict');
    postToDevvit({ type: 'restrictSubreddit' });
  };
  var handleAlert = function() {
    setActionLoading('alert');
    postToDevvit({ type: 'sendTeamAlert' });
  };
  var handleRefresh = function() {
    setLoading(true);
    postToDevvit({ type: 'refreshData' });
  };

  if (loading || !data) {
    return h('div', { className: 'loading-screen' },
      h('div', { className: 'loading-spinner' }),
      h('div', { className: 'loading-text' }, 'Loading community health data…')
    );
  }

  var formatTimeAgo = function(ts) {
    var mins = Math.round((Date.now() - ts) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.round(hrs / 24) + 'd ago';
  };

  var statusLabel = { healthy: 'All Systems Normal', elevated: 'Elevated Activity', critical: 'Attention Required' };
  var statusDescription = {
    healthy: 'Community metrics are within normal ranges.',
    elevated: 'Some metrics are above typical levels. Monitor closely.',
    critical: 'Multiple metrics are significantly elevated. Consider taking action.'
  };

  var topPosts = data.topReportedPosts || [];
  var alerts = data.recentAlerts || [];

  return h('div', { className: 'dashboard' },
    // Header
    h('div', { className: 'dashboard-header' },
      h('div', { className: 'dashboard-title' },
        h('span', { className: 'icon' }, '🩺'),
        h('h1', null, 'ModPulse'),
        h('span', { className: 'subreddit-badge' }, 'r/' + data.subredditName)
      ),
      h('span', { className: 'last-updated' }, 'Updated ' + formatTimeAgo(data.lastUpdated))
    ),

    // Warmup Banner
    data.warmupDaysComplete < 7 ? h(WarmupBanner, { daysComplete: data.warmupDaysComplete }) : null,

    // Health Score
    h('div', { className: 'health-score-section ' + data.healthStatus },
      h(ScoreRing, { score: data.healthScore, status: data.healthStatus }),
      h('div', { className: 'score-info' },
        h('h2', null, 'Health Score'),
        h('div', { className: 'status-text ' + data.healthStatus }, statusLabel[data.healthStatus]),
        h('div', { className: 'score-description' }, statusDescription[data.healthStatus])
      )
    ),

    // Metric Cards
    h('div', { className: 'metrics-grid' },
      h(MetricCard, { name: 'Posts/hr', unit: '', current: data.metrics.postsPerHour.current, baseline: data.metrics.postsPerHour.baseline, status: data.metrics.postsPerHour.status, history: data.metrics.postsPerHour.history }),
      h(MetricCard, { name: 'Reports/hr', unit: '', current: data.metrics.reportsPerHour.current, baseline: data.metrics.reportsPerHour.baseline, status: data.metrics.reportsPerHour.status, history: data.metrics.reportsPerHour.history }),
      h(MetricCard, { name: 'New Acc %', unit: '%', current: data.metrics.newAccountRatio.current, baseline: data.metrics.newAccountRatio.baseline, status: data.metrics.newAccountRatio.status, history: data.metrics.newAccountRatio.history })
    ),

    // Top Reported Posts
    topPosts.length > 0 ? h('div', { className: 'reported-posts-section' },
      h('div', { className: 'section-header' }, h('span', { className: 'section-title' }, '🚩 Most Reported Posts')),
      topPosts.map(function(post) {
        return h('div', { className: 'reported-post', key: post.postId },
          h('div', { className: 'report-count' }, post.reportCount),
          h('div', { className: 'post-info' },
            h('div', { className: 'post-title' }, post.title),
            h('div', { className: 'post-author' }, 'u/' + post.authorName)
          ),
          h('button', {
            className: 'lock-btn',
            onClick: function() { handleLockPost(post.postId); },
            disabled: actionLoading === 'lock-' + post.postId
          }, actionLoading === 'lock-' + post.postId ? '…' : '🔒 Lock')
        );
      })
    ) : null,

    // Action Buttons
    h('div', { className: 'actions-bar' },
      h('button', { className: 'action-btn restrict', onClick: handleRestrict, disabled: actionLoading === 'restrict' },
        '🚫 ', actionLoading === 'restrict' ? 'Restricting…' : 'Restrict Sub'
      ),
      h('button', { className: 'action-btn alert', onClick: handleAlert, disabled: actionLoading === 'alert' },
        '📢 ', actionLoading === 'alert' ? 'Sending…' : 'Team Alert'
      ),
      h('button', { className: 'action-btn refresh', onClick: handleRefresh }, '🔄 Refresh')
    ),

    // Recent Alerts
    h('div', { className: 'alerts-section' },
      h('div', { className: 'section-header' }, h('span', { className: 'section-title' }, '⚠️ Recent Alerts')),
      alerts.length > 0 ? alerts.map(function(alert, i) {
        return h('div', { className: 'alert-item', key: alert.id || i },
          h('span', { className: 'alert-icon' }, alert.resolved ? '✅' : '⚠️'),
          h('span', { className: 'alert-text' },
            h('strong', null, alert.metric), ' at ', alert.currentValue, ' (baseline: ', alert.baselineValue, ')'
          ),
          h('span', { className: 'alert-time' }, formatTimeAgo(alert.timestamp))
        );
      }) : h('div', { className: 'empty-state' }, '✅ No alerts — community is healthy!')
    ),

    h(Toast, { message: toast.message, type: toast.type, visible: toast.visible })
  );
}

// ─── Mount React App ────────────────────────────────────────────────
try {
  var root = ReactDOM.createRoot(document.getElementById('root'));
  root.render(h(App, null));
} catch(e) {
  document.getElementById('error-display').style.display = 'block';
  document.getElementById('error-display').textContent = 'Mount error: ' + e.message;
}
