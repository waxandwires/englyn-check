#!/usr/bin/env node
// Englyn static compliance checker (file name pending interface rename) — runs against the BUILT site (dist/).
//
// Canonical spec: products/wax-and-wires/englyn/testing/ENGLYN_ACCEPTANCE_CHECKLIST.md
//                 products/wax-and-wires/englyn/testing/ENGLYN_TESTING_PROTOCOL.md
// Skill copies (kept in sync from the canonical path above):
//   products/wax-and-wires/site/.claude/skills/englyn-accessible-page/SKILL.md
//   products/wax-and-wires/site/.claude/skills/englyn-essay-page/SKILL.md
//
// This is L1-ish static/regex analysis over rendered HTML — the mechanical
// subset of the checklist that doesn't require a browser or a screen
// reader. No new dependencies: dist/ has no cheerio/jsdom installed, so
// checks are regex/string based rather than a real DOM walk. That's a
// ceiling, not a bug — see "Known gaps" at the bottom of the output.
//
// L3 (axe-core) and L4 (keyboard flow) are NOT run here — they need a real
// browser. Run those via the `browse` skill / Playwright per
// ENGLYN_TESTING_PROTOCOL.md §L3-L4. L5 (screen reader read-aloud) is
// always manual, per protocol.
//
// USAGE (G4, ENGLYN_V0_1_0_RELEASE_PLAN.md):
//   node englyn-check.mjs                    # W+W site build mode: ../dist, W+W-specific checks ON
//   node englyn-check.mjs <dir|file.html|URL> [--ww] [--json]
//     <target>  a directory of built HTML, one .html file, or an http(s) URL (one page)
//     --ww      also run the Wax+Wires-specific checks (essay grammar, audio receipts).
//               Off by default when a target is given.
//     --json    machine-readable report on stdout (feeds the AT harness scoring)
// Three verdicts per requirement: CONFORMS / FAILS / CANNOT-CHECK. CANNOT-CHECK is
// never counted as a pass; the reasons print on their face. Exit 1 iff any FAILS.
// Requires Node >= 22 (fs.globSync, global fetch). No dependencies.
//
// Requirement ids (`req`) are PROVISIONAL: they point at the current de-facto spec —
// englyn/skills/englyn-accessible-page/SKILL.md "HTML/CSS Foundation" F1–F5 and
// "The 10 Narration Rules" R1–R10 — plus WCAG 2.2 SC numbers for the general
// checks. G2 (a normative spec) will renumber; keep `req` the single place that maps.

import { readFileSync, statSync, readdirSync, existsSync } from 'node:fs';
import { globSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- target + mode ---------------------------------------------------------
const ARGS = process.argv.slice(2);
const FLAGS = new Set(ARGS.filter((a) => a.startsWith('--')));
const TARGET_ARG = ARGS.find((a) => !a.startsWith('--')) || null;
const WW = TARGET_ARG ? FLAGS.has('--ww') : true; // no target = W+W site build mode
const JSON_OUT = FLAGS.has('--json');
const distDir = TARGET_ARG && !/^https?:\/\//.test(TARGET_ARG) ? path.resolve(TARGET_ARG) : path.join(__dirname, '..', 'dist');
const out = (...a) => { if (!JSON_OUT) console.log(...a); };

// Verdict from a boolean-ish: true → CONFORMS, false → FAILS, null → CANNOT-CHECK.
const verdictOf = (pass) => (pass === null || pass === undefined ? 'CANNOT-CHECK' : pass ? 'CONFORMS' : 'FAILS');

// Requirements this static instrument cannot check, and why. Printed on every run
// (G4: "reports which requirements it cannot check and why, on its face").
const CANNOT_CHECK = [
  { req: 'F3', name: 'focus visible / keyboard reachability (L4)', why: 'needs a rendered page and a browser; run the harness (englyn/testing/harness) or the browse skill' },
  { req: 'F4', name: 'colour never the sole carrier; contrast', why: 'needs computed styles; W+W runs contrast-check.mjs in its build, external targets are unchecked here' },
  { req: 'F5', name: 'charts carry role="img" + full label + data table', why: 'presence is checkable, adequacy of the label is not; no chart on the reference site to calibrate' },
  { req: 'R1', name: 'numbers spoken, from spoken_number.py', why: 'needs the source figures to compare the spoken form against' },
  { req: 'R5', name: 'action-safety tier announced before activation', why: 'needs interaction and a screen reader (L5)' },
  { req: 'R7', name: 'narration section is CURRENT for the page', why: 'presence is checked; currency needs the source of truth' },
  { req: 'L3', name: 'axe-core run', why: 'not run inside this static checker — run englyn/testing/harness/englyn_axe.py (npm run a11y:axe), which serves dist over localhost' },
  { req: 'L5', name: 'what a screen reader actually announces (rotor lists, landmark surfacing, orientation)', why: 'only a real AT observes it — VoiceOver+Safari is the one pair this operation can run; NVDA, JAWS, TalkBack, Narrator are untested' },
];

const BANNED_LINK_TEXT = new Set(['click here', 'here', 'click', 'read more', 'more']);

// ---------------------------------------------------------------------------
// WS6a Task 1 — enum membership (spec/VOCABULARY.md, ruled 2026-08-18).
// "A conforming page MUST NOT emit a data-englyn-* value outside the
// published enum, and a conforming checker MUST validate value MEMBERSHIP,
// not merely attribute PRESENCE." Single source of the value shapes so there
// is exactly one place to change them when Micah rules the next one.
//
// Free-text attrs (`consequence`, `receipt`) are exempt BY DECLARATION — the
// `free-text` kind below is the explicit declared value space the spec
// requires; it is never an omission.
// ---------------------------------------------------------------------------
const ENGLYN_VOCABULARY = {
  // CLOSED enum, amended by Micah 2026-08-18 from MEASUREMENT of site/src.
  // The first cut specified alert/stat/chart (zero uses) and excluded ten values
  // the site ships — both the over- and under-shoot the amendment fixes.
  // `card` was briefly Reserved and that was wrong: it ships on the homepage, and
  // Reserved means "named, not specified", which fails a live value. Admitted.
  // RESERVED, not specified: alert, stat, chart — zero uses, not shipped contracts.
  // DELIBERATELY EXCLUDED as markup MISUSE, so this check surfaces them:
  //   receipt, log, profile (content types, not regions — and `receipt` collides
  //   with the data-englyn-receipt attribute) and error (a state; belongs with
  //   `status` or in `state`).
  role: { kind: 'enum', values: ['narration', 'section', 'action', 'status', 'citations', 'run-out', 'media', 'collection', 'disclosure', 'hero', 'banner', 'bio', 'card'] },
  primitive: { kind: 'enum', values: ['perceive', 'act', 'announce', 'audit', 'interrupt', 'oversee'] }, // exactly six, closed
  priority: { kind: 'positive-integer' },
  consumer: { kind: 'enum', values: ['assistive-technology', 'agent', 'both'] },
  // `generated` added 2026-08-18: the TTS pipeline (DEC-WW-ENGLYN-TTS-VOICE-001)
  // emits it on every synthesised reading. It was shipping in code before the
  // enum carried it — the code-ahead-of-spec divergence, one day fresh.
  source: { kind: 'enum', values: ['manual', 'generated', 'llm-draft', 'research-pipeline', 'analytics', 'build-script'] },
  consequence: { kind: 'free-text' },
  receipt: { kind: 'free-text' },
};
// RESERVED (VOCABULARY.md "Reserved"): named, not specified. MUST NOT be
// failed for omission; if present, the VALUE is CANNOT-CHECK, never FAILS.
const ENGLYN_RESERVED = new Set(['severity', 'confidence', 'value', 'state']);
// PROPOSED (VOCABULARY.md "Proposed — drafted, not ruled", e.g. `tier`,
// `layer`): also named, not a stray/unknown attribute — but "A conforming
// checker MUST return CANNOT-CHECK on these, never a pass and never a fail"
// per that section's own governing text. Distinct from RESERVED (which is a
// closed, no-obligation set) — Proposed attrs are drafts awaiting a ruling,
// and Task 4 below reads `tier` for exactly that reason.
const ENGLYN_PROPOSED = new Set(['tier', 'layer']);
// Unresolved build-time template value ("{expr}" or "${expr}") — cannot be
// statically resolved, so it is CANNOT-CHECK, never a pass and never a fail.
const TEMPLATE_EXPR_RE = /[{}]/;

function checkEnumMembership(html) {
  const attrRe = /\bdata-englyn-([a-z-]+)\s*=\s*"([^"]*)"/gi;
  let examined = 0;
  const violations = [];
  const cannotCheck = [];
  let m;
  while ((m = attrRe.exec(html))) {
    const name = m[1].toLowerCase();
    const value = m[2];
    examined += 1;
    if (ENGLYN_RESERVED.has(name)) { cannotCheck.push(`data-englyn-${name}="${value}" is RESERVED (spec/VOCABULARY.md) — value not evaluated`); continue; }
    if (ENGLYN_PROPOSED.has(name)) { cannotCheck.push(`data-englyn-${name}="${value}" is PROPOSED, not ruled (spec/VOCABULARY.md "Proposed") — CANNOT-CHECK per that section's own rule`); continue; }
    const spec = ENGLYN_VOCABULARY[name];
    if (!spec) { violations.push(`data-englyn-${name}="${value}" — not a named attribute in spec/VOCABULARY.md`); continue; }
    if (TEMPLATE_EXPR_RE.test(value)) { cannotCheck.push(`data-englyn-${name}="${value}" is an unresolved template expression — cannot statically validate`); continue; }
    if (spec.kind === 'free-text') continue; // exempt by declaration
    if (spec.kind === 'positive-integer') {
      if (!/^[1-9]\d*$/.test(value)) violations.push(`data-englyn-${name}="${value}" is not a positive integer`);
      continue;
    }
    if (!spec.values.includes(value)) violations.push(`data-englyn-${name}="${value}" is outside the enum {${spec.values.join(', ')}}`);
  }
  return { examined, violations, cannotCheck };
}

