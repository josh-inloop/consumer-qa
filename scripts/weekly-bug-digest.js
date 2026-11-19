// Required env vars:
//   JIRA_EMAIL       Atlassian account email
//   JIRA_API_TOKEN   Jira API token
//   SLACK_TARGET     Slack channel ID or user ID (DM)
//
// Optional env vars:
//   SLACK_BOT_TOKEN  Only needed when posting (not for --dry-run)
//   GROK_API_KEY       xAI Grok API key for AI Trends & Insights
//
// Flags:
//   --dry-run        Print the Slack payload to stdout instead of writing slack-payload.json
//
// Output:
//   slack-payload.json  (consumed by slackapi/slack-github-action in the workflow)

"use strict";

const fs = require("node:fs");
const https = require("node:https");

// -------------------- Config --------------------
const JIRA_EMAIL = (process.env.JIRA_EMAIL || "").trim();
const JIRA_API_TOKEN = (process.env.JIRA_API_TOKEN || "").trim();
const SLACK_TARGET = (process.env.SLACK_TARGET || "").trim();
const DRY_RUN = process.argv.includes("--dry-run");

const GROK_API_KEY = (process.env.GROK_API_KEY || "").trim();

const JIRA_HOST = "your-jira-instance.atlassian.net";
const NO_TEMPLATES = `summary !~ "CLONE" AND summary !~ "Clone Me"`;
const TEAM_FILTER = `"Product Team[Dropdown]" IN ("Consumer Quality", "Consumer Experience", Loyalty)`;

// -------------------- Validation --------------------
function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!JIRA_EMAIL) fail("Missing JIRA_EMAIL env var.");
if (!JIRA_API_TOKEN) fail("Missing JIRA_API_TOKEN env var.");
if (!DRY_RUN && !SLACK_TARGET) fail("Missing SLACK_TARGET env var.");

// -------------------- Date helpers --------------------
function getLastWeekRange() {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon
  const daysToThisMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;

  const thisMonday = new Date(now);
  thisMonday.setDate(now.getDate() + daysToThisMonday);
  thisMonday.setHours(0, 0, 0, 0);

  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(thisMonday.getDate() - 7);

  const lastSunday = new Date(thisMonday);
  lastSunday.setDate(thisMonday.getDate() - 1);
  lastSunday.setHours(23, 59, 59, 999);

  return { start: lastMonday, end: lastSunday };
}

function formatDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function isoDate(date) {
  return date.toISOString().split("T")[0];
}

function daysSince(dateStr) {
  return Math.floor((Date.now() - new Date(dateStr).getTime()) / (1000 * 60 * 60 * 24));
}

function daysBetween(startStr, endStr) {
  return (new Date(endStr).getTime() - new Date(startStr).getTime()) / (1000 * 60 * 60 * 24);
}

