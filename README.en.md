# dsh-life-toolkit

> ### What this is
> **Long-term memory for an agent**: index past session text and recall it on demand.
>
> ### What it solves
> Working memory holds the "ledger" (where this task stands); life memory holds the "days" (why we decided that thing three months ago). The latter needs **raw text, not summaries** — a summary loses tone, context and the reasoning of the moment. This repo ships the `life.db` schema, an incremental indexer, a recall plugin, and **a synthetic corpus fixture** so anyone can run the whole chain without owning any real conversations.
>
> ### Run it in one command
> ```powershell
> npm i -g @kira905/dsh-life-toolkit
> dsh-life-init           # create the DB (default <DSH_HOME>/memory-life/life.db)
> dsh-life-index --apply  # incremental index
> dsh-life-recall "why did we change the plan back then"
> ```
>
> ### Real output
> ```text
> usage: node cli/life-db-init.mjs [--home <DSH root>] [--db <file>] [--json] [--help]
>   --home <dir>    DSH data root (default $DSH_HOME, then ~/.dsh)
>   --db <file>     database file (default <home>/memory-life/life.db)
>   --json          machine-readable output
>   --help          print this help only; reads nothing, creates nothing, writes nothing
> ```
>
> 🔴 **Code and schema only**: `life.db` and any real conversation text never enter this repo.

---

> **Life memory: turn your past session logs into original quotes you can actually find again.**
> Working memory (`memory.db`) keeps **conclusions**. This keeps the **days** — what you literally said, on which day, in which turn.

Three CLIs, one plugin, one fake corpus:

| Command | What it does |
|---|---|
| `dsh-life-init` | Create / upgrade the life-memory database (`life.db`, SQLite + FTS5) |
| `dsh-life-index` | Scan session logs (`.jsonl` / `.jsonl.zstd`, any generation) → chunk → index (**dry-run by default**; `--apply` writes) |
| `dsh-life-recall` | Take one sentence and pull back a few old quotes (with time, speaker, surrounding context) |
| plugin `plugin/index.js` | Injects 1–2 old quotes per turn at `agent/pre-step`; injects nothing when there is no hit; fails open |

End-to-end in a clean directory, with zero real data:

```bash
export DSH_HOME=/tmp/fresh-home          # a brand-new empty directory
node cli/life-db-init.mjs                # create the database
node cli/life-index.mjs --apply --root ./fixtures/build/sessions   # build the index
node cli/life-recall.mjs "暖黄色"          # recall → prints the matched original quote
```

## Post-install self-check (three read-only probes)

```powershell
# 1) Is it in the composition tree? (read-only, ~0.6 s, starts nothing)
dsh --profile <profile> --dump-config | Select-String "dsh-life-toolkit"
# expect: one "- id: kira905-life-memory" row, and that id appears exactly once

# 2) Is it in the bundle list? (read-only)
Get-Content <data-root>/profiles/<profile>/package.json | Select-String "@kira905/dsh-life-toolkit"
# expect: present in both dependencies and dsh.profile.bundles

# 3) Does the CLI exist and stay inert? (read-only; creates nothing)
node cli/life-recall.mjs --help
# expect: prints usage, exit code 0, creates no files (`--help` never acts)
```

> To verify the thing that actually matters — "can it remember a quote" — run
> `node tools/verify-clean-home.mjs` (see *Reproducing the claims*).

---

## 1. What is in here

| Path | What it is |
|---|---|
| [`lib/schema.mjs`](./lib/schema.mjs) | `life.db` shape: `sessions` / `chunks` / `chunks_fts` (FTS5 trigram) / `meta`; create, version gate, migration entry |
| [`lib/session-log.mjs`](./lib/session-log.mjs) | Session-log reader: filename generations, **multi-frame zstd splitting**, torn-frame detection, records → turns |
| [`lib/chunker.mjs`](./lib/chunker.mjs) | Text chunking (by code points, line-first, never splits a surrogate pair) |
| [`lib/store.mjs`](./lib/store.mjs) | Index writes: incremental checks, **two-ended shrinking** to keep chunk ids stable, broken-block accounting |
| [`lib/recall-core.mjs`](./lib/recall-core.mjs) | Recall: query expression (phrase / 4-char windows OR), hit filtering, dedupe, injection rendering, budget gate |
| [`lib/defaults.mjs`](./lib/defaults.mjs) | Every tunable number, in one place |
| [`cli/`](./cli) | The three commands (`--help` never acts; unknown flags exit 2) |
| [`plugin/index.js`](./plugin/index.js) | DSH plugin: injects one "old session fragment" block per turn, fail-open |
| [`fixtures/`](./fixtures) | Hand-written fake corpus (3 sessions) + generator: plain / multi-frame zstd / broken-block shapes |
| [`test/`](./test) | 53 regression cases (zero-dependency runner) |
| [`tools/verify-clean-home.mjs`](./tools/verify-clean-home.mjs) | The **soul check**: full chain in an empty home, proving the recalled hit points back to a fixture quote |