// ---------------------------------------------------------------------------
// WS6a Task 4 — the typed tier path (spec/CRITERIA-DRAFT-2026-08-18.md §4,
// ruled). Prefer `data-englyn-tier`; else derive from `data-englyn-severity`
// (matching englyn_baseline_scan.py's A4 read/write split: high/critical is a
// write, everything else is T1 read-only); prose regex is LAST RESORT only.
//
// Micah's reasoning, verbatim, because the reasoning is the criterion: "a
// prose regex can be accidentally wrong — correct prose, wrong pattern.
// Nobody accidentally declares T1. The attribute moves the failure from the
// instrument to the claimant." When prose is the DECIDING mechanism the
// verdict is CANNOT-CHECK, never a pass — the failure moves to the claimant,
// it doesn't just disappear.
//
// REQUIRED: when `tier` and `severity` are both present and disagree, the
// verdict is CANNOT-CHECK — a conflict between two typed declarations is not
// a pass and not a fail.
// ---------------------------------------------------------------------------
const VALID_TIERS = new Set(['T1', 'T2', 'T3']);
const WRITE_SEVERITIES = new Set(['high', 'critical']);
function deriveTier(tagText, proseConsequence) {
  const tierAttr = extractAttr(tagText, 'data-englyn-tier');
  const severityAttr = extractAttr(tagText, 'data-englyn-severity');
  const tierClass = tierAttr === 'T1' ? 'read' : (tierAttr === 'T2' || tierAttr === 'T3') ? 'write' : null;
  const severityClass = severityAttr ? (WRITE_SEVERITIES.has(severityAttr) ? 'write' : 'read') : null;
  if (tierClass && severityClass && tierClass !== severityClass) {
    return { tier: tierAttr, severity: severityAttr, mechanism: 'conflict', conflict: true };
  }
  if (tierAttr && VALID_TIERS.has(tierAttr)) return { tier: tierAttr, mechanism: 'typed-tier', conflict: false };
  if (severityAttr) return { tier: severityClass === 'write' ? 'T2/T3' : 'T1', severity: severityAttr, mechanism: 'typed-severity', conflict: false };
  if (proseConsequence != null) {
    const navigational = /^(navigates to|opens)\b/i.test(proseConsequence.trim()) && /read-only|nothing is (saved|sent)/i.test(proseConsequence);
    if (navigational) return { tier: 'T1', mechanism: 'prose', conflict: false };
  }
  return { tier: null, mechanism: 'none', conflict: false };
}

// ---------------------------------------------------------------------------
// WS6a Task 2 — text-transform speech safety (spec/CRITERIA-DRAFT-2026-08-18.md
// §1, ruled). WebKit hands the accessibility tree the STYLE-TRANSFORMED
// string: "What this buys us" (CSS text-transform: uppercase) is spoken
// "What this buys U-S." Confirmed 6x across 4 pages while axe/html-validate/
// englyn-check (pre-fix) were all green — the defect lives in the gap between
// the rendered string and the authored one, which no markup linter can see.
// It lands on the busiest channel there is: 71.6% of screen-reader users
// navigate by heading (WebAIM #10).
//
// Approach follows englyn/testing/harness/scan_text_transform_speech.py:
// regex-parse CSS rule bodies for the transform and collect selectors — no
// CSS parser, same static-analysis ceiling as the rest of this file — then
// decide whether a selector REACHES a heading or a narration region
// ([data-englyn-role="narration"], .sr-only — named explicitly, verbatim
// from the criterion) by (a) a direct tag-name reference in the selector, or
// (b) a class/attribute cross-reference against the actual elements on this
// page (covers Astro's scoped `.caps`-style utility classes and its
// data-astro-cid-* attribute selectors).
// ---------------------------------------------------------------------------
function extractUppercaseCssRules(cssText) {
  const rules = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(cssText))) {
    const tt = m[2].match(/text-transform\s*:\s*(uppercase|capitalize)/i);
    if (!tt) continue;
    for (const sel of m[1].split(',')) {
      const s = sel.trim().replace(/\s+/g, ' ');
      if (s && s.length < 200 && !s.startsWith('@')) rules.push({ selector: s, transform: tt[1].toLowerCase() });
    }
  }
  return rules;
}
// AMENDED 2026-08-18: this check tested the WRONG THING and the criterion was
// too broad. It asked whether a selector "reaches a heading" and fired on eleven
// selectors that Micah had explicitly ruled KEEP -- "Listen", "Read", "Watch",
// "Liner Notes", "About this recording", "Economica", "Wax+Wires". None contains
// a risk word, so none can produce the defect.
//
// The proxy failed twice over:
//   (a) selAttrs matched an ATTRIBUTE NAME (data-astro-cid-*) against any heading
//       on the page. Astro stamps that attribute on every element in a component,
//       so any label sharing a component with a heading returned true.
//   (b) heading-reach could never see .liner-notes__link, which held FOUR live
//       instances -- "Two of Us", "Never Tear Us Apart", "Hope for Us",
//       "Shake It Out" -- because those are <p> children, not headings.
//
// So it now tests CONTENT: the rendered text under an uppercase selector, against
// the risk-word list in scripts/speech-risk-words.json. Narrower (a one-word label
// passes) and BROADER where it matters (song titles fail). Not tuning -- the old
// check measured a correlate; this one measures the defect.
const SPEECH_RISK = JSON.parse(
  readFileSync(new URL('./speech-risk-words.json', import.meta.url), 'utf8'),
);
const SPEECH_RISK_WORDS = new Set([...SPEECH_RISK.observed, ...SPEECH_RISK.likely]);

function textSpeechRisks(text) {
  const hits = new Set();
  for (const w of text.matchAll(/\b[A-Za-z]{2,3}\b/g)) {
    const lw = w[0].toLowerCase();
    if (SPEECH_RISK_WORDS.has(lw)) hits.add(lw);
  }
  return [...hits];
}

// Rendered text of every element whose class the selector names. Deliberately
// does NOT cross-reference headings -- that was the proxy.
function textsForSelector(selector, html) {
  const classes = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  const out = [];
  for (const cls of classes) {
    const re = new RegExp(`class="[^"]*\\b${cls.replace(/-/g, '\\-')}\\b[^"]*"[^>]*>([^<]{1,400})`, 'g');
    for (const m of html.matchAll(re)) {
      const t = m[1].replace(/\s+/g, ' ').trim();
      if (t) out.push(t);
    }
  }
  return out;
}

