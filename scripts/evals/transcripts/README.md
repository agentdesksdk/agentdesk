# Saved transcripts

Recorded model decisions for the six tasks in `../tasks/v2.tasks.jsonl`,
one JSONL file per client and model. The how-to, the entry shape, and the
exact prompts are in `docs/evaluations.md` under "Capturing a transcript".

A file here is a claim that a person watched a real WebMCP client make
these decisions. Nothing in this directory may be written by hand, and
`pnpm eval --transcript <file>` refuses any entry the loader cannot
validate.

Every entry names the arm it was driven on and the result shape the client
was handed, and it scores only that cell. The eval page hands the model the
structured result, so entries captured there say `"shape":"structured"`;
the bare cells stay unavailable until a page serves a bare result.

## Naming

`<client>-<model>-<YYYY-MM-DD>.jsonl`, for example
`codex-gpt-5-2026-09-02.jsonl`. Files named `tmp-runbook-*.jsonl` are
scratch written and removed by `../test/transcript-runbook.test.mjs`;
if one is left behind, a test was interrupted, and it can be deleted.

## Provenance

Add a row for every file you commit.

| File | Client | Model | Driven by | Page / route | Build (commit) | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| _none yet_ | | | | | | |

`Notes` is where a caveat lives: a client that is unverified in
`docs/testing.md`, a task that could not be posed because the page does not
expose its capability, an entry omitted for that reason. The report shows
coverage as "n of 6"; this table says why n is not 6.

## Running

```bash
pnpm build
pnpm eval --transcript scripts/evals/transcripts/<file>.jsonl --run-id <name>
```

Only `scripts/evals/runs/eval-*` is ignored by git, so a named run can be
committed next to `../runs/reference/` if it is worth keeping.
