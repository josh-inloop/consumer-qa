// Required env vars:
//   TARGET_REPO    e.g. "owner/app-repo"
//   GH_TOKEN       PAT that can read TARGET_REPO (classic token OK)
//   SLACK_TARGET   Slack channel ID to post to
// Optional env vars:
//   BASE_BRANCH    default "dev"
//   TZ             default "America/New_York"
//   JIRA_BASE_URL  default "https://your-jira-instance.atlassian.net/browse"
//   GROK_API_KEY       xAI Grok API key for AI Summary
//
// Flags:
//   --dry-run      Print the Slack payload to stdout instead of writing slack-payload.json
//
// Output files:
//   slack-payload.json     (consumed by slackapi/slack-github-action in the workflow)
//   out/app-repo-digest-latest.md
//   out/app-repo-digest-latest.html
//   out/digest-date.txt

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { spawnSync } = require("node:child_process");
const dayjs = require("dayjs");

// -------------------- Config --------------------
const GROK_API_KEY = (process.env.GROK_API_KEY || "").trim();
const TZ = (process.env.TZ || "America/New_York").trim();
const BASE_BRANCH = (process.env.BASE_BRANCH || "dev").trim();
const TARGET_REPO = (process.env.TARGET_REPO || "").trim();
const JIRA_BASE_URL = (process.env.JIRA_BASE_URL || "https://your-jira-instance.atlassian.net/browse").trim();
const JIRA_HOST = "your-jira-instance.atlassian.net";
const JIRA_EMAIL = (process.env.JIRA_EMAIL || "").trim();
const JIRA_API_TOKEN = (process.env.JIRA_API_TOKEN || "").trim();
const QA_TESTING_FIELD = "customfield_10370"; // "QA Testing"
const PRODUCT_TEAM_FIELD = "customfield_10048"; // "Product Team"
const QA_ENGINEER_FIELD = "customfield_10215"; // "QA Engineer"
const PRODUCT_TEAM_ALLOWLIST = new Set(["Consumer Experience"]);
const SLACK_TARGET = (process.env.SLACK_TARGET || "").trim();
const DRY_RUN = process.argv.includes("--dry-run");

// -------------------- Validation --------------------
function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}
function validateTargetRepo(v) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v);
}
if (!TARGET_REPO) fail("Missing TARGET_REPO env var.");
if (!validateTargetRepo(TARGET_REPO)) fail(`Invalid TARGET_REPO: "${TARGET_REPO}" (expected OWNER/REPO).`);
if (!process.env.GH_TOKEN || !String(process.env.GH_TOKEN).trim()) fail("Missing GH_TOKEN env var.");
if (!DRY_RUN && !SLACK_TARGET) fail("Missing SLACK_TARGET env var.");

// -------------------- GH helpers --------------------
function ensureGhInstalled() {
  const r = spawnSync("gh", ["--version"], { encoding: "utf8" });
  if (r.error || r.status !== 0) fail("GitHub CLI (gh) not available.");
}

