<!-- This is manually synced into the Slack bug-intake service's own copy of this file (it needs its own copy). If you edit one, edit the other. -->

# qa-adhoc Bug Report Template

Use this template for bugs found during ad hoc or exploratory testing (not tied to a specific feature branch or user story) — including regression sweeps. File it in Jira with the `cxp-bug`, `qa-adhoc`, and `cxp-backlog` labels.

See the sibling [qa-feature template](qa-feature.md) for feature-branch/design-spec bugs.

## Tone

Professional, analytical, heavy on spatial UI description — "empty void," "background canvas space," "vertical padding," "horizontal carousel," "category shelf."

## Formatting rules

- Quoted UI text takes its casing from the screenshot/screencast source, not a forced style — if the app renders "Add payment method," quote it exactly as "Add payment method," not "Add Payment Method." Never render UI text/strings in all-caps even if the UI itself shows them that way: convert to Title Case instead (e.g. a header rendered as "SEE US IN ACTION" quotes as "See Us In Action").
- Never backtick UI text, menu items, or quoted strings — use double quotes instead: `"Save on Häagen-Dazs"`, not `` `Save on Häagen-Dazs` ``. Backticks are reserved for actual code, variables, file extensions, terminal commands, and the app version string (e.g. `2.34.0-123456`).
- Use logical punctuation with quoted UI text: a comma or period that belongs to the surrounding sentence, not the quoted string itself, goes outside the closing quote — `"Aloft Hotels", "Embassy Suites Hotels", and "Hyatt Regency"`, not `"Aloft Hotels," "Embassy Suites Hotels," and "Hyatt Regency."` The quote must stay an exact copy of the source string, with nothing added.
- Strip trailing periods from any quoted Talos header/string.
- Ticket Summary line: sentence case (not Title Case), one sentence, no trailing period, never start with "The". Write it from the actual observed defect (screenshot/screencast/description) — don't restate a caller-supplied summary verbatim if it's generic. Never name a platform (Android, iOS, native app, mobile web, desktop web, etc.) in the summary — that's already covered by the Environment/Platform line and the Jira Platforms Impacted field; keep the summary focused on the defect itself.
- Attachments section: just the raw filename in backticks, no bullet/dash, on its own line under the header.
- When referring to a platform in prose (Steps/Actual/Expected/Notes), write "in the iOS app" / "in the Android app", not "on iOS" / "on Android".
- Never use the word "sessions" (e.g. "Chrome mobile web session", "both sessions") anywhere in the report — refer to the browser/platform directly instead (e.g. "in Chrome mobile web").
- When a bug reproduces identically across both mobile web browsers, phrase it exactly as "Reproduces identically in both Chrome mobile web and Safari mobile web" — no "the" before each browser name, no trailing "captures".
- Every Jira ticket key (e.g. TALOS-124005) or PR number (e.g. #23635) mentioned anywhere in the report must be a markdown link, every occurrence, not just the first.
- Any date written into the report must use "Month D, YYYY" (e.g. "October 12, 2026") — never ISO format.

## Output layout, exactly

```
**Ticket Summary:** [one sentence, no period]

✨ *AI-Assisted Bug Report*

## Environment

- **Platform:**/**Platforms:** [Desktop Web | Mobile Web | Desktop & Mobile Web | Native App | Android App | iOS App | Cross-platform, verbatim — "Platforms:" only for Desktop & Mobile Web] (version: `X.XX.X-XXXXXX` if given)
- **Path:** [exact section/page, sentence case by default; title case only applies to a portion that is itself a literal on-screen UI title or label, quoted with exact source casing the same way Steps/Actual/Expected Results do; preserve `https://`/`http://` lowercase if it's a URL; single path only]

## Steps to Reproduce

1. Open the Talos [app | Android app | iOS app | mobile website | desktop website] and navigate to the [Path — same quoting rule as everywhere else: quote with exact source casing if it's a literal on-screen title, otherwise sentence case] page.
2. [scroll/tap/sweep action needed to surface the area]
3. [precise observation checkpoint — quoted UI text, exact source casing]

## Actual Results

[broken state — quoted UI text with exact source casing, spatial-layout emphasis]

## Expected Results

[intended behavior — quoted UI text with exact source casing, layout/spacing rules]

## Attachments

`filename.ext`
```

**Note:** the `## Steps to Reproduce` heading is what distinguishes this template from [qa-feature](qa-feature.md) — don't drop it, and don't add it to a feature-spec report.

**Note:** for a Cross-platform bug, Steps to Reproduce step 1 must read "Open the Talos app, mobile website, or desktop website and navigate to..." — not just "Open the Talos app and navigate to...". Use the single-platform phrasing from the step above only when Platform is a single value (Native App, Android App, iOS App, Desktop Web, Mobile Web).

**Note:** this template has no `Feature Flag` field — that field is [qa-feature](qa-feature.md)-only; don't add one here.
