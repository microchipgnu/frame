# Feedback log

A running triage of feedback from real curation sessions. Items are kept here
even after they're addressed — the trail is more valuable than the cleanup.

---

## 2026-04-30 — first external curation session (`ai-agent-wallets-eu`)

Reviewer used the curation MCP for several rounds against the example frame.
Ran 3 entities × 4–5 facts via x402-paid Exa search + Twitter, all evidence-backed.

### What worked

- **Evidence-with-excerpt discipline.** The required `source.url + excerpt` is the
  load-bearing primitive. *"I literally couldn't make stuff up — I had to either
  find a verbatim quote or skip the field."* That's the protocol earning its keep.
- **Append-only + regenerable projection.** `events.ndjson` as truth, SQLite as
  cache. Easy mental model.
- **7-tool surface.** No "did I want `update_field` or `patch_entity`?" decisions.
- **SQL escape hatch on query.** Saved the session when the projection wasn't enough.
- **Schema-driven enum errors.** `expects one of [...], got "EE"` is friendlier
  than most.

### Friction (ranked by cost)

| # | Issue | Status | Fix |
|---|---|---|---|
| 1 | `better-sqlite3` missing from `package.json` | **fixed** | Added as dep; cross-runtime shim chooses `bun:sqlite` under Bun, `better-sqlite3` under Node. |
| 2 | No schema hot-reload — full MCP restart required after every `schema.yml` edit | **fixed** | mtime-based reload (commit `1d0c633`). |
| 3 | `query mode=all` hides evidence | **fixed** | New `include_sources` flag attaches each field's primary source; new `all_sources` SQL view exposes primary + corroborating in one view. |
| 4 | No bulk write — N round-trips per entity | **fixed** | New `set_facts` (multi-fact, one source) and `add_entity_with_facts` (entity + facts in one call). Atomic. ~5–10× session throughput. |
| 5 | Two-tier evidence storage surprising | **fixed** | `all_sources` view UNIONs `facts` + `evidence` with an `is_primary` column. |
| 6 | Seed enum in the example frame was incomplete | **fixed at the dataset layer (correctly)** | The example frame's `schema.yml` widened to all EU+EEA codes. No engine change — country lists are dataset content, not engine content. The engine knows about *types* (`enum`), not values. |
| 7 | README claims a refresh policy that the runtime doesn't yet implement | **fixed** | Example README explicitly marks the refresh policy as aspirational and points at PLAN.md Stage 1. |

### Conceptual feedback (worth quoting)

> *The whole "AI session as a maintenance loop on an evidence-backed typed dataset"
> is genuinely a good primitive — it's basically a typed wiki agents can't
> hallucinate into, because every cell needs a quote-and-URL. Pair it with paid
> Exa/Twitter via x402 and you've got: semantic search → evidence → typed row,
> in one session, with cost-controlled spending.*

The "typed wiki agents can't hallucinate into" framing is sharp. The shorter
version: **a typed dataset where every value owes a quote.** That's the
elevator pitch for the protocol.

The fact that the reviewer organically ran x402-paid tools through their harness
to feed the MCP is the strongest validation of the runtime architecture: the
protocol/runtime split worked in practice. Treat as Stage 0 graduation evidence.

---

## How to file new feedback

Open a session, hit a wall, summarize the wall in one bullet. Append to this
file under a new dated section. Don't worry about formatting — triage happens
in the next maintenance pass.