## 2. What `life.db` looks like

```sql
sessions(id, source, workspace, dir, file, file_kind, bytes, mtime_ms,
         started_ms, ended_ms, turns, chunk_count, chars, indexed_ms, note)
chunks  (id, session_id, turn_no, ts, role, kind, ord, text, chars, created_ms)
chunks_fts(text)  -- FTS5, tokenize='trigram'
meta(key, value)  -- schema_version, etc.
```

- **One `chunks` row = one piece of original speech**: `role` is `user`/`assistant`; `kind` is `text` (said) or `reasoning` (thought); `ord` is the in-session sequence number.
- **`chunks_fts.rowid == chunks.id`**: no triggers — the code maintains the index explicitly. Row counts of the table and the index **must match**; `life-index` verifies this every run and warns.
- **`tokenize='trigram'`**: Chinese has no spaces, and `unicode61` treats a whole sentence as one token. Trigram indexes 3-character windows, so Chinese phrases (≥3 chars) match directly; the cost is roughly 2–3× the text size in index storage.
- **`sessions.note`**: bookkeeping for broken blocks (torn frames / bad lines / bad frames). `NULL` means the log was clean.

Migration: `SCHEMA_VERSION` + `MIGRATIONS` in `lib/schema.mjs`. **A database newer than the code is refused** (`SCHEMA_TOO_NEW`) — old code must not write a newer schema.

## 3. The indexer: what it reads, what it drops, how it stays incremental

**Reads**: `.jsonl` / `.jsonl.zstd` inside session directories (`session.jsonl`, `session.vN.jsonl.zstd`, any N).

**Keeps only human speech**:

| Kept | Dropped |
|---|---|
| Real `user/message` text | Injected blocks (`data.source.kind` ∈ time context / skill catalog / runtime context / memory recall / tool jobs / pitfall reminder / injected instructions …) |
| `assistant/message` text | Tool calls and tool results |
| `assistant/message` reasoning | Empty messages, non-message events |

**Incremental (two layers)**:

1. If `sessions.mtime_ms + bytes` are unchanged, the file is **not even decompressed** — skipped.
2. Otherwise it recomputes, but keeps chunk ids: **two-ended shrinking** — match the longest identical prefix, then the longest identical suffix; the unmatched middle is updated positionally, extras deleted, new ones inserted.
   Session logs are append-only, so "pure append" = all prefix chunks kept + a few inserts; "tail rewritten" = prefix kept + a few updates.
   ⇒ **chunk ids stay stable**, so anything that referenced a chunk (hit traces, your own excerpts, a future vector table) never dangles.

**Broken blocks (never silently skipped)**:

| Shape | Handling | Reported as |
|---|---|---|
| Torn frame (process killed / mid-write) | Whole frame discarded; **never guessed to full length** | `torn ≥ 1` + offset, recorded in `sessions.note` |
| Bad frame (valid structure, decompression fails) | Counted per frame; other frames still decoded | `badFrames` |
| Bad JSON line | Line skipped | `badLines` |

## 4. Recall: injection format, budget, degradation

Injected block (≤1–2 fragments, ≤320 chars per turn):

```
[人生记忆·旧会话片段] 下面是从我以前的会话原文里找回来的（不是记忆摘要，是原话），可能和现在这句有关：
- 2026-09-01 10:00 · 用户：配色我想好了：灯塔用暖黄色，海面用冷一点的蓝，这样对比明显。
```

- **Short queries** (≤12 chars) match as a phrase; **long queries** are cut into 4-char windows (6 of them, from the middle third) joined with `OR`, ranked by bm25. Everyday questions carry filler like "do you remember…", and a whole-sentence phrase would return nothing.
- **Only `kind='text'`**: reasoning has a naturally high term frequency and would crowd out real speech.
- **Dedupe**: the same quote found in several sessions is kept once (first 60 chars).
- **System notices are not recalled**: queue/restart/auto-notification lines would dredge up unrelated old chatter.
- **Budget**: a line that does not fit is skipped whole (**never cut mid-sentence**), and shorter lines are still tried.
- **Degradation**: bad `MATCH` expression → falls back to `LIKE`; database unavailable → the plugin retries after a 60 s cooldown; any exception → the plugin fails open and returns the turn untouched.
- **Time zone**: rendering uses a fixed offset (`+480` = UTC+8 by default) so output is reproducible; `--tz-offset` changes it.

