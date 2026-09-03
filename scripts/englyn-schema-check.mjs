#!/usr/bin/env node
/**
 * L2 — Schema validation, run against the SOURCE contract.
 *
 * MANIFEST-JUDE-ENGLYN-V0_1_0-BUILD-001 WS7. L2 had never run on this site.
 * `../englyn/spec/TIERS.md` makes L2 a Bronze -- structurally sound
 * requirement, so the tier was not merely unclaimed, it was unearnable.
 *
 * WHAT THIS SEES THAT L1 CANNOT.
 * `englyn-check.mjs` (L1) reads `dist/`. It validates every data-englyn-*
 * value a page actually emitted, which is the right scope for a static
 * output lint and is structurally blind to a branch no content takes. This
 * checker reads `src/**` and validates every value the templates CAN emit,
 * including the untaken branch. That distinction is not theoretical: the
 * first thing it found was `data-englyn-source={nature === 'synthetic' ?
 * 'generated' : 'manual'}` in AudioNarration.astro -- `generated` is not in
 * VOCABULARY.md's source enum, no essay is synthetic today, so no page emits
 * it and L1 will keep reporting clean right up until the first synthetic
 * reading ships.
 *
 * THREE VERDICTS, NEVER TWO. CONFORMS / FAILS / CANNOT-CHECK. A reserved or
 * proposed attribute is CANNOT-CHECK -- it is not a pass and not a fail, and
 * reporting it as either would manufacture a verdict.
 *
 * THE DENOMINATOR RULE. Every count below prints what it examined and what it
 * expected to examine. Zero expected is CANNOT-CHECK, never CONFORMS: a
 * checker that examined nothing has not found nothing.
 *
 * Run:   node scripts/englyn-schema-check.mjs        (npm run englyn:schema)
 * Test:  node scripts/englyn-schema-check.mjs --selftest
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkEnglynValue, ENGLYN_RESERVED, ENGLYN_PROPOSED } from '../src/lib/englyn-schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, '..', 'src');
const SOURCE_EXT = /\.(astro|mdx|ts|tsx|js|mjs)$/;

/**
 * Every `data-englyn-<attr>=` occurrence, with each STRING LITERAL that can
 * reach it. A literal attribute yields one value; a ternary yields both arms;
 * a template literal or a bare identifier yields none, and is reported as
 * CANNOT-CHECK rather than skipped -- an unreadable expression is not a
 * passing one.
 */
/**
 * Blank out comment bodies, preserving offsets. An attribute inside a comment
 * is not emitted, and reading one as live is how a checker invents a defect:
 * the first run flagged `data-englyn-primitive="operate"` in
 * `content/essays/nothing-found.mdx`, which is a line inside an MDX comment
 * DOCUMENTING that the value was already corrected to `act`. A checker that
 * cannot tell a fix from a defect is not measuring the source.
 *
 * Block forms only ({/* *\/}, /* *\/, <!-- -->). Line comments are left alone
 * deliberately: `//` appears inside every URL in the tree, and a rule that
 * has to guess whether a slash-slash is a comment would introduce a second,
 * quieter version of the same error.
 */
function stripComments(text) {
  return text.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/g,
    (m) => m.replace(/[^\n]/g, ' '));
}

/**
 * Files that READ the vocabulary rather than emit it. Their regex literals and
 * documentation strings contain data-englyn-* text that is machinery, not
 * markup -- `data-englyn-role="[^"` is a character class, not a role. A
 * checker that greps tracked files and does not exclude the instruments finds
 * its own reflection. Named individually, never by directory prefix, and
 * PRINTED in the run output: a silent exclusion reads as coverage it does not
 * have.
 */
const INSTRUMENT_FILES = new Set([
  'lib/englyn-md.mjs',      // builds the markdown channel BY matching these attributes
  'lib/englyn-schema.mjs',  // this layer's own schema module
]);

