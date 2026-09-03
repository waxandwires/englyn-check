# englyn-check

A static conformance checker for [Englyn](https://github.com/waxandwires/englyn), an
accessibility specification for pages and interfaces that must be legible to both people
and AI agents. This repository is the checker. The specification text lives in the
`englyn` repo above, under a separate license — see **License** below.

Three verdicts, always: **CONFORMS**, **FAILS**, **CANNOT-CHECK**. CANNOT-CHECK is never
counted as a pass. A requirement this checker cannot evaluate is reported as unknown, not
silently skipped and not silently passed.

## What's here

| File | Job |
|---|---|
| `scripts/englyn-check.mjs` | The checker. Static/regex analysis over rendered HTML — no DOM library, no dependencies beyond Node's own `fs`/`node:child_process`. Runs against a built `dist/`-style directory, a single `.html` file, or an `http(s)` URL. |
| `scripts/englyn-check.selftest.mjs` | Known-answer controls for the checker itself: fixtures built to CONFORM, FAIL, and CANNOT-CHECK on purpose, run against the live checker. If a control doesn't fire as expected, the checker is not trustworthy that run. |
| `scripts/englyn-schema-check.mjs` | A separate, stricter pass: validates that every `data-englyn-*` attribute value is a member of its published value space in `spec/VOCABULARY.md`, not just present. |
| `src/lib/englyn-schema.mjs` | Shared value-space tables (`ENGLYN_RESERVED`, `ENGLYN_PROPOSED`, `checkEnglynValue`) that `englyn-schema-check.mjs` imports. Required — the schema checker will not run without it at this relative path. |
| `LICENSE`, `NOTICE` | Apache-2.0. The specification text in the `englyn` repo is CC BY 4.0 — deliberately a different license, so nobody has to work out which one governs which file inside a single tree. |

## Running it against a site you own

```bash
node scripts/englyn-check.mjs path/to/your/dist
```

- No argument runs in Wax+Wires' own site-build mode (`../dist`, W+W-specific checks on).
  Pass a target and that mode is off by default.
- `--ww` additionally runs the Wax+Wires-specific checks (essay grammar, audio-receipt
  currency against git). These assume an Astro content-collections layout
  (`src/content/essays/*.mdx` with `audio:`/`youtube:` frontmatter) and were built for one
  specific site. On a foreign site, leave `--ww` off.
- `--json` prints a machine-readable report instead of the human-readable one.
- Exit code is `1` iff any requirement returns FAILS. CANNOT-CHECK never changes the exit
  code, by design — see the three-verdict rule above.
- Requires Node ≥ 22 (uses `fs.globSync` and the global `fetch`).

**Portability, measured:** run once against a page outside Wax+Wires
(gov.uk), it returned 6 FAILS and 15 CANNOT-CHECK — the mechanism runs on a page it was
never tuned against. It has not been run against a broad sample of sites, so treat that as
one data point, not a portability guarantee.

### Known limitation, disclosed rather than hidden

`englyn-check.mjs` currently infers a link's action-safety tier (`T1`, read-only) from its
`data-englyn-consequence` prose, with a regex:

```js
const navigational = /^(navigates to|opens)\b/i.test(proseConsequence.trim())
                     && /read-only|nothing is (saved|sent)/i.test(proseConsequence);
```

**This is a prose regex deciding a typed property, and the specification's own vocabulary
says that's the wrong shape.** `spec/VOCABULARY.md` (in the `englyn` repo) currently marks
every candidate typed carrier for this decision as one of three things: `data-englyn-tier`
is Proposed and not yet published; `data-englyn-severity` is Reserved with zero measured
uses; and `data-englyn-primitive="interrupt"`, the one carrier that's published and
closed, has itself been emitted zero times in the reference implementation. There is no
typed path available yet. Until one is ruled and published, this checker returns
CANNOT-CHECK on every tier it infers this way rather than reporting a false CONFORMS — but
the inference itself, not just its uncertainty, is worth knowing about if you're deciding
whether to trust it on your own content. A correctly-worded but misclassified sentence is
exactly the failure mode a prose regex can't rule out.

## What this checker does not do

- No browser, no real DOM, no axe-core. It cannot check focus order, keyboard reachability,
  computed contrast, or anything requiring interaction (L3/L4 in Englyn's layer model).
- No screen reader. Nothing here substitutes for a person who uses one.
- The `--ww` audio-receipt reconciliation is specific to one site's Astro content
  collections; it is included for provenance, not as a general-purpose feature.

## License

Apache-2.0 (see `LICENSE`, `NOTICE`). The Englyn specification text is licensed separately,
under CC BY 4.0, in [`waxandwires/englyn`](https://github.com/waxandwires/englyn) — a patent
grant is what a stranger's legal review needs before running someone else's code in their
own CI, and a content license doesn't supply one.

## Provenance

Extracted from the conformance checker built for and run against
[waxandwires.com](https://waxandwires.com), the Englyn specification's own reference
implementation. Comments in the source describing internal build history have been
generalized for a public audience; the checking logic itself is unmodified.
