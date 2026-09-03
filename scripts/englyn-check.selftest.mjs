#!/usr/bin/env node
// Self-test for englyn-check.mjs. Builds fixtures, runs the real checker
// against each with `node englyn-check.mjs <fixture> --json`, and asserts
// verdicts. No frameworks. Exit 1 on any control failure.
//
// Rules A-E: Rule 7 narration substance, R5 consequence co-location (incl.
//   WS6a Task 4's typed-tier path), R10 priority order, R1 double-form
//   numbers, R8 role=alert-in-static-HTML.
// Rules F-G (WS6a): F = Task 1 enum membership, G = Task 2 text-transform
//   speech safety.
// Task 3 (known-zero, DRAFT) is tested separately below — it has no
// FAILS/CONFORMS state (always CANNOT-CHECK), so it doesn't fit the
// fail-<letter>-flips-only-itself loop. (Task 5, the unannounced-name
// guard, was tested here the same way until its removal at gate 3 —
// 2026-08-19, DISPATCH-JUDE-ENGLYN-LAUNCH-BUILD-001 — see
// englyn-check.mjs's removal comment.)

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(__dirname, 'englyn-check.mjs');

// The rules under test, keyed by letter, and how to spot their check(s) in
// the JSON report (a check whose `name` starts with the given prefix).
const RULES = {
  A: 'Rule 7 narration has substance',
  B: 'R5 consequence co-location',
  C: 'R10 priority order',
  D: 'R1 double-form numbers',
  E: 'R8 no role=alert',
  F: 'Enum membership',
  G: 'text-transform speech safety',
};

const BASE_HEAD = `<!doctype html>
<html lang="en">
<head>
<title>Baseline Fixture</title>
<meta name="description" content="A fixture page used to verify the Englyn checker rules A through G.">
</head>
<body>
<main>
<h1>Baseline Fixture Page</h1>`;

const BASE_TAIL = `</main>
</body>
</html>`;

const NARRATION_OK = `<section class="sr-only" data-englyn-role="narration">
<h2>Page overview</h2>
<p>This narration block exists only to satisfy the twenty word floor required by rule A, and it must differ from both the heading text and the description text above it.</p>
</section>`;
const NARRATION_TOO_SHORT = `<section class="sr-only" data-englyn-role="narration">
<h2>Page overview</h2>
<p>Too short.</p>
</section>`;

const NAV_OK = `<nav>
<a href="/one" data-englyn-priority="1">First link</a>
<a href="/two" data-englyn-priority="2">Second link</a>
</nav>`;
const NAV_BAD_SEQUENCE = `<nav>
<a href="/one" data-englyn-priority="2">First link</a>
<a href="/two" data-englyn-priority="3">Second link</a>
</nav>`;

const CONSEQUENCE_OK = `<p>
<a href="/three" data-englyn-consequence="Navigates to the Three page." aria-describedby="d1">Go to three</a>
<span id="d1" class="sr-only">Navigates to the Three page.</span>
</p>`;
const CONSEQUENCE_MISMATCH = `<p>
<a href="/three" data-englyn-consequence="Navigates to the Three page." aria-describedby="d1">Go to three</a>
<span id="d1" class="sr-only">Unrelated description text.</span>
</p>`;

const NUMBER_LABEL_OK = `<button aria-label="2,239 items in stock">Count</button>`;
const NUMBER_LABEL_DOUBLE_FORM = `<button aria-label="2,239 thousand items in stock">Count</button>`;

const ALERT_NONE = '';
const ALERT_PRESENT = `<div role="alert">Something happened</div>`;

function buildFixture({ narration = NARRATION_OK, nav = NAV_OK, consequence = CONSEQUENCE_OK, numberLabel = NUMBER_LABEL_OK, alert = ALERT_NONE, extraProse = '', extraClass = false, extraHtml = '', styleBlock = '' }) {
  const wrapOpen = extraClass ? '<div class="wrapper">' : '';
  const wrapClose = extraClass ? '</div>' : '';
  return [BASE_HEAD, styleBlock, narration, nav, consequence, numberLabel, alert, extraProse, extraHtml, wrapOpen, wrapClose, BASE_TAIL].join('\n');
}