function extractAnnotations(rawText, file) {
  const text = stripComments(rawText);
  const found = [];
  const attrRe = /data-englyn-([a-z-]+)\s*=\s*/g;
  let m;
  while ((m = attrRe.exec(text)) !== null) {
    const attr = m[1];
    const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 400);
    if (rest[0] === '"' || rest[0] === "'") {
      const q = rest[0];
      const end = rest.indexOf(q, 1);
      if (end === -1) { found.push({ file, attr, value: null, expr: rest.slice(0, 40) }); continue; }
      found.push({ file, attr, value: rest.slice(1, end), expr: null });
      continue;
    }
    if (rest[0] === '{') {
      // JSX/Astro expression. Pull the balanced expression, then every string
      // literal inside it -- a ternary's arms are exactly what L1 cannot see.
      let depth = 0, end = -1;
      for (let i = 0; i < rest.length; i += 1) {
        if (rest[i] === '{') depth += 1;
        else if (rest[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      const expr = end === -1 ? rest : rest.slice(1, end);
      // A ternary's CONDITION is not an emission. `{nature === 'synthetic' ?
      // 'generated' : 'manual'}` emits `generated` or `manual`; `synthetic` is
      // the thing being compared against and never reaches the attribute.
      // Taking every literal in the expression reported it as a bad source
      // value, which is a checker inventing a defect out of its own
      // imprecision. Where a `?` is present, read only the result positions.
      const results = expr.includes('?') ? expr.slice(expr.indexOf('?') + 1) : expr;
      const literals = [...results.matchAll(/(['"])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((x) => x[2]);
      if (literals.length === 0) { found.push({ file, attr, value: null, expr: expr.trim().slice(0, 60) }); continue; }
      for (const value of literals) found.push({ file, attr, value, expr: expr.trim().slice(0, 60) });
      continue;
    }
    found.push({ file, attr, value: null, expr: rest.slice(0, 40) });
  }
  return found;
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) { walk(fp, out); continue; }
    if (SOURCE_EXT.test(e.name)) out.push(fp);
  }
  return out;
}

function run(root) {
  const all = walk(root).map((f) => ({ abs: f, rel: path.relative(root, f).replaceAll(path.sep, '/') }));
  const excluded = all.filter((f) => INSTRUMENT_FILES.has(f.rel));
  const files = all.filter((f) => !INSTRUMENT_FILES.has(f.rel));
  const annotations = files.flatMap((f) => extractAnnotations(readFileSync(f.abs, 'utf8'), f.rel));
  const results = annotations.map((a) => {
    if (a.value === null) {
      return { ...a, verdict: 'CANNOT-CHECK', reason: `value is a non-literal expression (${a.expr}) -- this instrument reads source text, not runtime values; L1 checks what it renders to` };
    }
    return { ...a, ...checkEnglynValue(a.attr, a.value) };
  });
  return { files, excluded, all, annotations, results };
}

function report(root, label) {
  const { files, excluded, all, annotations, results } = run(root);
  const fails = results.filter((r) => r.verdict === 'FAILS');
  const cc = results.filter((r) => r.verdict === 'CANNOT-CHECK');
  const conforms = results.filter((r) => r.verdict === 'CONFORMS');

  console.log(`\nL2 — schema validation (source contract) — ${label}\n`);
  console.log(`CONTROL: ${files.length} of ${all.length} source file(s) scanned, `
    + `${annotations.length} data-englyn-* annotation(s) examined. `
    + `Comment bodies blanked before extraction.`);
  console.log(`EXCLUDED (${excluded.length}, named individually, never by prefix): `
    + (excluded.length ? excluded.map((f) => f.rel).join(', ') + ' — instruments that MATCH these attributes rather than emit them' : 'none'));

  // The denominator rule, applied to this checker's own reach.
  if (files.length === 0 || annotations.length === 0) {
    console.error(`\n  CANNOT-CHECK  scanned ${files.length} file(s) and found ${annotations.length} annotation(s) — `
      + 'a schema checker that examined nothing has not found nothing. Check the wiring, then re-run.');
    return 2;
  }

  const byAttr = {};
  for (const r of results) (byAttr[r.attr] ||= []).push(r);
  console.log('\nPer attribute (examined / CONFORMS / FAILS / CANNOT-CHECK):');
  for (const attr of Object.keys(byAttr).sort()) {
    const g = byAttr[attr];
    const note = ENGLYN_RESERVED.has(attr) ? '  [RESERVED]' : ENGLYN_PROPOSED.has(attr) ? '  [PROPOSED]' : '';
    console.log(`  data-englyn-${attr.padEnd(14)} ${String(g.length).padStart(3)} / `
      + `${String(g.filter((r) => r.verdict === 'CONFORMS').length).padStart(3)} / `
      + `${String(g.filter((r) => r.verdict === 'FAILS').length).padStart(3)} / `
      + `${String(g.filter((r) => r.verdict === 'CANNOT-CHECK').length).padStart(3)}${note}`);
  }

  if (fails.length) {
    console.log('\nFAILS:');
    const seen = new Set();
    for (const f of fails) {
      const key = `${f.file}|${f.attr}|${f.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  FAILS  ${f.file}: ${f.reason}`);
    }
  }
  if (cc.length) {
    console.log('\nCANNOT-CHECK (never counted as a pass):');
    const seen = new Set();
    for (const c of cc) {
      const key = `${c.attr}|${c.reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.log(`  CANNOT-CHECK  ${c.file}: ${c.reason}`);
    }
  }

  const verdict = fails.length ? 'FAILS' : (cc.length ? 'CANNOT-CHECK' : 'CONFORMS');
  console.log(`\nL2 VERDICT: ${verdict} — ${conforms.length} CONFORMS, ${fails.length} FAILS, `
    + `${cc.length} CANNOT-CHECK across ${annotations.length} annotation(s) in ${files.length} source file(s).`);
  if (verdict === 'CANNOT-CHECK') {
    console.log('A CANNOT-CHECK on a required layer means the tier is not awarded (spec/TIERS.md).');
  }
  return fails.length ? 1 : 0;
}

// --- Controls. Both directions, or this checker is not evidence. -----------
function selftest() {
  let failures = 0;
  const say = (name, ok, detail) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ` — ${detail}`}`);
    if (!ok) failures += 1;
  };

  const cases = [
    // MUST NOT FIRE — every value inside its published enum.
    ['clean literal role', '<div data-englyn-role="narration">', 'CONFORMS'],
    ['clean literal primitive', '<div data-englyn-primitive="oversee">', 'CONFORMS'],
    ['clean literal consumer', '<div data-englyn-consumer="both">', 'CONFORMS'],
    ['numeric priority', '<div data-englyn-priority="3">', 'CONFORMS'],
    ['free-text consequence', '<a data-englyn-consequence="Navigates. Nothing is saved.">', 'CONFORMS'],

    // MUST FIRE — the defect classes this layer exists for.
    ['invented role', '<div data-englyn-role="step">', 'FAILS'],
    ['invented primitive (the "orientation" class)', '<div data-englyn-primitive="orientation">', 'FAILS'],
    ['invented primitive (the "operate" class)', '<div data-englyn-primitive="operate">', 'FAILS'],
    ['unnamed attribute', '<div data-englyn-mood="wistful">', 'FAILS'],
    ['priority zero is not a positive integer', '<div data-englyn-priority="0">', 'FAILS'],
    ['empty consequence is a claim of none', '<a data-englyn-consequence="">', 'FAILS'],

    // THE WHOLE POINT — the untaken branch. L1 cannot see this; L2 must.
    // This control used `generated` until 2026-08-18, when that value was
    // RULED INTO the source enum (commit 3a6ca302f) -- so the control stopped
    // testing membership and started asserting a pass. It failed loudly on the
    // next run rather than going quietly green, which is the only reason it
    // was caught. A control pinned to a value the spec can later admit has a
    // shelf life; pin it to one the spec has rejected instead.
    // `synthesised` was RECOMMENDED for this slot and NOT chosen -- so it is a
    // value the vocabulary has actually considered and declined.
    ['untaken ternary arm outside the enum',
      `<section data-englyn-source={nature === 'synthetic' ? 'synthesised' : 'manual'}>`, 'FAILS'],

    // CANNOT-CHECK — never a pass, never a fail.
    ['reserved attribute', '<p data-englyn-state="at-risk">', 'CANNOT-CHECK'],
    ['proposed attribute', '<p data-englyn-tier="T1">', 'CANNOT-CHECK'],
    ['opaque expression', '<div data-englyn-role={someRuntimeValue}>', 'CANNOT-CHECK'],
  ];

  console.log('\nL2 controls — both directions\n');
  for (const [name, snippet, expected] of cases) {
    const got = extractAnnotations(snippet, 'control').map((a) => (
      a.value === null ? 'CANNOT-CHECK' : checkEnglynValue(a.attr, a.value).verdict
    ));
    // A case passes if the expected verdict is among the verdicts produced —
    // a ternary yields one verdict per arm, and 'manual' correctly CONFORMS.
    say(`${name} → ${expected}`, got.includes(expected), `got ${got.join(', ') || 'nothing extracted'}`);
  }

  // A control on the extractor itself: a ternary MUST yield both arms, or the
  // untaken-branch case above passes for the wrong reason.
  const arms = extractAnnotations(`<x data-englyn-source={a ? 'generated' : 'manual'}>`, 'control').map((a) => a.value);
  say('ternary extraction yields BOTH arms', arms.length === 2 && arms.includes('generated') && arms.includes('manual'),
    `got [${arms.join(', ')}]`);
  // ...and NOT the comparand. The condition is not an emission.
  const cond = extractAnnotations(
    `<x data-englyn-source={nature === 'synthetic' ? 'generated' : 'manual'}>`, 'control').map((a) => a.value);
  say('ternary CONDITION is not read as an emitted value',
    cond.length === 2 && !cond.includes('synthetic'), `got [${cond.join(', ')}]`);

  // Comment stripping, both directions. A widening that is not pinned on the
  // must-FIRE side is how a checker goes quietly blind.
  const commented = extractAnnotations(`{/* was data-englyn-role="step", now fixed */}`, 'control');
  say('MUST NOT FIRE: an attribute inside a comment is not an emission', commented.length === 0,
    `extracted ${commented.length}`);
  const beside = extractAnnotations(
    `{/* note: data-englyn-role="step" was wrong */}\n<div data-englyn-role="step">`, 'control');
  say('MUST FIRE: a live bad value beside a comment still fails',
    beside.length === 1 && checkEnglynValue(beside[0].attr, beside[0].value).verdict === 'FAILS',
    `extracted ${beside.length}`);
  const htmlComment = extractAnnotations(`<!-- data-englyn-role="step" -->`, 'control');
  say('MUST NOT FIRE: HTML comment form', htmlComment.length === 0, `extracted ${htmlComment.length}`);

  // The exclusion list is a bounded, named cap -- assert it stays bounded, so
  // nobody quiets a failure by adding a page to it.
  say('instrument exclusions are named files under lib/, not a directory prefix',
    [...INSTRUMENT_FILES].every((f) => f.startsWith('lib/') && !f.endsWith('/')),
    `list is [${[...INSTRUMENT_FILES].join(', ')}]`);

  console.log(`\n${failures === 0 ? 'ALL CONTROLS PASS' : `${failures} CONTROL(S) FAILED`}`);
  return failures === 0 ? 0 : 1;
}

const target = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : SRC;
if (process.argv.includes('--selftest')) {
  process.exit(selftest());
} else {
  if (!statSync(target).isDirectory()) { console.error(`Not a directory: ${target}`); process.exit(2); }
  process.exit(report(target, path.relative(path.join(__dirname, '..'), target) || target));
}
