/**
 * L2 — Schema validation. The Englyn vocabulary as runtime contracts.
 *
 * Created 2026-08-18, MANIFEST-JUDE-ENGLYN-V0_1_0-BUILD-001 WS7. Until this
 * file, L2 had never run on the reference implementation: `src/content.config.ts`
 * carries a real Zod schema for essay frontmatter, but frontmatter holds no
 * Englyn values, so nothing validated the `data-englyn-*` contract before
 * render. `../englyn/spec/TIERS.md` makes L2 a Bronze requirement, so the
 * tier could not be earned while the layer did not exist.
 *
 * MEMBERSHIP, NOT SHAPE. Every enum below is closed and copied from
 * `../englyn/spec/VOCABULARY.md`, which is normative. `z.string().min(1)`
 * would accept any non-empty string -- a shape constraint. VOCABULARY.md's
 * membership criterion requires a conforming checker to validate that a value
 * is INSIDE its published enum, which is what these are for.
 *
 * WHY THIS EXISTS SEPARATELY FROM `scripts/englyn-check.mjs` (L1):
 * L1 reads rendered output in `dist/`. It can only see values a page
 * actually emitted. A value on a branch no current content takes -- say a
 * ternary that emits one string for synthetic audio and another for
 * human-recorded, on a site where every essay is human-recorded -- is
 * invisible to L1 forever, and ships the day the first synthetic reading
 * lands. L2 reads the SOURCE contract, branches included. The two layers
 * are not redundant; each is structurally blind to what the other sees.
 */

import { z } from 'zod';

/**
 * data-englyn-role. THIRTEEN values, closed. VOCABULARY.md § Document structure.
 *
 * RESYNCED 2026-08-18 to Micah's amended ruling (commit 3a6ca302f), which
 * landed between this build's WS6a and WS7 commits. This module was written
 * against the superseded ten-value enum and shipped diverged for one commit
 * -- two instruments, two enums, one question, which is the identical defect
 * WS6a had just fixed between englyn-check.mjs and englyn_baseline_scan.py.
 * Copying an enum is cheap; a copy that silently goes stale is not.
 *
 * The amendment removed three values nothing emits (`alert`, `stat`, `chart`
 * -- now Reserved) and admitted seven the site actually ships. `receipt`,
 * `log`, `profile` and `error` were ruled MISUSE, deliberately NOT admitted:
 * they must keep failing, because they are markup defects rather than
 * vocabulary the spec absorbs.
 */
export const EnglynRole = z.enum([
  'narration', 'section', 'action', 'status', 'citations', 'run-out',
  'media', 'collection', 'disclosure', 'hero', 'banner', 'bio', 'card',
]);

/** data-englyn-primitive. EXACTLY SIX, closed. VOCABULARY.md § Operation semantics. */
export const EnglynPrimitive = z.enum([
  'perceive', 'act', 'announce', 'audit', 'interrupt', 'oversee',
]);

/** data-englyn-consumer. VOCABULARY.md § Routing -- the two-reader thesis. */
export const EnglynConsumer = z.enum(['assistive-technology', 'agent', 'both']);

/**
 * data-englyn-source. VOCABULARY.md § Annotation provenance.
 *
 * RESYNCED 2026-08-18: `generated` was ruled IN (commit 3a6ca302f). This
 * layer's first run reported it as an out-of-enum value on an untaken branch
 * and recommended a sixth value be ruled; the ruling arrived the same day and
 * chose `generated`. The finding stands and is now closed -- the component's
 * synthetic-audio arm emits a value that is in the enum.
 */
export const EnglynSource = z.enum([
  'manual', 'generated', 'llm-draft', 'research-pipeline', 'analytics',
  'build-script',
]);

/**
 * data-englyn-priority. Positive integers, 1..n with no gaps. The no-gaps
 * rule is a property of a GROUP of siblings, not of one value, so it is
 * enforced by L1's R10 across a rendered role group -- not here, where only
 * one value is in hand. Stated so the omission reads as scoped, not missed.
 */