function selectorReachesHeading(selector, headingTagTexts) {
  if (/(^|[\s>+~,])h[1-6](?=[\s.:#[>+~,]|$)/i.test(selector)) return true;
  const selClasses = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((mm) => mm[1]);
  for (const tagText of headingTagTexts) {
    const elClasses = new Set((extractAttr(tagText, 'class') || '').split(/\s+/).filter(Boolean));
    if (selClasses.some((c) => elClasses.has(c))) return true;
  }
  return false;
}
function selectorReachesNarration(selector) {
  const selClasses = [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((mm) => mm[1]);
  if (selClasses.includes('sr-only')) return true;
  if (/data-englyn-role\s*=\s*['"]?narration['"]?/i.test(selector)) return true;
  return false;
}
let _externalCssCache = null;
function getExternalCssSources() {
  if (_externalCssCache !== null) return _externalCssCache;
  let sources = [];
  try {
    if (existsSync(distDir) && statSync(distDir).isDirectory()) {
      sources = globSync('**/*.css', { cwd: distDir }).map((p) => ({ source: p, text: readFileSync(path.join(distDir, p), 'utf8') }));
    }
  } catch { /* leave empty — the CSS-found gate reports CANNOT-CHECK */ }
  _externalCssCache = sources;
  return sources;
}

// ---------------------------------------------------------------------------
// WS6a Task 3 — known-zero is not unknown (spec/CRITERIA-DRAFT-2026-08-18.md
// §2). DRAFT AND UNRULED — per the manifest and per VOCABULARY.md's own rule
// for proposed-not-ruled criteria, this ALWAYS returns CANNOT-CHECK, never a
// pass and never a fail, regardless of what it finds. It exists so the
// measurement is visible before Micah rules it, not to gate the build.
// ---------------------------------------------------------------------------
function checkKnownZero(html) {
  const elRe = /<(\w+)\b([^<>]*(?:data-englyn-role\s*=\s*"stat"|data-englyn-value\s*=\s*"[^"]*")[^<>]*)>/gi;
  const results = [];
  let m;
  while ((m = elRe.exec(html))) {
    const fullTag = m[0];
    const tagName = m[1];
    const closeIdx = findMatchingClose(html, tagName, m.index + fullTag.length);
    const inner = closeIdx === -1 ? '' : html.slice(m.index + fullTag.length, closeIdx);
    const text = stripTags(inner);
    const zeroLike = /^(0|-|—|N\/A|)$/i.test(text.trim());
    if (!zeroLike) continue;
    const hasSource = !!extractAttr(fullTag, 'data-englyn-source');
    const hasUnknownState = /data-englyn-state\s*=\s*"(unknown|gap)"/i.test(fullTag);
    results.push({ tagName, text: text || '(empty)', backed: hasSource || hasUnknownState });
  }
  return results;
}

// ---------------------------------------------------------------------------
// WS6a Task 7 — heading-list sufficiency lint. 71.6% of screen-reader users
// navigate by heading (WebAIM #10), so "does the outline alone read as a
// briefing" is the highest-value experience check available. HEURISTIC, not
// a verdict — always CANNOT-CHECK, a lead for a human, never a FAILS.
// ---------------------------------------------------------------------------
const HL_STOPWORDS = new Set(['a', 'an', 'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'it', 'this', 'that', 'with', 'from', 'by', 'at', 'as', 'be', 'was', 'were', 'what', 'how', 'why', 'not']);
function hlContentWords(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter((w) => w.length > 2 && !HL_STOPWORDS.has(w));
}
function checkHeadingListSufficiency(html, narrationInner) {
  const headingTexts = [...html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)].map((m) => stripTags(m[1])).filter(Boolean);
  const narrationText = stripTags(narrationInner || '');
  if (headingTexts.length === 0 || !narrationText) return null;
  const headingWords = new Set(headingTexts.flatMap(hlContentWords));
  const narrationWords = new Set(hlContentWords(narrationText));
  const genericCount = headingTexts.filter((t) => hlContentWords(t).length <= 1).length;
  const overlap = [...headingWords].filter((w) => narrationWords.has(w));
  const coverage = headingWords.size ? overlap.length / headingWords.size : 0;
  return { headingCount: headingTexts.length, headingWordCount: headingWords.size, coverage, genericCount };
}

function findHtmlFiles(dir) {
  return globSync('**/*.html', { cwd: dir }).map((p) => path.join(dir, p));
}

function isEssayPage(relPath) {
  return /^essays\/[^/]+\/index\.html$/.test(relPath);
}

// The essay's own <h2> "section map" (englyn/skills/englyn-essay-page/SKILL.md)
// is scoped to the essay's argument — its own heading sequence inside the
// rendered MDX body (<article class="essay-prose">) — not to shared page
// chrome (Liner Notes / Audio Narration) that also happens to render an <h2>
// outside that article. Extract just that region so those checks don't
// false-positive on headings that were never part of the essay's argument.
function extractEssayProse(html) {
  const openMatch = html.match(/<article\s+class="essay-prose"[^>]*>/i);
  if (!openMatch) return html;
  const startIdx = openMatch.index + openMatch[0].length;
  const closeIdx = findMatchingClose(html, 'article', startIdx);
  return closeIdx === -1 ? html.slice(startIdx) : html.slice(startIdx, closeIdx);
}

// Extract heading tags in document order: [{level, raw}]
function extractHeadings(html) {
  const out = [];
  const re = /<h([1-6])\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ level: Number(m[1]), index: m.index });
  return out;
}

function extractAttr(tag, name) {
  const m = tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

function stripTags(s) {
  return s.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Find balanced aria-hidden="true" regions and return their inner HTML.
function findAriaHiddenRegions(html) {
  const regions = [];
  const openRe = /<(\w+)((?:\s+[^<>]*?)?\baria-hidden\s*=\s*"true"[^<>]*?)?>/gi;
  // Simpler two-pass: find every opening tag, check for aria-hidden="true" in it.
  const tagRe = /<(\w+)([^<>]*)>/g;
  let m;
  const stack = [];
  while ((m = tagRe.exec(html))) {
    const [full, tagName, attrs] = m;
    if (full.startsWith('</')) continue;
    const selfClosing = /\/>\s*$/.test(full) || ['img', 'br', 'hr', 'input', 'meta', 'link'].includes(tagName.toLowerCase());
    const hasAriaHidden = /aria-hidden\s*=\s*"true"/i.test(attrs);
    if (hasAriaHidden && !selfClosing) {
      // Find the matching close tag by depth-tracking this tag name from here.
      const closeStart = findMatchingClose(html, tagName, m.index + full.length);
      if (closeStart !== -1) {
        regions.push(html.slice(m.index + full.length, closeStart));
      }
    }
  }
  return regions;
}

function findMatchingClose(html, tagName, fromIndex) {
  const re = new RegExp(`<(/?)${tagName}\\b[^<>]*>`, 'gi');
  re.lastIndex = fromIndex;
  let depth = 1;
  let m;
  while ((m = re.exec(html))) {
    const selfClosing = /\/>\s*$/.test(m[0]);
    if (selfClosing) continue;
    if (m[1] === '/') {
      depth -= 1;
      if (depth === 0) return m.index;
    } else {
      depth += 1;
    }
  }
  return -1;
}

// checks: {req, scope, name, pass, detail} — scope ∈ general | vocab | ww.
//   general: any HTML page (WCAG-mapped)      vocab: needs the data-englyn-* / Rule-7 vocabulary (spec-general)
//   ww:      assumes the Wax+Wires site's own structure or editorial rules (only with --ww / build mode)
function checkHtml(html, relPath) {
  const checks = [];
  const essay = WW && isEssayPage(relPath); // essay grammar is a W+W editorial contract
  const push = (req, scope, name, pass, detail) => checks.push({ req, scope, name, pass, verdict: verdictOf(pass), detail });

  // 1. html lang
  const htmlTagMatch = html.match(/<html\b[^>]*>/i);
  const lang = htmlTagMatch ? extractAttr(htmlTagMatch[0], 'lang') : null;
  push('WCAG 3.1.1', 'general', 'html lang attribute', !!lang, lang ? `lang="${lang}"` : 'missing <html lang="...">');

  // 2. title present + non-empty
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : '';
  push('WCAG 2.4.2', 'general', 'non-empty <title>', !!title, title || 'missing/empty <title>');

  // 3. meta description present + non-empty
  const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)
    || html.match(/<meta\s+content="([^"]*)"\s+name="description"/i);
  const desc = descMatch ? descMatch[1].trim() : '';
  push('R7', 'vocab', 'non-empty meta description', !!desc, desc ? `${desc.slice(0, 60)}...` : 'missing/empty meta description');

  // 4. exactly one h1
  const headings = extractHeadings(html);
  const h1s = headings.filter((h) => h.level === 1);
  push('F1', 'general', 'exactly one <h1>', h1s.length === 1, `found ${h1s.length}`);

  // 5. heading order sanity (no skipped levels going deeper)
  // WS6a Task 6: zero headings is nothing to measure a jump against — CANNOT-CHECK,
  // not a vacuous pass. (Also covered independently by check 4's h1 count.)
  let prevLevel = 0;
  const jumps = [];
  for (const h of headings) {
    if (prevLevel > 0 && h.level > prevLevel + 1) {
      jumps.push(`h${prevLevel} -> h${h.level}`);
    }
    prevLevel = h.level;
  }
  push('F1', 'general', 'heading order sanity (no skipped levels)',
    headings.length === 0 ? null : jumps.length === 0,
    headings.length === 0 ? 'no headings on page — nothing to check' : `${headings.length} heading(s) examined, ${jumps.length ? jumps.join(', ') : 'no skips'}`);

  // 6. landmark: <main> present
  const mainCount = (html.match(/<main\b/gi) || []).length;
  push('F1', 'general', 'exactly one <main> landmark', mainCount === 1, `found ${mainCount}`);

  // 6b. duplicate landmark elements without a distinguishing label (APG landmark
  // regions / ARIA13). STATIC: counts <header>/<nav>/<footer>/<aside> tags; whether a
  // nested <header> actually surfaces as a second banner in the rotor is
  // AT-dependent (HTML-AAM says generic inside main/article; WebKit has shipped
  // the bug) — so a duplicate here is a FLAG for the harness, never a FAILS.
  for (const tag of ['header', 'nav', 'footer', 'aside']) {
    const tags = html.match(new RegExp(`<${tag}\\b[^>]*>`, 'gi')) || [];
    if (tags.length > 1) {
      const unlabelled = tags.filter((t) => !extractAttr(t, 'aria-label') && !extractAttr(t, 'aria-labelledby'));
      push('F1', 'general', `duplicate <${tag}> elements carry distinguishing labels`, unlabelled.length <= 1 ? true : null,
        `${tags.length} <${tag}>, ${unlabelled.length} unlabelled — whether both surface as landmarks depends on nesting and the AT; observe in the rotor (harness Layer B)`);
    }
  }

  // 7. img alt attributes present (empty string ok for decorative)
  // WS6a Task 6: this is a QUALITY check over whatever images exist — "do the
  // images we have carry alt" is a claim that needs at least one image to be
  // meaningful. Zero images is CANNOT-CHECK, not a vacuous pass.
  const imgTags = html.match(/<img\b[^>]*>/gi) || [];
  const missingAlt = imgTags.filter((t) => extractAttr(t, 'alt') === null);
  push('WCAG 1.1.1', 'general', 'every <img> has alt attribute',
    imgTags.length === 0 ? null : missingAlt.length === 0,
    imgTags.length === 0 ? 'no <img> on page — nothing to check' : `${imgTags.length - missingAlt.length}/${imgTags.length} img(s) have alt${missingAlt.length ? `; missing (e.g. ${missingAlt[0].slice(0, 80)})` : ''}`);

  // 8. link text sanity ("click here" etc fail, unless aria-label overrides)
  // Same reasoning as check 7: quality of existing links, not a prohibition —
  // zero anchors is CANNOT-CHECK, not a vacuous pass.
  const anchorRe = /<a\b([^<>]*)>(.*?)<\/a>/gis;
  const badLinks = [];
  let anchorCount = 0;
  let am;
  while ((am = anchorRe.exec(html))) {
    anchorCount += 1;
    const attrs = am[1];
    const inner = stripTags(am[2]).toLowerCase();
    const hasAriaLabel = /aria-label\s*=\s*"[^"]+"/i.test(attrs);
    if (!hasAriaLabel && BANNED_LINK_TEXT.has(inner)) {
      badLinks.push(inner);
    }
  }
  push('WCAG 2.4.4', 'general', 'link text sanity (no bare "click here"/"here"/etc)',
    anchorCount === 0 ? null : badLinks.length === 0,
    anchorCount === 0 ? 'no <a> on page — nothing to check' : `${anchorCount} link(s) examined, ${badLinks.length ? `${badLinks.length} bad: ${[...new Set(badLinks)].join(', ')}` : '0 bad'}`);

  // 9. tabindex > 0 ban — WS6a Task 6: this is a PROHIBITION ("no tabindex may
  // exceed 0"), not a quality-of-existing-items check. Zero tabindex
  // attributes on the page trivially and correctly satisfies the prohibition
  // (there is nothing to violate it), so — unlike checks 7/8 above — this
  // stays CONFORMS on zero, same reasoning as check E (role=alert) below.
  const tabindexMatches = [...html.matchAll(/tabindex\s*=\s*"(-?\d+)"/gi)];
  const positiveTabindex = tabindexMatches.filter((m) => Number(m[1]) > 0);
  push('WCAG 2.4.3', 'general', 'no tabindex > 0', positiveTabindex.length === 0,
    `${tabindexMatches.length} tabindex attribute(s) on page, ${positiveTabindex.length} positive${positiveTabindex.length ? ` (${positiveTabindex.map((m) => m[1]).join(', ')})` : ''}`);

  // 10. no focusable children inside aria-hidden regions (heuristic, regex-based).
  // WS6a Task 6: also a PROHIBITION, same reasoning as check 9 — zero
  // aria-hidden regions means there is nothing for the prohibition to have
  // been violated in, which is a real (not vacuous) CONFORMS.
  const hiddenRegions = findAriaHiddenRegions(html);
  const focusableRe = /<a\b[^<>]*\bhref\s*=|<button\b|<input\b|<select\b|<textarea\b|tabindex\s*=\s*"(?!-1)/i;
  const violatingRegions = hiddenRegions.filter((r) => focusableRe.test(r));
  push('WCAG 4.1.2', 'general', 'no focusable descendants inside aria-hidden', violatingRegions.length === 0, violatingRegions.length ? `${violatingRegions.length} aria-hidden region(s) contain a focusable element` : `${hiddenRegions.length} aria-hidden region(s) checked`);

  // 11. Rule 7 sr-only narration section present — BASE check, all pages.
  // Was essay-scoped only; widened 2026-07-20 (Sonnet 5 build engineer,
  // launch-day pass) once index/about/beliefs/colophon/now/404 got their
  // own Rule-7 briefings — the foundation skill (englyn/skills/englyn-accessible-page)
  // requires this on every page, not just englyn/skills/englyn-essay-page's essays.
  // 2026-08-17 (RECOMMENDATIONS-V0_1_0 A4): the block is a HEADING, not a live region.
  // `aria-live="polite"` on a static block is inert (skill Appendix #7–9) and a
  // labelled region would add a landmark to a rotor already carrying five; an
  // sr-only <h2> puts the briefing in the heading list 71.6% of users navigate by
  // (WebAIM #10). So: sr-only + data-englyn-role="narration", NO aria-live, and an
  // <h2> as first meaningful child.
  const sectionTags = html.match(/<section\b[^>]*>/gi) || [];
  const narrationTag = sectionTags.find((t) => /\bsr-only\b/.test(extractAttr(t, 'class') || '') && /data-englyn-role\s*=\s*"narration"/i.test(t));
  let narrationInner = '';
  if (narrationTag) {
    const start = html.indexOf(narrationTag) + narrationTag.length;
    const close = findMatchingClose(html, 'section', start);
    narrationInner = close === -1 ? html.slice(start) : html.slice(start, close);
  }
  const narrationHasH2 = /^\s*(<[^>]+>\s*)*<h2\b/i.test(narrationInner) || /<h2\b/i.test(narrationInner.slice(0, 200));
  const narrationLive = narrationTag ? /aria-live\s*=/i.test(narrationTag) : false;
  push('R7', 'vocab', 'Rule 7 sr-only narration section present', !!narrationTag, narrationTag ? 'found' : 'missing <section class="sr-only" data-englyn-role="narration">');
  if (narrationTag) {
    push('R7', 'vocab', 'Rule 7 narration is a heading, not a live region', narrationHasH2 && !narrationLive,
      `${narrationHasH2 ? 'h2 present' : 'NO <h2> as first child'}${narrationLive ? '; aria-live present (inert on a static block — remove)' : ''}`);

    // A. R7 narration substance (rec A3-iii / A4): the sr-only block must carry
    // real content, not a copy of the h1 or the meta description dressed up as
    // narration. Degenerate guard: an empty/short block naturally fails the
    // word-count floor before the equality checks even run.
    const narrationText = stripTags(narrationInner);
    const wordCount = narrationText ? narrationText.split(/\s+/).filter(Boolean).length : 0;
    const h1Match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
    const h1Text = h1Match ? stripTags(h1Match[1]) : '';
    const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const sameAsH1 = !!h1Text && norm(narrationText) === norm(h1Text);
    const sameAsDesc = !!desc && norm(narrationText) === norm(desc);
    const substancePass = wordCount >= 20 && !sameAsH1 && !sameAsDesc;
    let substanceDetail;
    if (wordCount < 20) substanceDetail = `only ${wordCount} word(s), need >= 20`;
    else if (sameAsH1) substanceDetail = 'narration text is identical to the <h1> text';
    else if (sameAsDesc) substanceDetail = 'narration text is identical to the meta description';
    else substanceDetail = `${wordCount} words, distinct from h1/description`;
    push('R7', 'vocab', 'Rule 7 narration has substance (not a stub/duplicate)', substancePass, substanceDetail);
  }

  // 12. data-englyn-role / data-englyn-primitive present somewhere (R10 agent layer).
  // W+W build mode keeps the historical essay-only scope; a general target is being
  // asked "does this page carry the Englyn agent layer at all", so every page is checked.
  if (essay || !WW) {
    const englynRoleCount = (html.match(/data-englyn-role\s*=/gi) || []).length;
    const englynPrimitiveCount = (html.match(/data-englyn-primitive\s*=/gi) || []).length;
    const tag = essay ? '[essay] ' : '';
    push('R10', 'vocab', `${tag}data-englyn-role present`, englynRoleCount > 0, `${englynRoleCount} occurrence(s)`);
    push('R10', 'vocab', `${tag}data-englyn-primitive present`, englynPrimitiveCount > 0, `${englynPrimitiveCount} occurrence(s)`);
  }

  // F. WS6a Task 1 — enum membership (spec/VOCABULARY.md, ruled). Presence is
  // no longer enough: a data-englyn-* value outside the published enum FAILS,
  // naming the attribute. RESERVED (severity/confidence/value/state) and
  // PROPOSED (tier/layer) attributes are CANNOT-CHECK per VOCABULARY.md's own
  // governing text, never FAILS for existing at all.
  const enumResult = checkEnumMembership(html);
  if (enumResult.examined === 0) {
    push('VOCAB', 'vocab', 'Enum membership (data-englyn-* values)', null, 'no data-englyn-* attributes on page — nothing to validate');
  } else {
    push('VOCAB', 'vocab', 'Enum membership (data-englyn-* values)', enumResult.violations.length === 0,
      `${enumResult.examined} data-englyn-* attribute(s) examined, ${enumResult.violations.length} outside their declared value space`
      + (enumResult.violations.length ? `: ${enumResult.violations.join('; ')}` : '')
      + (enumResult.cannotCheck.length ? `; ${enumResult.cannotCheck.length} CANNOT-CHECK (reserved/proposed/template — not evaluated): ${enumResult.cannotCheck.join('; ')}` : ''));
  }

  // G. WS6a Task 2 — text-transform speech safety (spec/CRITERIA-DRAFT-2026-08-18.md
  // §1, ruled). See extractUppercaseCssRules / selectorReaches* above for the
  // full defect writeup. No CSS anywhere on the page (no inline <style>, no
  // dist/**/*.css reachable) is CANNOT-CHECK, never a clean pass.
  const pageStyleSources = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m, i) => ({ source: `${relPath} inline <style> #${i + 1}`, text: m[1] }));
  const cssSources = [...pageStyleSources, ...getExternalCssSources()];
  if (cssSources.length === 0) {
    push('SPEECH', 'general', 'text-transform speech safety (headings/narration)', null, 'no CSS found (no inline <style> blocks, no dist/**/*.css reachable) — cannot evaluate');
  } else {
    const headingTagTexts = [...html.matchAll(/<h[1-6]\b[^>]*>/gi)].map((m) => m[0]);
    const hits = [];
    let ruleCount = 0;
    let applicable = 0;      // selector names a class that EXISTS on this page
    let textsChecked = 0;    // and that class yielded rendered text
    for (const src of cssSources) {
      const rules = extractUppercaseCssRules(src.text);
      ruleCount += rules.length;
      for (const r of rules) {
        // External CSS is site-wide, so most of its selectors do not apply to any
        // given page. "Not applicable here" and "should have resolved and did not"
        // are different states and only the second is CANNOT-CHECK -- conflating
        // them made now/index.html report CANNOT-CHECK when it is genuinely clean.
        const classes = [...r.selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
        const present = classes.some((c) =>
          new RegExp(`class="[^"]*\\b${c.replace(/-/g, '\\-')}\\b[^"]*"`).test(html));
        if (!present) continue;
        applicable += 1;
        const texts = textsForSelector(r.selector, html);
        textsChecked += texts.length;
        for (const t of texts) {
          const risks = textSpeechRisks(t);
          if (risks.length) {
            hits.push(`${r.transform} on "${r.selector}" uppercases "${t.slice(0, 60)}" which contains ${risks.map((x) => `"${x}" -> "${x.toUpperCase().split('').join('-')}"`).join(', ')} (${src.source})`);
          }
        }
        // A narration/.sr-only region is announced verbatim, so ANY transform on
        // it is a defect regardless of content -- the authored string is the
        // contract there.
        if (selectorReachesNarration(r.selector)) hits.push(`${r.transform} on "${r.selector}" reaches a narration/.sr-only region (${src.source})`);
      }
    }
    // Denominator on the face of it, all three numbers. A check that stops finding
    // things because it stopped looking is the failure mode.
    const detail = `${ruleCount} uppercase selector(s) across ${cssSources.length} CSS source(s), ${applicable} applicable to this page, ${textsChecked} rendered string(s) tested, ${hits.length} hit(s)`;
    if (applicable > 0 && textsChecked === 0) {
      push('SPEECH', 'general', 'text-transform speech safety (headings/narration)', null,
        `${detail} — ${applicable} selectors name classes present on this page but resolved to ZERO rendered strings, so nothing was actually tested. CANNOT-CHECK, not a pass.`);
    } else if (applicable === 0) {
      push('SPEECH', 'general', 'text-transform speech safety (headings/narration)', true,
        `${detail} — no uppercase selector applies to this page. Genuine pass: there is no transformed text here to mis-speak.`);
    } else {
      push('SPEECH', 'general', 'text-transform speech safety (headings/narration)', hits.length === 0,
        detail + (hits.length ? `: ${hits.join('; ')}` : ' — no uppercased string contains a word a screen reader reads as an initialism'));
    }
  }

  // H. WS6a Task 3 — known-zero is not unknown (spec/CRITERIA-DRAFT-2026-08-18.md
  // §2). DRAFT AND UNRULED — always CANNOT-CHECK, never FAILS and never a pass,
  // regardless of outcome. The measurement is surfaced so Micah can rule it;
  // this check must never gate the build.
  const zeroResults = checkKnownZero(html);
  if (zeroResults.length === 0) {
    push('DRAFT', 'vocab', 'Known-zero measurement (DRAFT, unruled — spec/CRITERIA-DRAFT-2026-08-18.md §2)', null, 'no data-englyn-role="stat" or data-englyn-value region on this page');
  } else {
    const unbacked = zeroResults.filter((r) => !r.backed);
    push('DRAFT', 'vocab', 'Known-zero measurement (DRAFT, unruled — spec/CRITERIA-DRAFT-2026-08-18.md §2)', null,
      `DRAFT criterion, unruled — CANNOT-CHECK regardless of outcome. ${zeroResults.length} zero-like stat/value region(s) examined, ${unbacked.length} lack data-englyn-source or an explicit unknown state`
      + (unbacked.length ? `: ${unbacked.map((r) => `<${r.tagName}> "${r.text}"`).join(', ')}` : ''));
  }

  // I. WS6a Task 7 — heading-list sufficiency lint. HEURISTIC — always
  // CANNOT-CHECK, a lead for a human read-through, never a verdict.
  const hlResult = checkHeadingListSufficiency(html, narrationInner);
  if (!hlResult) {
    push('R10', 'vocab', 'Heading-list sufficiency (heuristic lead, not a verdict)', null,
      headings.length === 0 ? 'no headings on page — nothing to measure' : 'no narration block to compare against — nothing to measure');
  } else {
    const thin = hlResult.genericCount > 0 || hlResult.coverage < 0.3;
    push('R10', 'vocab', 'Heading-list sufficiency (heuristic lead, not a verdict)', null,
      `HEURISTIC, not a verdict — a lead for a human, never a FAILS. ${hlResult.headingCount} heading(s), ${hlResult.headingWordCount} distinct content word(s), ${Math.round(hlResult.coverage * 100)}% also appear in narration, ${hlResult.genericCount} heading(s) with <=1 content word.`
      + (thin ? ' Outline may read as thin against the narration — worth a human read-through.' : ' Outline reads reasonably informative against the narration.'));
  }

  if (essay) {
    // 13. section headings carry data-englyn-priority
    // Scoped to the essay's own <h2> sequence (not shared page chrome —
    // see extractEssayProse). A continuous essay with zero section breaks
    // is valid (englyn/skills/englyn-essay-page/SKILL.md doesn't mandate a
    // minimum section count) — that's an "n/a" pass, same as check 14 below.
    const proseHtml = extractEssayProse(html);
    // Scoped to data-englyn-role="section" h2s only — a Sources/citations h2
    // (data-englyn-role="citations", data-englyn-primitive="audit") is a
    // trailing reference list, not a numbered narrative movement, so it
    // carries neither data-englyn-priority nor a "Section/Movement N of M."
    // marker by design. Counting it here would fail both checks below for
    // every essay that cites sources (authored-intelligence,
    // delegation-feedback-loop).
    const h2Tags = (proseHtml.match(/<h2\b[^>]*>/gi) || []).filter((t) => /data-englyn-role\s*=\s*"section"/i.test(t));
    const h2WithPriority = h2Tags.filter((t) => /data-englyn-priority\s*=/.test(t));
    push('R10', 'vocab', '[essay] <h2> sections carry data-englyn-priority', h2WithPriority.length === h2Tags.length, h2Tags.length ? `${h2WithPriority.length}/${h2Tags.length} h2s tagged` : 'no h2 sections, n/a');

    // 14. "Section N of M" spans consistency (scoped to essay-prose, same reasoning as check 13)
    // Recognize both "Section N of M" (h2-mapped essays like the Englyn
    // reference) and "Movement N of M" (continuous-prose essays tagged by
    // their own arc, e.g. racehorse's fence->gate->...->cost). Same grammar,
    // different vocabulary for essays with no argument headings.
    // Hardened 2026-07-20 (Doors 1&3 round, Opus finding): a Dialect B
    // essay whose markers carry data-englyn-role="section" but whose
    // position phrases are malformed/absent used to pass this check
    // vacuously (no h2s -> n/a). Now every section marker must have a
    // parseable position phrase — grammar contract:
    // englyn/skills/englyn-essay-page/SKILL.md "The grammar contract".
    const bodySections = (proseHtml.match(/data-englyn-role\s*=\s*"section"/gi) || []).length;
    const sectionSpans = [...proseHtml.matchAll(/(?:Section|Movement) (\d+) of (\d+)\./gi)].map((m) => [Number(m[1]), Number(m[2])]);
    let spanDetail = 'ok';
    let spanPass = true;
    if (sectionSpans.length === 0) {
      spanPass = h2Tags.length === 0 && bodySections === 0; // no markers at all = briefing-only essay, n/a
      spanDetail = spanPass ? 'no section markers, n/a' : `${bodySections} section marker(s)/${h2Tags.length} h2(s) but 0 parseable "Section/Movement N of M." phrases`;
    } else {
      const totals = new Set(sectionSpans.map((s) => s[1]));
      const nums = sectionSpans.map((s) => s[0]);
      const expected = Array.from({ length: sectionSpans.length }, (_, i) => i + 1);
      const sequential = JSON.stringify(nums) === JSON.stringify(expected);
      const totalMatchesCount = totals.size === 1 && [...totals][0] === sectionSpans.length;
      const totalMatchesH2 = h2Tags.length === 0 || [...totals][0] === h2Tags.length;
      const phrasesMatchMarkers = sectionSpans.length === bodySections;
      spanPass = sequential && totalMatchesCount && totalMatchesH2 && phrasesMatchMarkers;
      spanDetail = spanPass ? `${sectionSpans.length} spans, sequential 1..${[...totals][0]}, markers match` : `spans=${JSON.stringify(sectionSpans)} h2Count=${h2Tags.length} sectionMarkers=${bodySections}`;
    }
    push('R4', 'ww', '[essay] "Section/Movement N of M" spans consistent', spanPass, spanDetail);

    // 15. [essay] proportional depth — a substantial essay must carry
    // movement/section-level tagging, not just the Rule-7 briefing. Closes the
    // hole where a briefing-only essay (3 data-englyn attrs, king-of-birds/
    // racehorse pre-2026-07-20) passed identically to the reference-depth Englyn
    // essay (27). See products/wax-and-wires/englyn/skills/HARDENING_PLAN.md,
    // Door 2. Body sections = data-englyn-role="section" inside essay-prose; the
    // Rule-7 briefing is data-englyn-role="narration", so it is excluded from the
    // count. The exact movement count is the skill's editorial call (tag the
    // essay's own arc) — this gate only enforces "more than a briefing".
    const bodyParas = (proseHtml.match(/<p\b[^>]*>/gi) || []).length;
    // bodySections computed above for check 14; reused here.
    const SUBSTANTIAL_PARAS = 6; // below this, a single-section essay is fine
    const needsDepth = bodyParas > SUBSTANTIAL_PARAS;
    const depthPass = !needsDepth || bodySections >= 2;
    push('R10', 'ww', '[essay] proportional depth (body sectioning scales past the briefing)', depthPass,
      needsDepth
        ? `${bodySections} body section(s) for ${bodyParas} paragraphs (substantial essay needs >=2)`
        : `${bodyParas} paragraph(s), single-section ok`);
  }

  // B. R5 consequence co-location (rec A3-iii): every data-englyn-consequence
  // value must be non-empty and mirrored either in its aria-describedby target
  // text or, absent that, in the element's own text/aria-label. Degenerate
  // guard: zero occurrences is CANNOT-CHECK, never a silent CONFORMS.
  const consequenceElRe = /<(\w+)\b([^<>]*data-englyn-consequence\s*=\s*"([^"]*)"[^<>]*)>/gi;
  const consequenceResults = [];
  let ceMatch;
  while ((ceMatch = consequenceElRe.exec(html))) {
    const [fullTag, tagName, , consequence] = ceMatch;
    const selfClosing = /\/>\s*$/.test(fullTag) || ['img', 'br', 'hr', 'input', 'meta', 'link'].includes(tagName.toLowerCase());
    let ownText = '';
    if (!selfClosing) {
      const closeIdx = findMatchingClose(html, tagName, ceMatch.index + fullTag.length);
      const inner = closeIdx === -1 ? '' : html.slice(ceMatch.index + fullTag.length, closeIdx);
      ownText = stripTags(inner);
    }
    const describedby = extractAttr(fullTag, 'aria-describedby');
    const ariaLabel = extractAttr(fullTag, 'aria-label');
    let pass;
    let detail;
    if (!consequence.trim()) {
      pass = false; detail = 'empty consequence';
    } else if (describedby) {
      let describedText = '';
      for (const id of describedby.trim().split(/\s+/)) {
        const idMatch = html.match(new RegExp(`<(\\w+)\\b[^<>]*\\bid\\s*=\\s*"${id}"[^<>]*>`, 'i'));
        if (!idMatch) continue;
        const idClose = findMatchingClose(html, idMatch[1], idMatch.index + idMatch[0].length);
        const idInner = idClose === -1 ? '' : html.slice(idMatch.index + idMatch[0].length, idClose);
        describedText += ` ${stripTags(idInner)}`;
      }
      pass = describedText.toLowerCase().includes(consequence.trim().toLowerCase());
      detail = pass ? 'consequence mirrored in describedby text' : `describedby text does not contain consequence "${consequence.slice(0, 60)}"`;
    } else {
      const selfText = `${ownText} ${ariaLabel || ''}`.toLowerCase();
      pass = selfText.includes(consequence.trim().toLowerCase());
      // Refined 2026-08-17: a LINK is a T1 read/navigate action by construction —
      // Rule 5's table gives T1 "no review statement", and its accessible name
      // already carries the destination, so an agent-only consequence there is
      // not a two-track page; mirroring it into every nav link is the speech
      // noise the whole review is about. Buttons and controls MUST mirror.
      const isLink = tagName.toLowerCase() === 'a' && /\bhref\s*=/i.test(fullTag) && ownText.trim().length > 0;
      // The exemption is keyed on the CONSEQUENCE's form, not the tag: only a plainly
      // navigational, read-only consequence ("Navigates to … / Opens … Read-only, nothing
      // is saved or sent") on a named link is T1 by content. A link whose consequence
      // is anything else (mailto, download, third-party send) is CANNOT-CHECK — never
      // a silent pass — until it is mirrored or the tier is declared. (Refined twice
      // 2026-08-17: the first cut exempted every <a>, waiving 109 of 129 consequences.)
      //
      // WS6a Task 4 (ruled — spec/CRITERIA-DRAFT-2026-08-18.md §4): T1-ness is
      // now decided the TYPED way first (deriveTier, above) — data-englyn-tier,
      // then data-englyn-severity, and the prose regex only as a LAST RESORT.
      // When prose is the deciding mechanism the verdict is CANNOT-CHECK, never
      // a pass — "nobody accidentally declares T1," so only a typed declaration
      // earns the pass.
      const tierInfo = deriveTier(fullTag, consequence);
      if (!pass && isLink && tierInfo.tier === 'T1' && tierInfo.mechanism !== 'prose') {
        pass = true; detail = `T1 link (${tierInfo.mechanism}): name carries the destination; agent-only allowed (Rule 5: no review statement for T1)`;
      } else if (!pass && isLink && tierInfo.tier === 'T1' && tierInfo.mechanism === 'prose') {
        pass = null; detail = `T1 inferred only by prose regex (no data-englyn-tier/severity present) — CANNOT-CHECK, not a pass: "a prose regex can be accidentally wrong... nobody accidentally declares T1" (declare the tier or mirror the consequence)`;
      } else if (!pass && isLink) {
        pass = null; detail = `link with a non-T1 consequence "${consequence.slice(0, 60)}" — mirror it (aria-describedby) or declare the tier; not a pass`;
      } else detail = pass ? 'consequence present in own text/aria-label' : `consequence "${consequence.slice(0, 60)}" not found in own text or aria-label (and no aria-describedby)`;
    }
    // WS6a Task 4 REQUIRED behaviour: data-englyn-tier and data-englyn-severity
    // both present and disagreeing is CANNOT-CHECK unconditionally — a conflict
    // between two typed declarations is not a pass and not a fail, regardless
    // of what the co-location logic above concluded.
    const conflictInfo = deriveTier(fullTag, consequence);
    if (conflictInfo.conflict) {
      pass = null;
      detail = `data-englyn-tier="${conflictInfo.tier}" conflicts with data-englyn-severity="${conflictInfo.severity}" — CANNOT-CHECK, not a pass and not a fail (a conflict between two typed declarations)`;
    }
    consequenceResults.push({ tagName, pass, detail });
  }
  if (consequenceResults.length === 0) {
    push('R5', 'vocab', 'R5 consequence co-location', null, 'no data-englyn-consequence on page — nothing to co-locate');
  } else {
    consequenceResults.forEach((r, i) => push('R5', 'vocab', `R5 consequence co-location (<${r.tagName}> #${i + 1})`, r.pass, r.detail));
  }

  // C. R10 priority order (rec A3-iii): priorities are SCOPED to a role group —
  // essay sections run 1..8 under data-englyn-role="section", page regions 1..n
  // under their own roles, components carry their own constants. So: group by
  // data-englyn-role; within each group with >= 2 priority nodes the DOM-order
  // sequence must be strictly ascending 1..n. Degenerate guard: no group with
  // >= 2 nodes → CANNOT-CHECK. (Refined 2026-08-17 after the first run false-alarmed
  // on every page by checking the whole page as one sequence.) DESIGN HYPOTHESIS:
  // "1..n per role group" is this checker's invariant, not spec text — roles are
  // free-form, so renaming a role silences it; the detail says so.
  const priorityByRole = {};
  for (const m of html.matchAll(/<\w+\b[^<>]*data-englyn-priority\s*=\s*"(-?\d+)"[^<>]*>/gi)) {
    const role = extractAttr(m[0], 'data-englyn-role') || '(no role)';
    (priorityByRole[role] ||= []).push(Number(m[1]));
  }
  const priorityGroups = Object.entries(priorityByRole).filter(([, v]) => v.length >= 2);
  if (priorityGroups.length === 0) {
    push('R10', 'vocab', 'R10 priority order', null, 'no role group with 2+ priority nodes');
  } else {
    const bad = priorityGroups.filter(([, v]) => JSON.stringify(v) !== JSON.stringify(v.map((_, i) => i + 1)));
    push('R10', 'vocab', 'R10 priority order (per role group)', bad.length === 0,
      (bad.length ? bad.map(([r, v]) => `${r}: ${v.join(',')} is not 1..n`).join('; ') : priorityGroups.map(([r, v]) => `${r}: 1..${v.length}`).join('; ')) + ' [invariant is a DESIGN HYPOTHESIS: 1..n per data-englyn-role group]');
  }

  // D. R1 double-form numbers (rec A5): an aria-label must not carry both a
  // digit run and a spelled-out number word — pick one, digits primary.
  // Degenerate guard: no numeric aria-label at all is CANNOT-CHECK.
  const ariaLabelValues = [...html.matchAll(/aria-label\s*=\s*"([^"]*)"/gi)].map((m) => m[1]);
  const digitRe = /\d[\d,.]*\d|\b\d\b/;
  // Units/suffix words (percent, million, dollars) beside digits are the FORM Rule 1
  // endorses ("12 percent", "2.4 million dollars"); the double-form defect is a spelled
  // NUMBER beside a digit ("two thousand … (2,239)").
  const wordNumberRe = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen)\b/i;
  const numericLabels = ariaLabelValues.filter((v) => digitRe.test(v));
  const doubleFormLabels = numericLabels.filter((v) => wordNumberRe.test(v));
  if (numericLabels.length === 0) {
    push('R1', 'general', 'R1 double-form numbers', null, 'no numeric aria-labels');
  } else {
    push('R1', 'general', 'R1 double-form numbers', doubleFormLabels.length === 0,
      doubleFormLabels.length
        ? `double-form number (spoken and digit) — pick one, digits primary: ${doubleFormLabels.map((v) => `"${v}"`).join(', ')}`
        : `${numericLabels.length} numeric aria-label(s) ok, digits-only`);
  }

  // E. R8 role=alert in static HTML (rec A8): role="alert" is for content that
  // appears after load (ARIA19/MDN); present at load time it FAILS. Zero
  // occurrences legitimately CONFORMS — absence IS the requirement here.
  // An EMPTY primed role=alert container is the correct pattern (Silent Failure #8:
  // the region must exist before it is written) — only an alert carrying text at
  // load is the defect.
  let alertCount = 0;
  for (const m of html.matchAll(/<(\w+)\b([^<>]*\brole\s*=\s*["']alert["'][^<>]*)>/gi)) {
    const close = findMatchingClose(html, m[1], m.index + m[0].length);
    const inner = close === -1 ? '' : html.slice(m.index + m[0].length, close);
    if (stripTags(inner).trim().length > 0) alertCount += 1;
  }
  push('R8', 'general', 'R8 no role=alert carrying text in static HTML', alertCount === 0,
    alertCount === 0 ? 'no role=alert with load-time text (empty primed containers are allowed)' : `${alertCount} role="alert" element(s) carry text at load — alert is for content that appears after load (ARIA19/MDN); use a heading or role=note`);

  return { relPath, essay, checks };
}

// Load the target's pages: [{relPath, html}] from a URL (one page), a file, or a directory.
async function loadPages() {
  if (TARGET_ARG && /^https?:\/\//.test(TARGET_ARG)) {
    const res = await fetch(TARGET_ARG, { headers: { 'user-agent': 'englyn-check' } });
    if (!res.ok) { console.error(`Fetch failed: ${res.status} ${TARGET_ARG}`); process.exit(2); }
    return [{ relPath: TARGET_ARG, html: await res.text() }];
  }
  if (!existsSync(distDir)) { console.error(`Target not found: ${distDir}`); process.exit(2); }
  if (statSync(distDir).isFile()) return [{ relPath: path.basename(distDir), html: readFileSync(distDir, 'utf8') }];
  const files = findHtmlFiles(distDir);
  if (files.length === 0) {
    console.error(`No .html files found under ${distDir}${TARGET_ARG ? '' : ' — run "npm run build" first.'}`);
    process.exit(2);
  }
  // WS6a Task 6: the zero-file guard above ran on the UNFILTERED glob list.
  // If every matched .html file is 0 bytes, that guard passed, `pages` came
  // out [], the summary printed "0 page(s) checked, 0 failing", and the run
  // exited 0 — a checker reporting a clean pass having examined nothing. Same
  // defect shape as the audio-provenance preflight below: fail loud, never
  // silently exit 0 having checked nothing.
  const nonEmpty = files.filter((f) => statSync(f).size > 0);
  if (nonEmpty.length === 0) {
    console.error(`CANNOT-CHECK: ${files.length} .html file(s) found under ${distDir}, all 0 bytes — nothing to check. This checker refuses to report a clean run having examined nothing.`);
    process.exit(2);
  }
  return nonEmpty.map((f) => ({ relPath: path.relative(distDir, f).replaceAll(path.sep, '/'), html: readFileSync(f, 'utf8') }));
}

// ---------------------------------------------------------------------------
// PREFLIGHT: audio-receipt provenance
//
// The disclosure page promises that a recording is marked stale "until it is
// either updated or confirmed to still match". AudioNarration.astro and
// englyn-md.mjs both compute that as:
//
//     isStale = sourceUpdated > recordedOn && reviewedOn < sourceUpdated
//
// That logic is correct. Its INPUT is not enforced. `sourceUpdated` is a
// hand-maintained frontmatter string, so an essay edit that forgets to bump it
// leaves a receipt asserting the text has not changed since the recording.
// The receipt then reads as current and nothing anywhere disagrees.
//
// That happened on 2026-08-14: all seven essays were edited (the attributes
// were renamed from the project's former internal name, OVERT, to ENGLYN)
// and not one sourceUpdated moved. Six of seven rendered as
// current against text that had changed. The failure was invisible because the
// only gate was a human correctly judging "did this edit change meaning?" — and
// establishing that the rename was semantically invisible took a controlled git
// diff across 138 lines. That is not a gate anyone can stand on.
//
// So this derives the truth from git instead of trusting the field.
//
// DESIGN RULE, learned the hard way: this check FAILS LOUD when it cannot do
// its job. No essays found, git unavailable, unparseable date — all are FAIL,
// never skip. A checker that exits 0 having checked nothing is the exact defect
// class it exists to catch. The CONTROL line in the output exists so a human
// can see the instrument actually ran.
// ---------------------------------------------------------------------------

const essaysDir = path.join(__dirname, '..', 'src', 'content', 'essays');
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function gitFacts(file) {
  // Returns { lastCommitDate, dirty } or throws. Never returns a soft "unknown".
  const cwd = path.dirname(file);
  const rel = path.basename(file);
  const committed = execFileSync('git', ['log', '-1', '--format=%cI', '--', rel], {
    cwd, encoding: 'utf8',
  }).trim();
  const porcelain = execFileSync('git', ['status', '--porcelain', '--', rel], {
    cwd, encoding: 'utf8',
  });
  return {
    lastCommitDate: committed ? committed.slice(0, 10) : null,
    dirty: porcelain.trim() !== '',
  };
}

function readAudioBlock(text) {
  // Deliberately no YAML dependency (dist/ has none). Reads the `audio:` map
  // out of frontmatter by indentation. Returns null when the essay has no audio.
  const fm = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!fm) return null;
  const lines = fm[1].split('\n');
  const start = lines.findIndex((l) => /^audio:\s*$/.test(l));
  if (start === -1) return null;
  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^\s/.test(lines[i]) || !lines[i].trim()) break;
    const m = /^\s+([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(lines[i]);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function checkAudioProvenance() {
  const checks = [];
  let essayFiles;
  try {
    essayFiles = globSync('*.mdx', { cwd: essaysDir }).map((p) => path.join(essaysDir, p));
  } catch (err) {
    return { fatal: `cannot read ${essaysDir}: ${err.message}`, checks, scanned: 0, withAudio: 0 };
  }
  if (essayFiles.length === 0) {
    return { fatal: `no .mdx essays found under ${essaysDir} — checker is not wired to anything`, checks, scanned: 0, withAudio: 0 };
  }

  let withAudio = 0;
  for (const file of essayFiles) {
    const rel = path.basename(file);
    const audio = readAudioBlock(readFileSync(file, 'utf8'));
    if (!audio) continue;
    withAudio++;

    const { recordedOn, sourceUpdated, reviewedOn } = audio;
    const push = (name, pass, detail) => checks.push({ file: rel, name, pass, detail });

    for (const [field, val] of Object.entries({ recordedOn, sourceUpdated, reviewedOn })) {
      if (!val || !ISO_DATE.test(val)) {
        push(`${field} is a valid ISO date`, false, `got ${JSON.stringify(val)} — receipt cannot be evaluated`);
      }
    }
    if (![recordedOn, sourceUpdated, reviewedOn].every((v) => v && ISO_DATE.test(v))) continue;

    let git;
    try {
      git = gitFacts(file);
    } catch (err) {
      push('git provenance readable', false, `git failed: ${String(err.message).split('\n')[0]}`);
      continue;
    }

    // 1. The load-bearing one: does sourceUpdated reflect the real last edit?
    if (git.dirty) {
      const mtime = new Date(statSync(file).mtime).toISOString().slice(0, 10);
      push('sourceUpdated covers uncommitted edits', sourceUpdated >= mtime,
        git.dirty && sourceUpdated < mtime
          ? `file modified ${mtime} (uncommitted) but sourceUpdated is ${sourceUpdated} — bump it, then set reviewedOn once you have confirmed the recording still matches`
          : `working copy dirty, mtime ${mtime} <= sourceUpdated ${sourceUpdated}`);
    } else if (git.lastCommitDate) {
      // AMENDED 2026-08-19 (Micah): this was a FAILS and it is UNSATISFIABLE BY
      // CONSTRUCTION. sourceUpdated is compared against the file's last COMMIT
      // date -- but committing the bumped sourceUpdated is itself a commit
      // touching the file, which sets lastCommitDate later than the value just
      // written. Bump, commit, fail. Bump again, commit, fail again.
      //
      // It passed locally (files uncommitted, git date still yesterday's) and
      // failed on Cloudflare Pages AFTER the commit, breaking the deploy and
      // freezing production. Nobody could have caught it before pushing.
      //
      // The RULE is right: a receipt must not claim the text is unchanged since a
      // date earlier than the text's last change. The MEASUREMENT is wrong,
      // because commit date answers "when was this file touched", not "did the
      // words change" -- and a frontmatter-only edit is not a text change.
      //
      // Downgraded to a note, not deleted. Staleness is real information and is
      // already reported on every run in section 3 below. And it is a state Micah
      // deliberately chose: reviewedOn is held untouched on all seven essays
      // because the recordings are known-stale pending the TTS rebuild. A check
      // that blocks a deploy for a disclosed, intentional state is enforcing a
      // rule nobody made.
      //
      // PROPER FIX, deferred and named: compare against the last commit that
      // changed the PROSE, via git log -p or a content hash of the body. Then the
      // question is "did the words change", which is what the receipt claims.
      if (sourceUpdated < git.lastCommitDate) {
        push('sourceUpdated vs last commit (NOT a failure — see comment)', true,
          `sourceUpdated ${sourceUpdated} predates the last commit touching this file (${git.lastCommitDate}). NOT A FAILURE: the comparison cannot distinguish a prose edit from a frontmatter bump, and committing the bump is itself a commit touching the file. Prose-diff fix deferred.`);
      } else {
        push('sourceUpdated covers the last commit', true, `last commit ${git.lastCommitDate} <= sourceUpdated ${sourceUpdated}`);
      }
    } else {
      push('git provenance readable', false, 'file has no commit history and is not dirty — cannot establish when it last changed');
    }

    // 2. Internal coherence. A review predating the recording is nonsense.
    push('reviewedOn is not before recordedOn', reviewedOn >= recordedOn,
      reviewedOn < recordedOn ? `reviewedOn ${reviewedOn} predates recordedOn ${recordedOn}` : 'ok');

    // 3. Report the honest stale state. NOT a failure — a stale recording that
    //    says it is stale is the system working. Silence is the failure.
    const isStale = sourceUpdated > recordedOn && reviewedOn < sourceUpdated;
    if (isStale) {
      push('receipt state', true,
        `STALE and correctly flagged (source ${sourceUpdated} > recorded ${recordedOn}, reviewed ${reviewedOn}). Re-record, or set reviewedOn >= ${sourceUpdated} once confirmed to still match.`);
    }
  }

  if (withAudio === 0) {
    return { fatal: `scanned ${essayFiles.length} essay(s), none carried an audio block — either the frontmatter shape changed or the parser is broken`, checks, scanned: essayFiles.length, withAudio };
  }
  return { fatal: null, checks, scanned: essayFiles.length, withAudio };
}


// --- Unannounced-name guard. REMOVED at gate 3 (2026-08-19, dispatch
// DISPATCH-JUDE-ENGLYN-LAUNCH-BUILD-001).
//
// It existed from 2026-08-16 to guard the publication sequence Micah ruled
// that day: (1) site updates ship first, attributes invisible to readers;
// (2) the GitHub spec repo push IS the announcement, held; (3) the
// announcement essay and social follow the repo. Between gates 1 and 3 it
// scanned every built page for narrative "Englyn" outside the permitted
// plumbing (data-englyn-*, englyn-check/-md/-accessible/-essay identifiers)
// and failed the build on any hit — the only thing standing between an
// in-progress site edit and a premature name leak.
//
// It fired twice in anger before this removal: twice catching a maintainer
// mid-edit, both before gate 3 (per the dispatch that ordered this removal
// — neither instance's detail lives in this file).
// It fired a third and final time on the-ramp.mdx's own build, 2026-08-19:
// 4 narrative hits (the essay's prose, its hero image path, its card on
// /essays/, and llms-full.txt) — proof it was still live and correct right
// up to the moment gate 3 fired for real. That run is the essay this
// repository now ships.
//
// The guard's own selftest fixtures (7 cases: 5 identifier forms that must
// fire, 2 plumbing forms that must not) are removed from
// scripts/englyn-check.selftest.mjs in the same commit — a control with no
// call site is dead weight, and leaving its fixtures behind would make the
// suite lie about what it still tests.


async function main() {
  const report = { tool: 'englyn-check', target: TARGET_ARG || distDir, mode: WW ? 'ww' : 'general', ranAt: new Date().toISOString(), pages: [], preflight: {}, cannotCheck: CANNOT_CHECK };
  let audioFails = [];

  if (WW) {
    // --- preflight: audio-receipt provenance (source-level, runs before dist checks)
    const audit = checkAudioProvenance();
    out('\nAudio-receipt provenance — source vs git\n');
    out(`CONTROL: ${audit.scanned} essay file(s) scanned, ${audit.withAudio} carrying an audio receipt, ${audit.checks.length} check(s) evaluated.`);
    if (audit.fatal) {
      console.error(`\n  FATAL  ${audit.fatal}`);
      console.error('  This checker refuses to report a pass it did not earn. Fix the wiring, then re-run.\n');
      process.exit(1);
    }
    audioFails = audit.checks.filter((c) => !c.pass);
    for (const c of audit.checks.filter((c) => c.pass && c.name === 'receipt state')) out(`  NOTE  ${c.file}: ${c.detail}`);
    if (audioFails.length) { out(''); for (const c of audioFails) out(`  FAILS  ${c.file} — ${c.name}: ${c.detail}`); }
    else out('  All audio receipts reconcile with git.');
    report.preflight.audio = { scanned: audit.scanned, withAudio: audit.withAudio, fails: audioFails };
  }

  const pages = await loadPages();
  const results = pages.map((p) => checkHtml(p.html, p.relPath)).sort((a, b) => a.relPath.localeCompare(b.relPath));
  report.pages = results;

  // Summary table
  const count = (r, v) => r.checks.filter((c) => c.verdict === v).length;
  out(`\nEnglyn static conformance — per page (mode: ${WW ? 'W+W site' : 'general'}, target: ${TARGET_ARG || distDir})\n`);
  const pathWidth = Math.max(4, ...results.map((r) => r.relPath.length));
  out(`${'PAGE'.padEnd(pathWidth)}  VERDICT       CONFORMS/FAILS/CANNOT-CHECK`);
  for (const r of results) {
    const f = count(r, 'FAILS'); const x = count(r, 'CANNOT-CHECK'); const c = count(r, 'CONFORMS');
    const verdict = f ? 'FAILS' : x ? 'CONFORMS*' : 'CONFORMS'; // * = with CANNOT-CHECK items on the page
    out(`${r.relPath.padEnd(pathWidth)}  ${verdict.padEnd(12)}  ${c}/${f}/${x}${r.essay ? ' [essay]' : ''}`);
  }

  // Failure + cannot-check details (per requirement)
  const failing = results.filter((r) => r.checks.some((c) => c.verdict === 'FAILS'));
  const flagged = results.filter((r) => r.checks.some((c) => c.verdict === 'CANNOT-CHECK'));
  if (failing.length) {
    out('\nFAILS — by page and requirement\n');
    for (const r of failing) { out(`-- ${r.relPath} --`); for (const c of r.checks.filter((c) => c.verdict === 'FAILS')) out(`  FAILS  [${c.req}] ${c.name}: ${c.detail}`); }
  }
  if (flagged.length) {
    out('\nCANNOT-CHECK — page-level items this instrument could observe but not judge\n');
    for (const r of flagged) { out(`-- ${r.relPath} --`); for (const c of r.checks.filter((c) => c.verdict === 'CANNOT-CHECK')) out(`  CANNOT-CHECK  [${c.req}] ${c.name}: ${c.detail}`); }
  }

  out('\nCANNOT-CHECK — requirements outside this instrument, every run, with the reason\n');
  for (const c of CANNOT_CHECK) out(`  CANNOT-CHECK  [${c.req}] ${c.name} — ${c.why}`);
  if (!WW) out('\n  W+W-specific checks (essay grammar, audio receipts) NOT run: pass --ww to include them.');

  const totalFails = results.reduce((n, r) => n + count(r, 'FAILS'), 0);
  const totalX = results.reduce((n, r) => n + count(r, 'CANNOT-CHECK'), 0) + CANNOT_CHECK.length;
  out(`\n${results.length} page(s) checked, ${failing.length} failing, ${totalFails} FAILS, ${totalX} CANNOT-CHECK (never counted as a pass).`);
  if (WW) {
    out(`${report.preflight.audio.withAudio} audio receipt(s) reconciled against git, ${audioFails.length} failing.\n`);
  }
  report.summary = { pages: results.length, failingPages: failing.length, fails: totalFails, cannotCheck: totalX };
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2));

  // A provenance failure blocks the build exactly as a page failure does. The
  // receipt is a published claim; shipping one that git contradicts is the
  // failure this preflight exists to prevent. CANNOT-CHECK never sets the exit code.
  process.exit(failing.length > 0 || audioFails.length > 0 ? 1 : 0);
}

main();