## 5. Design trade-offs

| Choice | Why |
|---|---|
| **Lexical only, no vectors** | Recall runs every turn; it must not wait on a network round trip or a few hundred ms of encoding. Semantic search belongs to the offline CLI. Deliberately **no half-built vector table** in the schema. |
| **No whole-session DELETE + INSERT** | That replaces every chunk id and instantly dangles anything that referenced them. A little computation buys stable ids. |
| **Index is dry-run by default** | It scans **all** your history and writes your **only** life archive; such a command must not go live on a stray Enter. |
| **`--help` never acts** | Help is for reading. A `--help` that quietly creates a database is the most dangerous kind of helpfulness. |
| **Failures are retried with a cooldown, not forever** | The database may be locked while another process indexes it. A 60 s cooldown neither spins nor gives up permanently. |
| **Fixtures are stored as plain text** | A `.zstd` blob in git is an opaque box. Compressed and broken variants are generated by `fixtures/build.mjs`, deterministically (no timestamps, no randomness). |

## 6. Privacy boundary (hard line)

- 🔴 **Code and schema ship; data does not.** `life.db`, any real session text, any real memory entry: none of it is in this repository.
- 🔴 **Fixtures are entirely hand-written** — three fictional sessions (naming a drawing board / oiling a bookshelf / a sore knee), with no real people, devices, paths or session ids.
- The indexer only **reads** session logs; it never modifies, moves or uploads them. The only thing it writes is `life.db`.
- The plugin opens the database read-only.

## Provenance

This repository covers the same ground as an internal production implementation, but it is an **independent rewrite**, not a copy.

- **Metric**: line-level sameness = for identically named files, the share of this repo's non-empty lines that also appear in the reference implementation (multiset subtraction).
- **Measured (2026-11-02)**: 7 identically named files, **≥50% line sameness = 0%** (nothing byte-identical, nothing ≥90%, nothing 50–90%).
  The highest single file is `plugin/index.js` at **42.7%** — what overlaps is the skeleton forced by framework event names (injection protocol, fail-open, budget); the logic (query building, rendering, dedupe, cooldown retry) is rewritten.
- **Correction**: this metric only covers identically named files. Same-role files with different names (e.g. `lib/session-log.mjs` vs the reference's zstd splitter + filename table + record extractor) are outside it. Among those, **zstd frame splitting is algorithmically shared** — the frame layout is fixed by RFC 8878 and there is no second way to write those bit operations. That note is repeated at the top of `lib/session-log.mjs`.

## Reproducing the claims

```bash
node fixtures/build.mjs            # build the three fake corpora (plain / multi-frame zstd / broken)
node test/run.mjs                  # 53 regression cases (real CLI processes, multi-frame decoding, broken-block counts)
node tools/verify-clean-home.mjs   # soul check: full chain in an empty home + hit points back to a fixture quote
```

`verify-clean-home.mjs` prints the evidence for every step (hit chunk id, matched quote, injectable form); 13 checks in total.

## Requirements

- **Node.js ≥ 22.15** (`node:sqlite`, and zstd in `node:zlib`). Plain `.jsonl` needs no zstd but still needs `node:sqlite`.
- No third-party dependencies. No network access.
- Windows / Linux / macOS (times use a fixed offset, so output is identical across platforms).

## License

[AGPL-3.0-only](./LICENSE).

## Related repositories

This repo is one member of an **open-source release batch**. The others on the same line:

- **Main documentation repo** [`ops-handoff-design`](https://github.com/kira905/ops-handoff-design) — the methodology and design record behind this system (the single authoritative narrative). This repo's position is registered in [`发布说明.md`](https://github.com/kira905/ops-handoff-design/blob/main/发布说明.md) **§4.5 component index** (one row of that table). Mirror: [Gitee](https://gitee.com/kira905/ops-handoff-design).
- **Sibling repo** [`dsh-peer-toolkit`](https://github.com/kira905/dsh-peer-toolkit) — five multi-host helpers (mailbox / route arbitration / text sync / on-demand tunnel + `transportProfile` tiers). Released in the same batch; it covers "machine to machine", this one covers "days". Mirror: [Gitee](https://gitee.com/kira905/dsh-peer-toolkit).

> Each of the three repos tags and releases **independently**; cross-repo references give links rather than copying the other side's prose.