// Refinements of 2026-08-17 (second cut) — each with the verdict it MUST produce:
const CONSEQUENCE_MAILTO_UNMIRRORED = `<p><a href="mailto:x@example.com" data-englyn-consequence="Opens the visitor's own email client with a new message.">Email</a></p>`;
const CONSEQUENCE_BUTTON_UNMIRRORED = `<p><button data-englyn-consequence="Opens a menu of choices; nothing is sent.">Menu</button></p>`;
const NUMBER_LABEL_UNITS = `<button aria-label="12 percent complete, 2.4 million dollars">Count</button>`;
const ALERT_PRIMED_EMPTY = `<div role="alert"></div>`;
const NAV_TWO_ROLE_GROUPS = `<nav>
<a href="/one" data-englyn-role="section" data-englyn-priority="1">First</a>
<a href="/two" data-englyn-role="section" data-englyn-priority="2">Second</a>
<a href="/three" data-englyn-role="card" data-englyn-priority="1">Card one</a>
<a href="/four" data-englyn-role="card" data-englyn-priority="2">Card two</a>
</nav>`;

// WS6a Task 4 — typed-tier fixtures. The prose regex used to be the ONLY
// mechanism deciding T1-ness for an unmirrored link consequence; now it is a
// last resort that can never itself produce a pass.
const CONSEQUENCE_NAV_LINK_PROSE_ONLY = `<p><a href="/four" data-englyn-consequence="Navigates to the Four page. Read-only, nothing is saved or sent.">Go to four</a></p>`;
const CONSEQUENCE_NAV_LINK_TYPED_T1 = `<p><a href="/four" data-englyn-tier="T1" data-englyn-consequence="Does a thing, described nowhere near this link.">Go to four</a></p>`;
const CONSEQUENCE_TIER_SEVERITY_CONFLICT = `<p><a href="/four" data-englyn-tier="T1" data-englyn-severity="high" data-englyn-consequence="Does a thing, described nowhere near this link.">Go to four</a></p>`;

// WS6a Task 1 — enum membership fixtures.
const ENUM_BAD_VALUE = `<span data-englyn-role="not-a-real-value">x</span>`;
const ENUM_RESERVED_OK = `<span data-englyn-severity="high">x</span>`;
const ENUM_PROPOSED_OK = `<span data-englyn-tier="T1">x</span>`;
const ENUM_TEMPLATE_OK = `<span data-englyn-source="{buildSource}">x</span>`;

// WS6a Task 2 — text-transform speech fixtures.
// AMENDED 2026-08-19: rule G now tests CONTENT, not selector reach. The old
// fixture (h1 { text-transform: uppercase } with a risk-free heading) stopped
// firing, correctly — an uppercased "Heading" is spoken "heading" and is not a
// defect. A control that no longer exercises the defect is not a control.
// The class must appear in the fixture's HTML or the selector is not applicable.
const STYLE_HEADING_UPPERCASE = `<style>.risky-title { text-transform: uppercase; }</style>`;
const RISKY_HEADING = `<h1 class="risky-title">What this buys us</h1>`;
// MUST-NOT-FIRE: same transform, same shape, no risk word. Proves the check is
// discriminating rather than firing on any uppercase at all.
const STYLE_SAFE_UPPERCASE = `<style>.safe-title { text-transform: uppercase; }</style>`;
const SAFE_HEADING = `<h1 class="safe-title">Liner Notes</h1>`;
const STYLE_UNREACHED_UPPERCASE = `<style>.button { text-transform: uppercase; }</style>`;

// WS6a Task 3 — known-zero (DRAFT, always CANNOT-CHECK) fixture.
const STAT_ZERO_UNBACKED = `<div data-englyn-role="stat">0</div>`;

const EXPECT = { // fixture → { rule: verdict } that must hold (others may be anything)
  'cc-B-mailto':   { B: 'CANNOT-CHECK' },  // non-navigational link, unmirrored → never a pass
  'fail-B-button': { B: 'FAILS' },         // buttons must mirror
  'ok-D-units':    { D: 'CONFORMS' },      // units beside digits are Rule 1's endorsed form
  'ok-E-primed':   { E: 'CONFORMS' },      // empty primed alert container is the correct pattern
  'ok-C-groups':   { C: 'CONFORMS' },      // two role groups, each 1..n
  // WS6a Task 4 — typed tier path (rewrites the old ok-B-navlink expectation):
  'cc-B-navlink-prose':  { B: 'CANNOT-CHECK' }, // prose is now the deciding mechanism → never a pass
  'ok-B-navlink-typed':  { B: 'CONFORMS' },     // data-englyn-tier="T1" (typed) → a real pass
  'cc-B-tier-conflict':  { B: 'CANNOT-CHECK' }, // tier vs severity disagree → CANNOT-CHECK, REQUIRED
  // WS6a Task 1 — enum membership: reserved/proposed/template values are
  // named-but-unevaluated, not violations, so the aggregate check still CONFORMS.
  'ok-F-reserved': { F: 'CONFORMS' },
  'ok-F-proposed': { F: 'CONFORMS' },
  'ok-F-template': { F: 'CONFORMS' },
  // WS6a Task 2 — text-transform: CSS present but reaching nothing is a real
  // CONFORMS; no CSS at all is CANNOT-CHECK, never a clean pass.
  'ok-G-clean':    { G: 'CONFORMS' },
  'cc-G-no-css':   { G: 'CANNOT-CHECK' },
  'ok-G-safe-caps': { G: 'CONFORMS' },   // uppercase with no risk word is NOT a defect
};