function median(nums) {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatNumber(n) {
  return n.toLocaleString("en-US");
}

// -------------------- HTTP --------------------
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${raw.slice(0, 300)}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${body.slice(0, 300)}`));
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// -------------------- Jira --------------------
const jiraAuth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
const jiraHeaders = { Authorization: `Basic ${jiraAuth}`, Accept: "application/json" };
const FIELDS = "summary,status,priority,assignee,created,updated,resolutiondate,labels";

async function jiraSearch(jql) {
  const issues = [];
  let nextPageToken = null;

  do {
    const params = new URLSearchParams({ jql, fields: FIELDS, maxResults: "100" });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);

    const data = await httpsGet(JIRA_HOST, `/rest/api/3/search/jql?${params}`, jiraHeaders);

    if (data.errorMessages) throw new Error(`Jira API error: ${data.errorMessages.join(", ")}`);

    issues.push(...(data.issues || []));
    nextPageToken = data.isLast === false && data.nextPageToken ? data.nextPageToken : null;
  } while (nextPageToken);

  return issues;
}

// -------------------- AI Insights --------------------
async function getAIInsights(metrics) {
  if (!GROK_API_KEY) {
    console.warn("GROK_API_KEY not set — skipping AI Trends & Insights.");
    return null;
  }

  const sign = (n) => (n > 0 ? `+${n}` : `${n}`);
  const w1 = metrics.priorWeekStats[0];
  const filingTrend = metrics.newThisWeek === w1.filed
    ? `flat vs prior week (${metrics.newThisWeek})`
    : `${metrics.newThisWeek > w1.filed ? "up" : "down"} ${Math.abs(metrics.newThisWeek - w1.filed)} vs prior week (${metrics.newThisWeek} vs ${w1.filed})`;
  const closureTrend = metrics.closedThisWeek === w1.closed
    ? `flat vs prior week (${metrics.closedThisWeek})`
    : `${metrics.closedThisWeek > w1.closed ? "up" : "down"} ${Math.abs(metrics.closedThisWeek - w1.closed)} vs prior week (${metrics.closedThisWeek} vs ${w1.closed})`;
  const netTrends = metrics.priorWeekStats.map((w) => sign(w.net));
  const netDirection = metrics.priorWeekStats.every((w) => w.net > 0)
    ? `backlog has grown for 4 consecutive weeks (nets: this week ${sign(metrics.netThisWeek)}, prior: ${netTrends.join(", ")})`
    : metrics.priorWeekStats.every((w) => w.net < 0)
    ? `backlog has shrunk for 4 consecutive weeks (nets: this week ${sign(metrics.netThisWeek)}, prior: ${netTrends.join(", ")})`
    : `mixed net trend over 4 weeks (this week ${sign(metrics.netThisWeek)}, prior: ${netTrends.join(", ")})`;

  const priorHistory = metrics.priorWeekStats
    .map((w, i) => `  Week -${i + 1} (${w.label}): filed ${w.filed}, closed ${w.closed}, net ${sign(w.net)}`)
    .join("\n");

  const priorityBreakdown = Object.entries(metrics.byPriority)
    .map(([p, n]) => `${p}: ${n} (${metrics.priorityPcts[p]}%)`)
    .join(", ");

  const statusBreakdown = metrics.topStatuses
    .map(([s, n]) => `${s}: ${n}`)
    .join(", ");

  const prompt = `You are a QA engineering assistant writing a brief AI insights section for a weekly Slack bug digest.

Analyze the data below and write a 3–4 sentence summary highlighting only the most important observations and action items.

Rules:
- Plain prose, no bullet points or bold headlines
- Focus on what matters most and what should be acted on
- You MUST mention stale bugs, unassigned bugs, AND bugs older than 1 year — all three, every time, as long as their count is greater than 0
- Be specific — use exact numbers from the data
- ONLY use numbers and facts explicitly listed below — never infer, estimate, or assume any value not provided
- If making a comparison, the supporting numbers must be present in the data below
- When referencing stale bugs, unassigned bugs, or bugs older than 1 year, insert the pre-formatted link token exactly as written — do not modify it or add extra > characters
  - Stale in-progress bugs → STALE_BUGS_LINK
  - Unassigned bugs → UNASSIGNED_BUGS_LINK
  - Bugs older than 1 year → OLD_BUGS_LINK
  - Each token already contains the count — do not repeat the number after the token or use words like "shows" or "reveals" before describing the bugs
  - Use the token as the subject naturally: "STALE_BUGS_LINK are stuck outside active development" not "STALE_BUGS_LINK shows X bugs stuck..."
  - Example: "UNASSIGNED_BUGS_LINK include 5 at Highest priority and need immediate triage."

Current week (${metrics.dateRange}):
- Open backlog: ${metrics.openTotal} (${priorityBreakdown})
- Status breakdown: ${statusBreakdown}
- Filed: ${metrics.newThisWeek}, Closed: ${metrics.closedThisWeek}, Net: ${sign(metrics.netThisWeek)}
- Filing trend: ${filingTrend}
- Closure trend: ${closureTrend}
- Net backlog trend: ${netDirection}
- Unassigned (use UNASSIGNED_BUGS_LINK for the count): ${metrics.unassignedPct}% of backlog, of which ${metrics.unassignedHighest} are Highest priority
- Stale in-progress (use STALE_BUGS_LINK for the count): only ${metrics.inDevelopmentCount} bugs are actively In Development
- Bugs open 1+ year (use OLD_BUGS_LINK for the count)

Prior 3 weeks:
${priorHistory}`;

  try {
    const result = await httpsPost(
      "api.x.ai",
      "/v1/chat/completions",
      { "Authorization": `Bearer ${GROK_API_KEY}` },
      { model: "grok-4.5", messages: [{ role: "user", content: prompt }], max_tokens: 512 }
    );
    let text = result.choices?.[0]?.message?.content?.trim() || null;
    if (text && metrics.links) {
      for (const [token, link] of Object.entries(metrics.links)) {
        text = text.replaceAll(token, link);
      }
    }
    return text;
  } catch (err) {
    console.warn(`AI Insights failed: ${err.message}`);
    return null;
  }
}

// -------------------- Main --------------------
async function main() {
  const { start, end } = getLastWeekRange();
  const startIso = isoDate(start);
  const endIso = isoDate(end);
  const dateRange = `${formatDate(start)} – ${formatDate(end)}`;

  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const sevenDaysAgoIso = isoDate(sevenDaysAgo);

  console.log(`Fetching TALOS bugs for week: ${dateRange}`);

  // Build date ranges for prior 3 weeks
  const priorWeeks = [1, 2, 3].map((weeksAgo) => {
    const s = new Date(start);
    s.setDate(s.getDate() - 7 * weeksAgo);
    const e = new Date(end);
    e.setDate(e.getDate() - 7 * weeksAgo);
    return { startIso: isoDate(s), endIso: isoDate(e), label: formatDate(s) + " – " + formatDate(e) };
  });

  const [openBugs, closedThisWeek, openedThisWeek, staleBugsRaw, ...priorResults] = await Promise.all([
    jiraSearch(
      `project = TALOS AND issuetype = Bug AND ${NO_TEMPLATES} AND ${TEAM_FILTER} AND status NOT IN (Done, Duplicate, Cancelled, Released) AND created >= startOfYear(-2) ORDER BY priority ASC, created ASC`
    ),
    jiraSearch(
      `project = TALOS AND issuetype = Bug AND ${TEAM_FILTER} AND status = Done AND resolutiondate >= "${startIso}" AND resolutiondate <= "${endIso}"`
    ),
    jiraSearch(
      `project = TALOS AND issuetype = Bug AND ${TEAM_FILTER} AND created >= "${startIso}" AND created <= "${endIso}"`
    ),
    jiraSearch(
      `project = TALOS AND issuetype = Bug AND ${NO_TEMPLATES} AND ${TEAM_FILTER} AND statusCategory = "In Progress" AND created >= startOfYear(-2) AND updated <= "${sevenDaysAgoIso}"`
    ),
    ...priorWeeks.flatMap((w) => [
      jiraSearch(`project = TALOS AND issuetype = Bug AND ${TEAM_FILTER} AND status = Done AND resolutiondate >= "${w.startIso}" AND resolutiondate <= "${w.endIso}"`),
      jiraSearch(`project = TALOS AND issuetype = Bug AND ${TEAM_FILTER} AND created >= "${w.startIso}" AND created <= "${w.endIso}"`),
    ]),
  ]);

  // -------------------- Filter template tickets --------------------
  const TEMPLATE_PATTERNS = [/^CLONE\s+-/i, /\(Clone Me\)/i];
  const isTemplate = (issue) => TEMPLATE_PATTERNS.some((re) => re.test(issue.fields.summary || ""));
  const filteredOpenBugs = openBugs.filter((i) => !isTemplate(i));
  const filteredClosedThisWeek = closedThisWeek.filter((i) => !isTemplate(i));
  const filteredOpenedThisWeek = openedThisWeek.filter((i) => !isTemplate(i));
  const filteredAutomationThisWeek = filteredOpenedThisWeek.filter((i) =>
    (i.fields.labels || []).includes("qa-automation")
  );

  // -------------------- Ad hoc bugs (qa-adhoc): filed/closed + time-to-fix --------------------
  const isAdhoc = (i) => (i.fields.labels || []).includes("qa-adhoc");
  const filteredAdhocOpenedThisWeek = filteredOpenedThisWeek.filter(isAdhoc);
  const filteredAdhocClosedThisWeek = filteredClosedThisWeek.filter(isAdhoc);
  const adhocMedianDaysToFix = median(
    filteredAdhocClosedThisWeek.map((i) => daysBetween(i.fields.created, i.fields.resolutiondate))
  );

  // priorResults = [w1closed, w1opened, w2closed, w2opened, w3closed, w3opened]
  const priorWeekStats = priorWeeks.map((w, i) => {
    const closed = priorResults[i * 2].filter((r) => !isTemplate(r));
    const filed = priorResults[i * 2 + 1].filter((r) => !isTemplate(r));
    return { label: w.label, closed: closed.length, filed: filed.length, net: filed.length - closed.length };
  });

  console.log(
    `Open: ${filteredOpenBugs.length}  |  Closed this week: ${filteredClosedThisWeek.length}  |  New this week: ${filteredOpenedThisWeek.length}`
  );

  // -------------------- Priority counts --------------------
  const PRIORITY_ORDER = ["Highest", "High", "Medium", "Low", "Lowest"];
  const PRIORITY_EMOJI = { Highest: ":severity-highest:", High: ":severity-high:", Medium: ":severity-medium:", Low: ":severity-low:", Lowest: ":severity-lowest:" };

  const byPriority = Object.fromEntries(PRIORITY_ORDER.map((p) => [p, 0]));
  for (const issue of filteredOpenBugs) {
    const p = issue.fields.priority?.name;
    if (p && p in byPriority) byPriority[p]++;
    else byPriority["Low"]++;
  }

  // -------------------- Status counts (actual Jira status names) --------------------
  const byStatus = {};
  for (const issue of filteredOpenBugs) {
    const statusName = issue.fields.status?.name || "Unknown";
    byStatus[statusName] = (byStatus[statusName] || 0) + 1;
  }
  const topStatuses = Object.entries(byStatus)
    .filter(([, n]) => n >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  // -------------------- Needs attention --------------------
  const unassigned = filteredOpenBugs.filter((i) => !i.fields.assignee);
  const stale = staleBugsRaw;

  const olderThanOneYear = filteredOpenBugs.filter((i) => daysSince(i.fields.created) >= 365);

  // -------------------- Bug fixer leaderboard --------------------
  const fixCounts = {};
  for (const issue of filteredClosedThisWeek) {
    if (issue.fields.status?.name !== "Done") continue;
    const name = issue.fields.assignee?.displayName;
    if (!name) continue;
    fixCounts[name] = (fixCounts[name] || 0) + 1;
  }
  const topFixers = Object.entries(fixCounts)
    .sort((a, b) => b[1] - a[1])
    .filter(([, count]) => count >= 5)
    .slice(0, 5);
  const fixerMedals = ["🏅", "🏅", "🏅", "🏅", "🏅"];

  // -------------------- This Week priority breakdown --------------------
  const newHighest = filteredOpenedThisWeek.filter((i) => i.fields.priority?.name === "Highest").length;
  const newHigh = filteredOpenedThisWeek.filter((i) => i.fields.priority?.name === "High").length;

  // -------------------- Jira issue search URLs --------------------
  const JIRA_ISSUES = "https://your-jira-instance.atlassian.net/issues/";
  const filedUrl = `${JIRA_ISSUES}?jql=${encodeURIComponent(`project = TALOS AND issuetype = Bug AND ${TEAM_FILTER} AND created >= "${startIso}" AND created <= "${endIso}"`)}`;
  const closedUrl = `${JIRA_ISSUES}?jql=${encodeURIComponent(`project = TALOS AND issuetype = Bug AND ${TEAM_FILTER} AND status = Done AND resolutiondate >= "${startIso}" AND resolutiondate <= "${endIso}"`)}`;
  const unassignedUrl = `${JIRA_ISSUES}?jql=${encodeURIComponent(`project = TALOS AND issuetype = Bug AND ${NO_TEMPLATES} AND ${TEAM_FILTER} AND status NOT IN (Done, Duplicate, Cancelled, Released) AND created >= startOfYear(-2) AND assignee is EMPTY ORDER BY priority ASC, created ASC`)}`;
  const staleUrl = `${JIRA_ISSUES}?jql=${encodeURIComponent(`project = TALOS AND issuetype = Bug AND ${NO_TEMPLATES} AND ${TEAM_FILTER} AND statusCategory = "In Progress" AND created >= startOfYear(-2) AND updated <= "${sevenDaysAgoIso}" ORDER BY updated ASC`)}`;
  const olderThanOneYearUrl = `${JIRA_ISSUES}?jql=${encodeURIComponent(`project = TALOS AND issuetype = Bug AND ${NO_TEMPLATES} AND ${TEAM_FILTER} AND status NOT IN (Done, Duplicate, Cancelled, Released) AND created >= startOfYear(-2) AND created <= "-365d" ORDER BY created ASC`)}`;
  const automationUrl = `${JIRA_ISSUES}?jql=${encodeURIComponent(`project = TALOS AND issuetype = Bug AND labels = "qa-automation" AND created >= "${startIso}" AND created <= "${endIso}"`)}`;
  const adhocFiledUrl = `${JIRA_ISSUES}?jql=${encodeURIComponent(`project = TALOS AND issuetype = Bug AND labels = "qa-adhoc" AND created >= "${startIso}" AND created <= "${endIso}"`)}`;
  const adhocClosedUrl = `${JIRA_ISSUES}?jql=${encodeURIComponent(`project = TALOS AND issuetype = Bug AND labels = "qa-adhoc" AND status = Done AND resolutiondate >= "${startIso}" AND resolutiondate <= "${endIso}"`)}`;

  // -------------------- AI Insights --------------------
  const unassignedPct = filteredOpenBugs.length > 0 ? Math.round((unassigned.length / filteredOpenBugs.length) * 100) : 0;
  const unassignedHighest = filteredOpenBugs.filter((i) => !i.fields.assignee && i.fields.priority?.name === "Highest").length;
  const inDevelopmentCount = byStatus["In Development"] || 0;
  const staleNotInDev = stale.filter((i) => i.fields.status?.name !== "In Development").length;
  const priorityPcts = Object.fromEntries(
    Object.entries(byPriority).map(([p, n]) => [p, Math.round((n / filteredOpenBugs.length) * 100)])
  );
  const aiInsights = await getAIInsights({
    dateRange,
    openTotal: formatNumber(filteredOpenBugs.length),
    byPriority,
    priorityPcts,
    topStatuses,
    newThisWeek: filteredOpenedThisWeek.length,
    closedThisWeek: filteredClosedThisWeek.length,
    netThisWeek: filteredOpenedThisWeek.length - filteredClosedThisWeek.length,
    unassigned: formatNumber(unassigned.length),
    unassignedPct,
    unassignedHighest,
    stale: formatNumber(stale.length),
    inDevelopmentCount,
    staleNotInDev,
    olderThanOneYear: olderThanOneYear.length,
    priorWeekStats,
    links: {
      STALE_BUGS_LINK: `<${staleUrl}|${formatNumber(stale.length)} stale bugs>`,
      UNASSIGNED_BUGS_LINK: `<${unassignedUrl}|${formatNumber(unassigned.length)} unassigned bugs>`,
      OLD_BUGS_LINK: `<${olderThanOneYearUrl}|${formatNumber(olderThanOneYear.length)} bugs open 1+ year>`,
    },
  });

  // -------------------- Build Slack Block Kit payload --------------------
  const priorityLines = PRIORITY_ORDER.filter((p) => byPriority[p] > 0)
    .map((p) => `${PRIORITY_EMOJI[p]}  ${p}: *${formatNumber(byPriority[p])}*${priorityPcts[p] > 0 ? ` (${priorityPcts[p]}%)` : ""}`)
    .join("\n\n");

  const STATUS_EMOJI = {
    "Concept": "🐣",
    "Ready for Scoping": "🔍",
    "Ready for Development": "🔨",
    "In Development": "⚙️",
    "Ready for Release": "🚀",
  };

  const statusLines = topStatuses
    .map(([s, n]) => `${STATUS_EMOJI[s] || "📋"}  ${s}: *${formatNumber(n)}*`)
    .join("\n\n");

  const attentionItems = [];
  if (unassigned.length > 0)
    attentionItems.push(
      `• *<${unassignedUrl}|${formatNumber(unassigned.length)}>* ${unassigned.length === 1 ? "bug is" : "bugs are"} unassigned`
    );
  if (stale.length > 0)
    attentionItems.push(
      `• *<${staleUrl}|${formatNumber(stale.length)}>* ${stale.length === 1 ? "bug hasn't" : "bugs haven't"} moved in 7+ days`
    );
  if (olderThanOneYear.length > 0)
    attentionItems.push(
      `• *<${olderThanOneYearUrl}|${formatNumber(olderThanOneYear.length)}>* ${olderThanOneYear.length === 1 ? "bug" : "bugs"} older than 1 year`
    );

  const fixerLines = topFixers
    .map(([name, count], i) => `${fixerMedals[i]}  ${name}: *${formatNumber(count)}* fixed`)
    .join("\n\n");

  const blocks = [
    {
      type: "header",
      text: {
        type: "plain_text",
        text: `🪲 Weekly Bug Digest  |  ${dateRange}`,
        emoji: true,
      },
    },
    { type: "divider" },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: `*📊 Open Backlog: ${formatNumber(filteredOpenBugs.length)}*\n\n${priorityLines}`,
        },
        {
          type: "mrkdwn",
          text: `*🚥 By Status*\n\n${statusLines}`,
        },
      ],
    },
    { type: "divider" },
    {
      type: "section",
      text: { type: "mrkdwn", text: "*📈 Last Week*" },
    },
    {
      type: "section",
      fields: [
        {
          type: "mrkdwn",
          text: (() => {
            const severityLine = (newHighest > 0 || newHigh > 0)
              ? `  ·  ${[newHighest > 0 ? `*${newHighest}* Highest` : null, newHigh > 0 ? `*${newHigh}* High` : null].filter(Boolean).join("  ·  ")}`
              : "";
            const net = filteredOpenedThisWeek.length - filteredClosedThisWeek.length;
            const netStr = net > 0 ? `+${formatNumber(net)}` : formatNumber(net);
            const automationLine = filteredAutomationThisWeek.length > 0
              ? `\n• *<${automationUrl}|${formatNumber(filteredAutomationThisWeek.length)} ${filteredAutomationThisWeek.length === 1 ? "bug" : "bugs"}>* caught in automation`
              : "";
            const adhocLine = (() => {
              if (filteredAdhocOpenedThisWeek.length === 0 && filteredAdhocClosedThisWeek.length === 0) return "";
              let medianLine = "";
              if (adhocMedianDaysToFix !== null) {
                const roundedMedian = Math.round(adhocMedianDaysToFix * 10) / 10;
                medianLine = `\n⠀⠀↳ median *${roundedMedian} days* to fix`;
              }
              return `\n• Ad hoc: *<${adhocFiledUrl}|${formatNumber(filteredAdhocOpenedThisWeek.length)}>* filed  ·  *<${adhocClosedUrl}|${formatNumber(filteredAdhocClosedThisWeek.length)}>* closed${medianLine}`;
            })();
            return `• *<${filedUrl}|${formatNumber(filteredOpenedThisWeek.length)}>* filed${severityLine}\n• *<${closedUrl}|${formatNumber(filteredClosedThisWeek.length)}>* closed${automationLine}\n• ${netStr} backlog${adhocLine}`;
          })(),
        },
        {
          type: "mrkdwn",
          text: topFixers.length > 0 ? `*🏆 Top Bug Squashers*\n\n${fixerLines}` : " ",
        },
      ],
    },
    ...(attentionItems.length > 0
      ? [
          { type: "divider" },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*⚠️ Needs Attention*\n\n${attentionItems.join("\n")}`,
            },
          },
        ]
      : []),
    ...(aiInsights
      ? [
          { type: "divider" },
          {
            type: "section",
            text: { type: "mrkdwn", text: `*✨ AI Trends & Insights*\n\n${aiInsights}` },
          },
        ]
      : []),
    { type: "divider" },
  ];

  const payload = {
    channel: SLACK_TARGET || "dry-run",
    text: `🪲 Weekly Bug Digest | ${dateRange} — ${formatNumber(filteredOpenBugs.length)} open bugs`,
    blocks,
  };

  if (DRY_RUN) {
    console.log("\n=== DRY RUN — Slack payload ===\n");
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  fs.writeFileSync("slack-payload.json", JSON.stringify(payload), "utf8");
  console.log(`Wrote slack-payload.json  (target: ${SLACK_TARGET})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