function ghApiGet(endpoint) {
  const r = spawnSync("gh", ["api", endpoint], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
    env: process.env,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim();
    console.error(`Command failed: gh api "${endpoint}"`);
    console.error(msg);
    throw new Error(msg || `gh api failed: ${endpoint}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    console.error(`Failed to parse JSON from: gh api "${endpoint}"`);
    console.error((r.stdout || "").slice(0, 500));
    throw e;
  }
}

function encodeQS(params) {
  const e = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && `${v}`.length > 0)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return e.length ? `?${e.join("&")}` : "";
}

function verifyRepoAccess() {
  ghApiGet(`/repos/${TARGET_REPO}`);
}

// -------------------- Time window --------------------
function getYesterdayWindowLocal() {
  // Correctness depends on TZ=America/New_York being set in the environment.
  const now = dayjs();
  return { start: now.subtract(1, "day").startOf("day"), end: now.startOf("day") };
}
function fmtDate(d) {
  return d.format("YYYY-MM-DD");
}

// -------------------- GitHub fetch --------------------
function searchMergedPRNumbers(startISO, endISO) {
  // Use full ISO timestamps so GitHub applies exact UTC boundaries rather than
  // interpreting date-only strings against UTC day edges (which would bleed
  // into the wrong local day).
  const q = `repo:${TARGET_REPO} is:pr is:merged base:${BASE_BRANCH} merged:${startISO}..${endISO}`;
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = ghApiGet(`/search/issues${encodeQS({ q, per_page: 100, page })}`);
    for (const i of r.items || []) if (typeof i.number === "number") out.push(i.number);
    if ((r.items || []).length < 100) break;
  }
  return [...new Set(out)];
}

function fetchPR(n) {
  return ghApiGet(`/repos/${TARGET_REPO}/pulls/${n}`);
}

function fetchPRFiles(n) {
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const b = ghApiGet(`/repos/${TARGET_REPO}/pulls/${n}/files${encodeQS({ per_page: 100, page })}`);
    if (!Array.isArray(b)) break;
    all.push(...b);
    if (b.length < 100) break;
  }
  return all;
}

// Commit summaries (best-effort): use each commit's first-line message.
// Note: Listing commit "change summaries" beyond commit messages (e.g., per-commit file diffs)
// would require additional API calls per commit, which can be slow/noisy for large PRs.
function fetchPRCommits(n, maxCommits = 25) {
  const commits = [];
  for (let page = 1; page <= 10; page++) {
    const b = ghApiGet(`/repos/${TARGET_REPO}/pulls/${n}/commits${encodeQS({ per_page: 100, page })}`);
    if (!Array.isArray(b)) break;

    for (const c of b) {
      const sha = c?.sha || "";
      const msg = c?.commit?.message || "";
      const firstLine = String(msg).split("\n")[0].trim();
      const author = c?.author?.login || c?.commit?.author?.name || "unknown";
      commits.push({
        sha7: sha ? String(sha).slice(0, 7) : "unknown",
        message: firstLine || "(no message)",
        author,
      });
      if (commits.length >= maxCommits) return commits;
    }

    if (b.length < 100) break;
  }
  return commits;
}

// -------------------- Jira parsing/linking --------------------
// Handle hyphen variants between TALOS and digits: -, ‐, -, –, —
const TALOS_KEY_RE = /\bTALOS[-\u2010\u2011\u2013\u2014]\d+\b/g;

function normalizeJiraKey(key) {
  return String(key).replace(/[\u2010\u2011\u2013\u2014]/g, "-");
}

function extractJiraKeys(title) {
  return Array.from(String(title || "").match(TALOS_KEY_RE) || []).map(normalizeJiraKey);
}

function firstJiraKey(title) {
  const keys = extractJiraKeys(title);
  return keys.length ? keys[0] : "";
}

function stripJiraKeys(title) {
  return String(title || "")
    .replace(TALOS_KEY_RE, "")
    .replace(/\[\s*\]/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s*\|\s*\|\s*/g, " | ")
    .replace(/^\s*[:\-|–—]+\s*/g, "")
    .trim();
}

function jiraUrlForKey(key) {
  const k = normalizeJiraKey(key || "");
  if (!k) return "";
  return `${JIRA_BASE_URL}/${k}`;
}

// -------------------- Jira QA Testing lookup --------------------
function httpsGet(hostname, reqPath, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${body.slice(0, 300)}`)); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function jiraAuthHeaders() {
  const auth = Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
  return { Authorization: `Basic ${auth}`, Accept: "application/json" };
}

async function fetchQATestingComplete(issueKey) {
  try {
    const data = await httpsGet(JIRA_HOST, `/rest/api/3/issue/${issueKey}?fields=${QA_TESTING_FIELD}`, jiraAuthHeaders());
    if (data.errorMessages) throw new Error(data.errorMessages.join(", "));
    return data.fields?.[QA_TESTING_FIELD]?.value === "Complete";
  } catch (err) {
    console.warn(`QA Testing lookup failed for ${issueKey}: ${err.message}`);
    return false;
  }
}

// Returns true if the ticket has a QA Engineer assigned.
async function fetchHasQAEngineer(issueKey) {
  try {
    const data = await httpsGet(JIRA_HOST, `/rest/api/3/issue/${issueKey}?fields=${QA_ENGINEER_FIELD}`, jiraAuthHeaders());
    if (data.errorMessages) throw new Error(data.errorMessages.join(", "));
    return Boolean(data.fields?.[QA_ENGINEER_FIELD]);
  } catch (err) {
    console.warn(`QA Engineer lookup failed for ${issueKey}: ${err.message}`);
    return false;
  }
}

// Returns the ticket's Product Team name, or null if the field is unset/unreadable
// (lookup failures and unset fields are treated as "unknown", not "excluded" — see caller).
async function fetchProductTeam(issueKey) {
  try {
    const data = await httpsGet(JIRA_HOST, `/rest/api/3/issue/${issueKey}?fields=${PRODUCT_TEAM_FIELD}`, jiraAuthHeaders());
    if (data.errorMessages) throw new Error(data.errorMessages.join(", "));
    return data.fields?.[PRODUCT_TEAM_FIELD]?.value || null;
  } catch (err) {
    console.warn(`Product Team lookup failed for ${issueKey}: ${err.message}`);
    return null;
  }
}

// -------------------- Areas touched (improved buckets + dir fallback) --------------------
function normalizePath(p) {
  return String(p || "").replaceAll("\\", "/").toLowerCase();
}

function topDirFromPath(p) {
  const s = normalizePath(p);
  const parts = s.split("/").filter(Boolean);
  const drop = new Set(["src", "app", "apps", "lib", "libs"]);
  const cleaned = parts.filter((x) => !drop.has(x));
  return cleaned[0] || parts[0] || "root";
}

function bucketForPath(p) {
  const s = normalizePath(p);

  if (s.startsWith("packages/internal/")) return "Internal Tooling";

  if (
    s.startsWith("ios/") ||
    s.includes("/ios/") ||
    s.includes("podfile") ||
    s.endsWith(".xcconfig") ||
    s.endsWith(".xcodeproj")
  )
    return "iOS";
  if (s.startsWith("android/") || s.includes("/android/") || s.endsWith(".gradle") || s.includes("androidmanifest"))
    return "Android";
  if (s.includes(".github/") || s.includes("ci/") || s.includes("fastlane") || s.includes("build") || s.includes("config"))
    return "Build/CI";

  if (s.includes("navigation") || s.includes("router") || s.includes("routes") || s.includes("linking") || s.includes("deeplink"))
    return "Navigation";

  if (s.includes("auth") || s.includes("login") || s.includes("logout") || s.includes("session") || s.includes("token") || s.includes("oauth"))
    return "Auth";

  // Note: "billing", "promo", "coupon", and "tip" are deliberately excluded — they
  // false-positive across unrelated packages (packages/coupons/, design-system/tooltip,
  // post-order/tips, auth/address-autocomplete, etc.) that aren't part of the checkout flow.
  if (s.includes("checkout") || s.includes("cart") || s.includes("payment")) return "Checkout";

  if (s.includes("search") || s.includes("browse") || s.includes("category") || s.includes("collection") || s.includes("catalog"))
    return "Browse/Search";
  if (s.includes("pdp") || s.includes("productdetail") || s.includes("product-detail") || s.includes("/product/"))
    return "Product Detail";

  if (s.includes("order") || s.includes("orders") || s.includes("orderhistory") || (s.includes("tracking") && !s.includes("analytics")))
    return "Orders/Tracking";

  if (s.includes("address") || s.includes("delivery") || s.includes("eta") || s.includes("fulfillment") || s.includes("storefront"))
    return "Delivery";

  const NETWORK_INFRA_MARKERS = ["platform/urql", "jotai-urql", "graphql-plugins", "platform/gql-schema"];
  if (s.includes("/api") || s.includes("network") || NETWORK_INFRA_MARKERS.some((m) => s.includes(m)))
    return "API/Networking";

  if (s.includes("redux") || s.includes("mobx") || s.includes("store") || s.includes("state") || s.includes("reducer") || s.includes("selector"))
    return "State";
  if (s.includes("cache") || s.includes("persist") || s.includes("storage") || s.includes("database") || s.includes("sqlite"))
    return "Storage/Cache";

  if (s.includes("featureflag") || s.includes("feature-flag") || s.includes("experiment") || s.includes("/flags"))
    return "Flags/Experiments";

  if (s.includes("notification") || s.includes("push") || s.includes("permission")) return "Notifications";

  if (s.includes("analytics") || s.includes("tracking") || s.includes("telemetry") || s.includes("logging") || s.includes("sentry"))
    return "Analytics/Observability";

  if (s.includes("i18n") || s.includes("localiz") || s.includes("strings") || s.includes("translations")) return "Localization";

  if (s.includes("theme") || s.includes("styles") || s.includes("design") || s.includes("tokens") || s.includes("components") || s.includes("/ui/"))
    return "UI";

  if (
    s.includes("__tests__") ||
    s.includes("/test/") ||
    s.endsWith(".spec.ts") ||
    s.endsWith(".spec.js") ||
    s.endsWith(".test.ts") ||
    s.endsWith(".test.js")
  )
    return "Tests";

  if (s.endsWith(".md") || s.includes("docs/")) return "Docs";

  return "Other";
}

function summarizeAreas(files) {
  const bucketCounts = new Map();
  const dirCounts = new Map();

  for (const f of files) {
    const b = bucketForPath(f.filename);
    bucketCounts.set(b, (bucketCounts.get(b) || 0) + 1);

    const d = topDirFromPath(f.filename);
    dirCounts.set(d, (dirCounts.get(d) || 0) + 1);
  }

  const bucketsByFreq = [...bucketCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const nonOther = bucketsByFreq.filter((b) => b !== "Other");
  if (nonOther.length) return nonOther.slice(0, 5);

  const topDirs = [...dirCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([d]) => d);

  return topDirs.length ? topDirs.map((d) => `Dir:${d}`) : ["Other"];
}

// -------------------- Regression Risk --------------------
const HIGH_RISK_BUCKETS = new Set(["Auth", "Checkout", "Navigation", "UI"]);
const INFRA_BUCKETS = new Set(["iOS", "Android", "Build/CI", "Tests", "Docs", "Analytics/Observability", "Internal Tooling"]);

function getHighRiskAreas(files) {
  const areas = new Set();
  for (const f of files) {
    const b = bucketForPath(f.filename);
    if (HIGH_RISK_BUCKETS.has(b)) areas.add(b);
  }
  return [...areas];
}

function nonInfraFiles(files) {
  return (files || []).filter((f) => !INFRA_BUCKETS.has(bucketForPath(f.filename)));
}

// -------------------- Platform tagging --------------------
// Deterministic, not LLM-guessed: app-repo uses platform-suffixed filenames
// (Foo.web.tsx, Foo.ios.tsx, Foo.android.tsx, Foo.native.tsx) for platform-specific
// implementations. A file with no such suffix is shared RN code that compiles into
// every build, but that's a file-location fact, not a statement about where the
// feature actually ships (e.g. Talos AI code is shared but Talos AI itself is native-only
// today) — so it's labeled "Shared code", not "Cross-platform". "Cross-platform" is
// reserved for a PR that actually touches both a .web.* and a native-suffixed file.
const PLATFORM_SUFFIX_RE = /\.(web|ios|android|native)\.[jt]sx?$/;

function platformForFiles(files) {
  const relevant = nonInfraFiles(files);
  let hasWeb = false;
  let hasNative = false;
  let hasShared = false;

  for (const f of relevant) {
    const name = normalizePath(f.filename);
    const m = name.match(PLATFORM_SUFFIX_RE);
    if (!m) {
      hasShared = true;
      continue;
    }
    if (m[1] === "web") hasWeb = true;
    else hasNative = true; // ios, android, native
  }

  if (hasWeb && hasNative) return "Cross-platform";
  if (hasShared) return "Shared code";
  if (hasWeb) return "Web";
  if (hasNative) return "Native";
  return "Shared code";
}

function extractJSON(text) {
  const stripped = String(text || "").replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(stripped);
}

async function assessPRRisk({ title, body, files, highRiskAreas }) {
  if (!GROK_API_KEY) return null;
  const fileList = nonInfraFiles(files)
    .slice(0, 50)
    .map((f) => f.filename)
    .join("\n");
  const testFiles = files
    .filter((f) => bucketForPath(f.filename) === "Tests")
    .map((f) => f.filename)
    .join("\n");
  const descriptionText = String(body || "").trim().slice(0, 1500) || "(none)";

  // Checkout/Auth carry inherent business risk (payment, access) even for
  // modest-looking changes, so they keep the baseline bar. Navigation/UI are
  // high-volume, mostly-cosmetic buckets — without a stricter bar here they
  // dominate the digest with noise.
  const onlyNavOrUI = highRiskAreas.every((a) => a === "Navigation" || a === "UI");
  const navUiBar = onlyNavOrUI
    ? `\nThis PR's only high-risk areas are Navigation and/or UI, not Checkout or Auth — apply a stricter bar. Flag it only if it risks breaking an existing user flow (e.g. a user can get stuck, lose data, or hit a dead end) OR touches a highly visible, high-traffic surface (e.g. home feed, PDP, cart, nav bar) in a way a typical user would notice within seconds of normal use. Do NOT flag a routine visual/layout tweak, a new screen or component that's off the default path, a minor interaction polish, or a change confined to a low-traffic screen — those are not worth a manual regression pass on their own.\n`
    : "";

  const prompt = `You are a QA engineer assessing whether a pull request to a React Native consumer app (iOS, Android, web) warrants manual regression testing.

High-risk areas touched: ${highRiskAreas.join(", ")}
PR title: ${title}
PR description (author's own words — trust this over guessing from file paths):
${descriptionText}
Changed files (consumer app only, up to 50):
${fileList}

Existing test files touched by this PR (context only — these do not represent behavior changes):
${testFiles || "(none)"}

Flag it only if it makes substantive changes to consumer-facing behavior. Do NOT flag: minor copy fixes, comment-only changes, test-file-only changes, trivial refactors with no behavior impact, or dependency bumps with no API surface change.
${navUiBar}
Do NOT flag changes to internal/engineering-only surfaces — debug panels, admin tools, dev menus, or anything the description itself calls a "debug" or "internal" screen — even though a real screen renders it. This digest is scoped to what a real customer encounters in normal use.

Do NOT flag behavior-preserving internal refactors (e.g. consolidating cache keys, renaming/removing an internal hook, restructuring data-layer plumbing) just because the diff touches many UI component files that import the changed code. Only flag if the description or file list indicates the customer-visible behavior is actually changing, not merely how it's implemented under the hood.

Flag it only if a QA engineer can verify the change by using the app as a real user would — tapping through the UI and observing a visible result. Do NOT flag changes whose only verification path requires inspecting network request/response payloads, backend/server state, or feature-flag internals — that is outside manual consumer QA's tooling. If you cannot describe a UI-observable way to test it, set flag to false.

The changed files list above excludes native iOS/Android files, so you cannot determine which platforms (iOS, Android, web) are actually affected. Do NOT mention or guess specific platforms in the test description.

If a test file above appears to cover the same logic as one of the changed files (e.g. matching name or directory), still flag it, but say so in the test description and point QA toward a quick UI spot-check instead of a full manual repro of edge-case data conditions the unit test already covers.

Respond with a JSON object only, no other text:
{
  "flag": true or false,
  "areas": ["list of affected high-risk areas from the input"],
  "test": "one concise, platform-agnostic sentence describing exactly what a QA engineer should manually test on dev, or null if flag is false"
}`;
  try {
    const result = await httpsPost(
      "api.x.ai",
      "/v1/chat/completions",
      { Authorization: `Bearer ${GROK_API_KEY}` },
      { model: "grok-4.5", messages: [{ role: "user", content: prompt }], max_tokens: 200 }
    );
    const content = result.choices?.[0]?.message?.content?.trim() || "{}";
    const parsed = extractJSON(content);
    return {
      flag: Boolean(parsed.flag),
      areas: Array.isArray(parsed.areas) && parsed.areas.length ? parsed.areas : highRiskAreas,
      test: typeof parsed.test === "string" ? parsed.test : null,
    };
  } catch (err) {
    console.warn(`Risk assessment failed for "${title}": ${err.message}`);
    return null;
  }
}

// -------------------- AI Insights --------------------
function httpsPost(hostname, path, headers, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      { hostname, path, method: "POST", headers: { ...headers, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(raw)); }
          catch (e) { reject(new Error(`JSON parse error (HTTP ${res.statusCode}): ${raw.slice(0, 300)}`)); }
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function getAIInsights({ totalPRs, areaCounts, unlinkedCount, prTitles }) {
  if (!GROK_API_KEY) {
    console.warn("GROK_API_KEY not set — skipping AI insights.");
    return null;
  }

  const areaList = Object.entries(areaCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([area, count]) => `${area}: ${count} PR${count !== 1 ? "s" : ""}`)
    .join(", ");

  const titlesText = prTitles.map((t, i) => `${i + 1}. ${t}`).join("\n");

  const prompt = `You are a technical writer summarizing a day's shipped changes for a team of engineers and PMs.

Write 2-3 sentences describing what was shipped. Be specific about which areas changed and what the changes appear to be based on the PR titles.

Rules:
- Only use data provided below — do not infer or fabricate
- Plain prose only — no headers, no bullet points, no markdown formatting
- Be specific — mention areas and notable changes by name
- Do not reference any time period (e.g. "yesterday", "today", "this week") — the heading already contains the date

Total PRs merged: ${totalPRs}
Areas touched: ${areaList}
PRs with no Jira key: ${unlinkedCount}

PR titles:
${titlesText}`;

  try {
    const result = await httpsPost(
      "api.x.ai",
      "/v1/chat/completions",
      { "Authorization": `Bearer ${GROK_API_KEY}` },
      { model: "grok-4.5", messages: [{ role: "user", content: prompt }], max_tokens: 256 }
    );
    return result.choices?.[0]?.message?.content?.trim() || null;
  } catch (err) {
    console.warn(`AI insights failed: ${err.message}`);
    return null;
  }
}

// -------------------- Report building --------------------
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function buildMarkdown({ windowStart, windowEnd, prs, aiInsights }) {
  let md = `# PR Daily Digest\n\n`;
  md += `- Target repo: \`${TARGET_REPO}\`\n`;
  md += `- Base branch: \`${BASE_BRANCH}\`\n`;
  md += `- Window (${TZ}): **${windowStart.format("YYYY-MM-DD HH:mm")} → ${windowEnd.format("YYYY-MM-DD HH:mm")}**\n`;
  md += `- Merged PRs: **${prs.length}**\n\n`;

  if (!prs.length) {
    md += `No merged PRs in the window.\n`;
    return md;
  }

  if (aiInsights) {
    md += `## ✨ AI Summary\n\n${aiInsights}\n\n`;
  }

  md += `---\n\n`;
  for (const pr of prs) {
    const prLink = `[${pr.title_sans_keys}](${pr.html_url})`;
    md += `- ${prLink} · ${pr.author}\n`;
  }
  md += `\n`;

  return md;
}

function wrapHtml(md) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PR Daily Digest</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 2rem; line-height: 1.35; }
    .card { max-width: 1100px; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f6f8fa; padding: 1rem; border-radius: 10px; }
    code { background: #f4f4f4; padding: 0.1rem 0.3rem; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>PR Daily Digest</h1>
    <pre>${escapeHtml(md)}</pre>
  </div>
</body>
</html>`;
}

// -------------------- Slack payload --------------------
function buildSlackPayload({ windowStart, prs, aiSummary, regressionQueue }) {
  const dateStr = windowStart.format("MMM D, YYYY");
  const repoName = TARGET_REPO.split("/")[1] || TARGET_REPO;

  const prLines = prs.map((pr) => {
    const prLink = `<${pr.html_url}|${pr.title_sans_keys}>`;
    const jiraLink = pr.jira_key ? ` · :jira-modern: <${pr.jira_url}|${pr.jira_key}>` : "";
    return `:git-merge: ${prLink}${jiraLink}`;
  });

  // Chunk to stay under Slack's 3000-char block limit
  const CHUNK_LIMIT = 2500;
  const prChunks = [];
  let current = "";
  for (const line of prLines) {
    if (current.length + line.length + 1 > CHUNK_LIMIT && current) {
      prChunks.push(current.trim());
      current = line + "\n\n";
    } else {
      current += line + "\n\n";
    }
  }
  if (current.trim()) prChunks.push(current.trim());

  const blocks = [
    {
      type: "header",
      text: { type: "plain_text", text: `📦 PR Daily Digest  |  ${dateStr}`, emoji: true },
    },
    { type: "divider" },
  ];

  if (aiSummary) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*✨ Shipped Summary*\n\n${aiSummary}` },
    });
    blocks.push({ type: "divider" });
  }

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `*:github2: Merged PRs (${prs.length})*` },
  });

  for (const chunk of prChunks) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: chunk } });
  }

  blocks.push({ type: "divider" });

  if (regressionQueue && regressionQueue.length > 0) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*⚠️ UI Regression Risk (${regressionQueue.length})*` },
    });
    for (const pr of regressionQueue) {
      const jiraPart = pr.jira_key ? `  ·  <${pr.jira_url}|${pr.jira_key}>` : "";
      const titleLine = `<${pr.html_url}|${pr.title_sans_keys}>${jiraPart}`;
      const testLine = pr.test ? `*Test:* ${pr.test}` : "";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: [titleLine, testLine].filter(Boolean).join("\n\n"),
        },
      });
      const areasLine = [`*${pr.platform}*`, ...pr.areas].join(" · ");
      blocks.push({
        type: "context",
        elements: [{ type: "mrkdwn", text: areasLine }],
      });
    }
    blocks.push({ type: "divider" });
  }

  return {
    channel: SLACK_TARGET || "dry-run",
    text: `📦 PR Daily Digest | ${dateStr} — ${prs.length} PR${prs.length !== 1 ? "s" : ""} merged to ${BASE_BRANCH}`,
    blocks,
  };
}

// -------------------- Main --------------------
async function main() {
  ensureGhInstalled();
  verifyRepoAccess();

  const { start: windowStart, end: windowEnd } = getYesterdayWindowLocal();
  const startDate = fmtDate(windowStart);

  const prNumbers = searchMergedPRNumbers(windowStart.toISOString(), windowEnd.toISOString());

  if (prNumbers.length === 0) {
    fs.mkdirSync("out", { recursive: true });
    fs.writeFileSync(path.join("out", "pr-count.txt"), "0", "utf8");
    console.log("Merged PRs found: 0\nNo merged PRs in the window. Skipping digest.");
    process.exit(0);
  }

  const MAX_PRS = 200;
  const selected = prNumbers.slice(0, MAX_PRS);

  const prs = [];
  for (const n of selected) {
    const pr = fetchPR(n);
    const files = fetchPRFiles(n);

    const jira_key = firstJiraKey(pr.title);
    const jira_url = jira_key ? jiraUrlForKey(jira_key) : "";

    prs.push({
      number: pr.number,
      title_sans_keys: stripJiraKeys(pr.title),
      html_url: pr.html_url,
      merged_at: pr.merged_at,
      areas: summarizeAreas(files),
      jira_key,
      jira_url,
      _files: files,
      _body: pr.body || "",
    });
  }

  prs.sort((a, b) => (a.merged_at < b.merged_at ? 1 : -1));

  // -------------------- Regression Risk Assessment --------------------
  const regressionQueue = [];
  if (GROK_API_KEY) {
    console.log("\nRunning regression risk assessment...");
    for (const pr of prs) {
      const highRiskAreas = getHighRiskAreas(pr._files || []);
      if (highRiskAreas.length > 0) {
        const assessment = await assessPRRisk({ title: pr.title_sans_keys, body: pr._body, files: pr._files, highRiskAreas });
        if (assessment?.flag) {
          regressionQueue.push({
            ...pr,
            areas: assessment.areas,
            test: assessment.test,
            platform: platformForFiles(pr._files),
          });
          console.log(`  #${pr.number} FLAGGED — ${assessment.test}`);
        }
      }
      delete pr._files;
      delete pr._body;
    }
    console.log(`Regression risk: ${regressionQueue.length} flagged`);
  } else {
    for (const pr of prs) { delete pr._files; delete pr._body; }
  }

  // -------------------- QA Testing status (regression queue only) --------------------
  // Drop PRs already marked QA Testing: Complete in Jira — the section should only
  // surface items that still need to be looked at.
  if (regressionQueue.length && (!JIRA_EMAIL || !JIRA_API_TOKEN)) {
    console.warn("JIRA_EMAIL/JIRA_API_TOKEN not set — skipping QA Testing status check.");
  } else if (JIRA_EMAIL && JIRA_API_TOKEN) {
    const stillNeedsTesting = [];
    for (const pr of regressionQueue) {
      const qaComplete = pr.jira_key ? await fetchQATestingComplete(pr.jira_key) : false;
      if (qaComplete) {
        console.log(`  #${pr.number} QA complete — dropping from regression queue`);
      } else {
        stillNeedsTesting.push(pr);
      }
    }
    regressionQueue.length = 0;
    regressionQueue.push(...stillNeedsTesting);
  }

  // -------------------- QA Engineer filter (regression queue only) --------------------
  // A ticket with a QA Engineer assigned is already claimed — drop it so the
  // digest only surfaces risks nobody is on.
  if (regressionQueue.length && JIRA_EMAIL && JIRA_API_TOKEN) {
    const unassignedOnly = [];
    for (const pr of regressionQueue) {
      const hasQAEngineer = pr.jira_key ? await fetchHasQAEngineer(pr.jira_key) : false;
      if (hasQAEngineer) {
        console.log(`  #${pr.number} QA Engineer assigned — dropping from regression queue`);
      } else {
        unassignedOnly.push(pr);
      }
    }
    regressionQueue.length = 0;
    regressionQueue.push(...unassignedOnly);
  }

  // -------------------- Product Team filter (regression queue only) --------------------
  // Other teams (e.g. Ad Tech) own their own QA for their tickets — only surface
  // Consumer Experience work here. A ticket with no Product Team set, or one whose
  // lookup failed, is kept rather than silently dropped.
  if (regressionQueue.length && JIRA_EMAIL && JIRA_API_TOKEN) {
    const consumerExperienceOnly = [];
    for (const pr of regressionQueue) {
      const productTeam = pr.jira_key ? await fetchProductTeam(pr.jira_key) : null;
      if (productTeam && !PRODUCT_TEAM_ALLOWLIST.has(productTeam)) {
        console.log(`  #${pr.number} Product Team "${productTeam}" — dropping from regression queue`);
      } else {
        consumerExperienceOnly.push(pr);
      }
    }
    regressionQueue.length = 0;
    regressionQueue.push(...consumerExperienceOnly);
  }

  // -------------------- AI Insights --------------------
  const areaCounts = {};
  for (const pr of prs) {
    for (const area of pr.areas) {
      areaCounts[area] = (areaCounts[area] || 0) + 1;
    }
  }
  const unlinkedCount = prs.filter((pr) => !pr.jira_key).length;
  const prTitles = prs.map((pr) => pr.title_sans_keys);

  const aiInsights = await getAIInsights({
    totalPRs: prs.length,
    areaCounts,
    unlinkedCount,
    prTitles,
  });

  const slackPayload = buildSlackPayload({ windowStart, prs, aiSummary: aiInsights, regressionQueue });

  if (DRY_RUN) {
    console.log("\n=== DRY RUN — Slack payload ===\n");
    console.log(JSON.stringify(slackPayload, null, 2));
  } else {
    fs.writeFileSync("slack-payload.json", JSON.stringify(slackPayload), "utf8");
    console.log(`Wrote slack-payload.json  (target: ${SLACK_TARGET})`);
  }

  const md = buildMarkdown({ windowStart, windowEnd, prs, aiInsights });
  const html = wrapHtml(md);

  fs.mkdirSync("out", { recursive: true });
  fs.writeFileSync(path.join("out", "app-repo-digest-latest.md"), md, "utf8");
  fs.writeFileSync(path.join("out", "app-repo-digest-latest.html"), html, "utf8");
  fs.writeFileSync(path.join("out", "digest-date.txt"), startDate, "utf8");
  fs.writeFileSync(path.join("out", "pr-count.txt"), String(prs.length), "utf8");

  console.log("Wrote out/app-repo-digest-latest.(md|html) and out/digest-date.txt");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});