const FIXTURES = {
  baseline: buildFixture({}),
  'cc-B-mailto': buildFixture({ consequence: CONSEQUENCE_MAILTO_UNMIRRORED }),
  'fail-B-button': buildFixture({ consequence: CONSEQUENCE_BUTTON_UNMIRRORED }),
  'ok-D-units': buildFixture({ numberLabel: NUMBER_LABEL_UNITS }),
  'ok-E-primed': buildFixture({ alert: ALERT_PRIMED_EMPTY }),
  'ok-C-groups': buildFixture({ nav: NAV_TWO_ROLE_GROUPS }),
  'fail-A': buildFixture({ narration: NARRATION_TOO_SHORT }),
  'fail-B': buildFixture({ consequence: CONSEQUENCE_MISMATCH }),
  'fail-C': buildFixture({ nav: NAV_BAD_SEQUENCE }),
  'fail-D': buildFixture({ numberLabel: NUMBER_LABEL_DOUBLE_FORM }),
  'fail-E': buildFixture({ alert: ALERT_PRESENT }),
  'fail-F': buildFixture({ extraHtml: ENUM_BAD_VALUE }),
  'fail-G': buildFixture({ styleBlock: STYLE_HEADING_UPPERCASE, extraHtml: RISKY_HEADING }),
  // MUST-NOT-FIRE control: same transform, no risk word. Without this, a check
  // that fired on every uppercase would still pass fail-G and look correct.
  'ok-G-safe-caps': buildFixture({ styleBlock: STYLE_SAFE_UPPERCASE, extraHtml: SAFE_HEADING }),
  'decoy-prose': buildFixture({ extraProse: '<p>This is just some more prose text with no attributes at all, for the prose-edit decoy.</p>' }),
  'decoy-class': buildFixture({ extraClass: true }),
  'cc-B-navlink-prose': buildFixture({ consequence: CONSEQUENCE_NAV_LINK_PROSE_ONLY }),
  'ok-B-navlink-typed': buildFixture({ consequence: CONSEQUENCE_NAV_LINK_TYPED_T1 }),
  'cc-B-tier-conflict': buildFixture({ consequence: CONSEQUENCE_TIER_SEVERITY_CONFLICT }),
  'ok-F-reserved': buildFixture({ extraHtml: ENUM_RESERVED_OK }),
  'ok-F-proposed': buildFixture({ extraHtml: ENUM_PROPOSED_OK }),
  'ok-F-template': buildFixture({ extraHtml: ENUM_TEMPLATE_OK }),
  'ok-G-clean': buildFixture({ styleBlock: STYLE_UNREACHED_UPPERCASE }),
  'cc-G-no-css': buildFixture({}), // same shape as baseline, named for clarity: no <style> at all
  'cc-known-zero': buildFixture({ extraHtml: STAT_ZERO_UNBACKED }),
};

function ruleVerdicts(reportPages) {
  const checks = reportPages[0].checks;
  const verdicts = {};
  for (const [letter, prefix] of Object.entries(RULES)) {
    const matches = checks.filter((c) => c.name.startsWith(prefix));
    verdicts[letter] = matches.some((c) => c.verdict === 'FAILS')
      ? 'FAILS'
      : matches.length
        ? matches[0].verdict
        : 'MISSING';
  }
  return verdicts;
}

function runReport(file) {
  const res = spawnSync('node', [CHECKER, file, '--json'], { encoding: 'utf8' });
  if (!res.stdout) {
    throw new Error(`no stdout from checker for ${file} (stderr: ${res.stderr})`);
  }
  return JSON.parse(res.stdout);
}

function run(file) {
  return ruleVerdicts(runReport(file).pages);
}

