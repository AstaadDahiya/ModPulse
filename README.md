# 🩺 ModPulse

> A real-time, event-driven community health monitoring dashboard and moderation suite built natively on Reddit Devvit.

ModPulse empowers subreddit moderators by turning community activity metrics from a "black box" into real-time, actionable insights. By monitoring key activity indicators and automatically alerting the team when spikes occur, ModPulse acts as an early warning system against brigades, spam waves, and toxic comment raids.

---

## 🚀 Key Features

* **🩺 Health Score (0-100)**: A clean, intuitive dashboard score calculated dynamically based on current subreddit activity compared against a rolling 7-day baseline.
* **⚡ Event-Driven (Zero API Polling)**: ModPulse intercepts activity at the source using native Devvit triggers (`PostSubmit`, `PostReport`, `CommentSubmit`) to increment counters in Redis. This ensures high efficiency with absolutely zero background polling API overhead.
* **🔍 Smart Anomaly Detection**: Triggers automated Modmail alerts to the mod team if any metric exceeds **2x its 7-day baseline**. Features a built-in "raw floor" threshold to prevent spam alerts on smaller or newly created subreddits.
* **🔒 Actionable Mod Tools**: Moderate directly from the dashboard:
  * **Lock** highly-reported posts with one click.
  * **Restrict** the subreddit to restricted mode during a brigade.
  * **Alert** the entire mod team manually with current live status.
* **📊 Weekly Digests**: Sends a digest Modmail every Monday at 9:00 AM UTC summarizing the past week's community metrics and health trends.

---

## 🛠️ Architecture

ModPulse is built with performance and Reddit's platform constraints in mind:

```
[Reddit Triggers] ──► [Redis Sorted Sets] ──► [Scheduler Jobs] ──► [Anomaly Alerts]
  (Post/Comment)       (Time-series storage)   (30-min snapshots)    (Auto Modmail)
         │                                                                 │
         └─────────────► [React WebView Dashboard] ◄───────────────────────┘
                           (Typed postMessage Bridge)
```

* **Storage Engine**: Time-series snapshots are stored in Redis Sorted Sets (`zAdd`) keyed by Unix timestamps. High-performance pruning occurs automatically with `zRemRangeByScore` to maintain a strict rolling 7-day window.
* **WebView Bridge**: A lightweight React dashboard runs in a sandboxed Devvit WebView, communicating with the Devvit backend using a custom, typed `postMessage` protocol.
* **Asset Optimization**: Features a highly-optimized asset footprint (<170KB total) and custom SVG sparklines rather than bulky external charting libraries to deliver lightning-fast UI hydration.

---

## 💻 Tech Stack

* **Runtime**: Reddit Devvit SDK (`@devvit/public-api` v0.12.22)
* **Frontend**: React (local bundle, bypassed CSP network restrictions)
* **Styling**: Vanilla CSS (Tailored dark theme)
* **Database**: Devvit Redis KV Store (Strings & Sorted Sets)
* **Language**: TypeScript

---

## 🏁 Getting Started

### Prerequisites

* Node.js (v18 or higher)
* [Devvit CLI installed and configured](https://developers.reddit.com/docs/quickstart)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/AstaadDahiya/ModPulse.git
   cd ModPulse
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start local playtesting on your test subreddit:
   ```bash
   devvit playtest <your_subreddit_name>
   ```

---

## 📽️ Video Demo & Presentation

This project contains built-in presentation slides designed for a **1-minute hackathon video walkthrough**. 

To launch the slides:
1. Open the file `demo/index.html` in any web browser.
2. Enter fullscreen mode.
3. Navigate slides using your keyboard arrow keys (`←` / `→`).

The voiceover script and visual workflow are designed to guide the viewer sequentially from introducing the problem, showcasing the live React dashboard, detailing the database/trigger architecture, and finishing with a call to action.
