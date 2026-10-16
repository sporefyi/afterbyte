# @afterbyte/research

Source ingestion, the bounded research pipeline, and editorial policy for the
AFTERBYTE backend (brief §§5–7). Business rules live here — API handlers and
workers call these functions (ADR-0001).

## Layout

```
src/
  providers/types.ts    Provider interface: discover/fetch/normalize/health +
                        capability flags (credentials, per-domain concurrency,
                        rate limits, timeouts, max body size, retention,
                        attribution)
  providers/ssrf.ts     SSRF-safe HTTP client: private/loopback/link-local/
                        metadata/internal IPv4+IPv6 blocking, DNS validated at
                        connection time and on every redirect, http/https on
                        80/443 only, redirect/byte/time caps, conditional
                        requests, content hashing
  providers/website.ts  Official-site/general web adapter (static HTML only —
                        pages are hostile input, never executed)
  providers/rss.ts      RSS 2.0 / Atom 1.0 adapter (explicitly configured feeds)
  providers/github.ts   Public repo + release data via api.github.com, no auth,
                        rate-limit aware (60 req/h unauthenticated)
  pipeline.ts           Research run state machine
                        (queued → running → awaiting_provider → awaiting_review
                        → completed | failed | cancelled), 12 workflow steps,
                        budget reservation BEFORE dispatch, caps
                        (15 sources / 8 model calls / 10 min, configurable),
                        per-run + daily cost tracking, circuit breaker,
                        revisit scheduling (active daily / ordinary weekly /
                        stable-discontinued monthly, jittered batches)
  model.ts              Model-provider adapter. MODEL_PROVIDER_KEY from env;
                        absent key → client is null → runs stay
                        awaiting_provider (public reads unaffected). Records
                        model id + prompt-template version + output-schema
                        version + usage; validates output against a static
                        schema; max 2 repair attempts then flags review; saves
                        decision summaries + observable steps only — never
                        chain-of-thought. Monetary ceilings enforced; ambiguous
                        provider timeouts are NEVER retried blindly.
  lifecycle.ts          Lifecycle evaluation under the versioned policy.
                        A single HTTP failure / quiet repo / absent post NEVER
                        sets discontinued; missing data is not negative
                        evidence; uncertain is the default.
  security.ts           Hostile-source-input rules: source text is fenced as
                        quoted DATA, lives only in the user role, can never
                        reach system instructions or authorize wallet actions.
  dedup.ts              Provenance/syndication dedup (same bytes on N domains =
                        one independent source) + duplicate-subject detection.
prompts/v1/             Versioned prompt templates + JSON output schemas:
                        plan, extract-facts, detect-changes, propose-status,
                        draft-sections, citation-check. model_calls records
                        reference templateId + templateVersion + schemaVersion.
policy/                 lifecycle-policy.v1.json — category-specific criteria
                        for active/dormant/discontinued/revived/uncertain per
                        subject kind (app, website, game, meme, community,
                        crypto_project, other), with evidence windows.
tests/                  Unit + live adapter tests (live tests skip gracefully
                        without network).
```

## Budgets

`DEFAULT_CAPS`: 15 candidate sources, 8 model calls, 10 minutes, $0.50
(500,000 µ$) per run — all configurable per run. `reserveBudget()` must be
called before dispatching any charged step; concurrent runs share a
`BudgetLedger` with a daily ceiling, so overspend is impossible by
construction.

## Out of scope (explicitly)

X / Reddit / Google-Trends-like series / web archives / Wikipedia adapters:
no free-access assumption — they are separate adapters only when access and
terms support them. Disabled or quota-exhausted providers report their actual
state via `health()`; nothing pretends.

## Verifying

```bash
pnpm --filter @afterbyte/research typecheck
pnpm --filter @afterbyte/research test
```

Live adapter checks (read-only, real network):

```bash
pnpm --filter @afterbyte/research exec vitest run tests/adapters.test.ts
```
