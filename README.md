# find-scholarships

Easily find scholarships — Scholarship Navigator helps students discover
scholarships from their profile, verify claims against official evidence,
check eligibility, estimate funding gaps, and plan applications.

## Status

Phase 5 (Dashboard Integration): a shared student workspace with Overview,
My Profile, Scholarships, and Funding Plan navigation. The overview derives
its summary only from data saved in this browser — profile, discovered
scholarships, eligibility assessments, verified upcoming deadlines, and
the confirmed funding gap. Bookmarks are stored separately from discovery
records and never imply an award or confirmed funding. Data stays in
browser local storage; there is no account or cloud sync. Live discovery
requires credentials (see Configuration); without them the endpoint
reports `not_configured` instead of returning invented results.

Multi-source discovery now records every source URL with publisher/type
provenance, classifies official/government/university/aggregator/social
sources, merges cross-source records without overwriting conflicting
facts, and runs targeted official, aggregator, and public Instagram
search lanes. Social posts are discovery leads only — inaccessible posts
remain unverified, and aggregator repetition never counts as official
confirmation.

Application roadmaps and Instagram verification are not implemented yet.

## Run locally

Requirements: Node.js 20+.

```powershell
npm.cmd install
npm.cmd run dev
```

Open http://localhost:3000, create a profile at `/profile`, then run
discovery at `/opportunities`. University selection and personal budget
are optional.

On Windows PowerShell, use `npm.cmd` if script execution blocks `npm.ps1`.

## Configuration

Copy `.env.example` to `.env.local` and fill in:

- `MODEL_API_KEY` — Meta Model API key. Verified API: base URL
  `https://api.meta.ai/v1`, `POST /chat/completions`, Bearer auth,
  example model `muse-spark-1.3` (`META_MODEL`).
- Search uses Meta-native web search grounding by default
  (`SEARCH_PROVIDER=meta`, Responses API `web_search` tool) and reuses
  `MODEL_API_KEY` — no separate search key needed. Brave Web Search
  (`SEARCH_PROVIDER=brave` + `BRAVE_SEARCH_API_KEY`) remains an optional
  alternative.

Keys are used server-side only and never committed. Without them,
`POST /api/discover` returns HTTP 503 with the missing variable names.
Note: live discovery is slow (several minutes) because searches and
extractions run sequentially against the model API.

## Checks

```powershell
npm.cmd test
npm.cmd run build
npx.cmd tsc --noEmit
```