export const EnglynPriority = z.coerce.number().int().positive();

/**
 * Free text BY DECLARATION (VOCABULARY.md). Not unconstrained: declared free
 * text still has to be non-empty, because an empty consequence is a claim
 * that an action has none.
 */
const FreeText = z.string().min(1);

/** Every attribute VOCABULARY.md specifies, keyed by its bare name. */
export const ENGLYN_SPECIFIED = {
  role: EnglynRole,
  primitive: EnglynPrimitive,
  priority: EnglynPriority,
  consumer: EnglynConsumer,
  source: EnglynSource,
  consequence: FreeText,
  receipt: FreeText,
};

/**
 * RESERVED: named in VOCABULARY.md, value space NOT specified. A checker MUST
 * NOT fail a page for carrying one and MUST NOT pass it either -- the verdict
 * is CANNOT-CHECK. Listed here so an unknown-attribute error can tell the
 * difference between "reserved, unruled" and "not a thing".
 */
export const ENGLYN_RESERVED = new Set(['state', 'severity', 'confidence', 'value']);

/** PROPOSED in spec/CRITERIA-DRAFT-2026-08-18.md, not ruled. Also CANNOT-CHECK. */
export const ENGLYN_PROPOSED = new Set(['tier', 'layer']);

/** A region's Englyn annotation. `.strict()`: an unknown key is a defect, not extra. */
export const EnglynRegionSchema = z.object({
  role: EnglynRole.optional(),
  primitive: EnglynPrimitive.optional(),
  priority: EnglynPriority.optional(),
  consumer: EnglynConsumer.optional(),
  source: EnglynSource.optional(),
  consequence: FreeText.optional(),
  receipt: FreeText.optional(),
}).strict();

/**
 * Three verdicts, never two. Returns one of:
 *   { verdict: 'CONFORMS' }
 *   { verdict: 'FAILS', reason }
 *   { verdict: 'CANNOT-CHECK', reason }   -- reserved/proposed attribute
 *
 * Deliberately does NOT throw. A caller that wants to fail the build calls
 * `englynValue()` below; a caller that wants to REPORT (the L2 runner) needs
 * all three verdicts, and an exception can only carry two.
 */
export function checkEnglynValue(attr, value) {
  if (ENGLYN_RESERVED.has(attr)) {
    return { verdict: 'CANNOT-CHECK', reason: `data-englyn-${attr} is RESERVED in spec/VOCABULARY.md -- named, value space not specified` };
  }
  if (ENGLYN_PROPOSED.has(attr)) {
    return { verdict: 'CANNOT-CHECK', reason: `data-englyn-${attr} is PROPOSED (spec/CRITERIA-DRAFT-2026-08-18.md), not ruled` };
  }
  const schema = ENGLYN_SPECIFIED[attr];
  if (!schema) {
    return { verdict: 'FAILS', reason: `data-englyn-${attr} is not an attribute named anywhere in spec/VOCABULARY.md` };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { verdict: 'CONFORMS' };
  const options = schema instanceof z.ZodEnum ? ` -- enum is {${schema.options.join(', ')}}` : '';
  return { verdict: 'FAILS', reason: `data-englyn-${attr}="${value}" is outside its declared value space${options}` };
}

/**
 * The fail-loud form, for a render boundary. Returns the value if it is inside
 * its enum, throws otherwise -- so a malformed value stops the build instead
 * of degrading silently into markup nobody reads until a screen reader hits it.
 *
 * Use this where the value is COMPUTED (a prop, a ternary, an interpolation).
 * Literal attributes in templates are already covered by L1 against rendered
 * output; wrapping them here would only move the same check earlier.
 */
export function englynValue(attr, value) {
  const result = checkEnglynValue(attr, value);
  if (result.verdict === 'FAILS') {
    throw new Error(`L2 schema: ${result.reason}`);
  }
  return value;
}
