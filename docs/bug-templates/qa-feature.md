# qa-feature Bug Report Template

Use this template for bugs found while testing a feature branch, user story, or design spec. File it in Jira with the `cxp-bug` and `qa-feature` labels.

See the sibling [qa-adhoc template](qa-adhoc.md) for ad hoc/exploratory/regression-sweep bugs.

## Tone

Objective, highly technical, direct. Use explicit RN/web engineering terms: "layout container," "press action," "event propagation," "conditional rendering flags," "asset configuration," "string component."

## Formatting rules

Same case/backtick/punctuation rules as the [qa-adhoc template](qa-adhoc.md): quoted UI text takes its exact casing from the screenshot/screencast source, except all-caps source text, which always converts to Title Case (e.g. "SEE US IN ACTION" quotes as "See Us In Action"); double quotes (not backticks) for UI strings, backticks reserved for code/components/version strings, strip trailing periods from quoted headers. Ticket Summary line is sentence case (not Title Case), one sentence, no trailing period, never start with "The". Write it from the actual observed defect (screenshot/screencast/description) — don't restate a caller-supplied summary verbatim if it's generic. Never name a platform (Android, iOS, native app, mobile web, desktop web, etc.) in the summary — that's already covered by the Platform/Platforms line and the Jira Platforms Impacted field; keep the summary focused on the defect itself. When referring to a platform in prose (Observed/Expected/Notes), write "in the iOS app" / "in the Android app", not "on iOS" / "on Android".

Never use the word "sessions" (e.g. "Chrome mobile web session", "both sessions") anywhere in the report, especially Notes — refer to the browser/platform directly instead (e.g. "in Chrome mobile web"). When a bug reproduces identically across both mobile web browsers, phrase it exactly as "Reproduces identically in both Chrome mobile web and Safari mobile web" — no "the" before each browser name, no trailing "captures". Every Jira ticket key or PR number mentioned anywhere in the report must be a markdown link, every occurrence, not just the first. Any date written into the report must use "Month D, YYYY" — never ISO format.

## Platform diagnosis assumptions

One React Native codebase (iOS/Android/web); web renders via `react-native-web` through Next.js, not truly native:

- Native App (both) → "Open the Talos app" — diagnose via press event propagation, `Pressable` handler registration, `View`/RN Flexbox constraints.
- Android only → "Open the Talos Android app".
- iOS only → "Open the Talos iOS app".
- Mobile Web → "Open the Talos mobile website" — never cite the JS bridge or native views (don't exist on web); diagnose via `react-native-web` prop translation loss, Next.js hydration timing, CSS cascade.
- Desktop Web → "Open the Talos desktop website" — same web-only diagnosis rules.
- Cross-platform → reproduces at the shared `.tsx`, not a render target: conditional rendering flags, component state, urql/Jotai data resolution.

## Output layout, exactly

```
**Ticket Summary:** [one sentence, no period]

✨ *AI-Assisted Bug Report*

- **Behavior:**
    - *Observed:* [hyper-specific broken behavior, quoted UI text with exact source casing]
    - *Expected:* [intended UX pattern + the design/reference view it should match, quoted UI text with exact source casing]
- **Path:** [exact section/page, sentence case by default; title case only applies to a portion that is itself quoted UI copy (exact source casing); preserve `https://`/`http://` lowercase if URL; single path only]
- **Platform:**/**Platforms:** [Desktop Web | Mobile Web | Desktop & Mobile Web | Native App | Android App | iOS App | Cross-platform, verbatim] (version: `X.XX.X-XXXXXX` if given)
- **Attachments:** `filename.ext`
- **Feature Flag:** `FLAG_NAME` — always include this line; if no flag applies, use `**Feature Flag:** N/A` rather than omitting it
- **Notes:** [technical root-cause hypothesis grounded in the platform diagnosis rules above; inline-code specific components like `TouchableOpacity`/`Pressable`]
```

**Note:** no `## Steps to Reproduce` heading in this template — that's what distinguishes it from [qa-adhoc](qa-adhoc.md).