// checkByPrefix: verdict for an arbitrary check-name prefix not in RULES —
// used for controls that don't fit the fail-<letter> flip pattern (Task 3).
function checkByPrefix(checks, prefix) {
  const matches = checks.filter((c) => c.name.startsWith(prefix));
  return matches.some((c) => c.verdict === 'FAILS')
    ? 'FAILS'
    : matches.length ? matches[0].verdict : 'MISSING';
}

function main() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'englyn-selftest-'));
  const files = {};
  for (const [name, html] of Object.entries(FIXTURES)) {
    const fp = path.join(dir, `${name}.html`);
    writeFileSync(fp, html);
    files[name] = fp;
  }

  let failures = 0;
  const results = {};
  for (const name of Object.keys(FIXTURES)) results[name] = run(files[name]);

  const report = (label, pass, detail) => {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
    if (!pass) failures++;
  };

  // 1. baseline: 0 FAILS among A-G
  const base = results.baseline;
  const baseFails = Object.entries(base).filter(([, v]) => v === 'FAILS');
  report('baseline has 0 FAILS among rules A-G', baseFails.length === 0,
    baseFails.length ? `unexpected FAILS: ${baseFails.map(([l]) => l).join(',')}` : `${JSON.stringify(base)}`);

  // 2. each must-fail fixture flips exactly its rule, nothing else moves
  for (const letter of Object.keys(RULES)) {
    const r = results[`fail-${letter}`];
    const flipped = r[letter] === 'FAILS';
    const others = Object.keys(RULES).filter((l) => l !== letter);
    const untouched = others.every((l) => r[l] === base[l]);
    report(`fail-${letter} flips only rule ${letter}`, flipped && untouched,
      flipped && untouched ? '' : `got ${JSON.stringify(r)} vs baseline ${JSON.stringify(base)}`);
  }

  // 3. decoys change nothing among A-G
  for (const name of ['decoy-prose', 'decoy-class']) {
    const r = results[name];
    const same = Object.keys(RULES).every((l) => r[l] === base[l]);
    report(`${name} changes nothing among A-G`, same, same ? '' : `got ${JSON.stringify(r)} vs baseline ${JSON.stringify(base)}`);
  }

  // 4. refinement fixtures produce exactly the verdict the rule promises
  for (const [name, exp] of Object.entries(EXPECT)) {
    const r = results[name];
    for (const [letter, want] of Object.entries(exp)) {
      report(`${name}: rule ${letter} → ${want}`, r[letter] === want, r[letter] === want ? '' : `got ${r[letter]}`);
    }
  }

  // 5. WS6a Task 3 — known-zero (DRAFT, unruled): ALWAYS CANNOT-CHECK, never
  // FAILS and never a pass, whether or not a candidate is found. Not in RULES
  // (there is no FAILS/CONFORMS state to test), so read raw checks directly.
  const zeroBaselineChecks = runReport(files.baseline).pages[0].checks;
  const zeroBaselineVerdict = checkByPrefix(zeroBaselineChecks, 'Known-zero measurement');
  report('Known-zero (no candidates on page) is CANNOT-CHECK', zeroBaselineVerdict === 'CANNOT-CHECK',
    `got ${zeroBaselineVerdict}`);
  const zeroFoundChecks = runReport(files['cc-known-zero']).pages[0].checks;
  const zeroFoundVerdict = checkByPrefix(zeroFoundChecks, 'Known-zero measurement');
  report('Known-zero (unbacked zero-like stat found) is CANNOT-CHECK, never FAILS', zeroFoundVerdict === 'CANNOT-CHECK',
    `got ${zeroFoundVerdict}`);

  // Unannounced-name guard fixtures (WS6a Task 5) REMOVED at gate 3
  // (2026-08-19, DISPATCH-JUDE-ENGLYN-LAUNCH-BUILD-001), same commit as
  // checkUnannouncedName's removal from englyn-check.mjs — a control with no
  // call site has no fixtures to test. The seven cases lived here from
  // 2026-08-16: five identifier forms (snake/camel/kebab/lowercase/
  // apostrophe-joined "Englyn") that had to fire, and two plumbing forms
  // (data-englyn-* attributes, the englyn-check.mjs filename, and the
  // markdown channel's glob-form mention) that had to stay quiet. See
  // englyn-check.mjs's removal comment for what the guard caught while it
  // was live.

  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${failures === 0 ? 'ALL CONTROLS PASS' : `${failures} CONTROL(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
