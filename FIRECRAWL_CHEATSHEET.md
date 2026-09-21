# Firecrawl MCP Cheat Sheet

Server: `firecrawl` (remote, `https://mcp.firecrawl.dev/v2/mcp`), connected via `mcp-remote`
as a local stdio proxy (see [.mcp.json](.mcp.json)) — the extension's native HTTP/SSE MCP
client can't talk to this server directly (confirmed bug, see below).
Auth: `Authorization: Bearer ${FIRECRAWL_API_KEY}` — key lives in [.env](.env), passed to the
`mcp-remote` subprocess via both `--header` and `env` in [.mcp.json](.mcp.json).
Tool names in Claude Code: `mcp__firecrawl__<tool>`

**Known issue (2026-08-01/02):** only 3 tools are currently reachable —
`firecrawl_scrape`, `firecrawl_search`, `firecrawl_parse` (the anonymous/free tier set).
The full authenticated account tool set (27 tools: map, crawl, extract, agent, interact,
monitor_*, research_*) fails to register — the extension's MCP client receives a valid,
non-empty `tools/list` response from the authenticated connection but reports "Discovered
0 tools." Root cause is isolated to the extension's own handling of that larger/more complex
response (not the API key, not Firecrawl's server, not `mcp-remote` — all confirmed healthy
via direct testing). Treat this as a client bug pending a fix; re-test after extension
updates. Full diagnostic trail in memory: see the auto-memory file on this topic.

If a tool call fails with "server disconnected," it's usually just idle timeout on the
remote transport — the next call typically reconnects automatically.

---

## Core scraping & crawling

### `firecrawl_scrape`
Scrape a single URL, return content in one or more formats.
- `url` (required)
- `formats`: `markdown` | `html` | `rawHtml` | `links` | `screenshot` | `extract` (array)
- `onlyMainContent`: strip nav/ads/footers (default true)
- `includeTags` / `excludeTags`: CSS selectors to keep/drop
- `waitFor`: ms to wait for JS-rendered content
- `actions`: array of page interactions before capture (`click`, `scroll`, `wait`, `screenshot`, `write`)

### `firecrawl_map`
Fast sitemap-style discovery — list URLs found on a site without scraping content.
- `url` (required)
- `search`: filter URLs by keyword
- `limit`
- `includeSubdomains`

### `firecrawl_crawl`
Recursively crawl a site from a starting URL, scraping each page found. Runs async.
- `url` (required)
- `limit`: max pages
- `maxDepth`
- `includePaths` / `excludePaths`: glob/regex path filters
- `scrapeOptions`: same shape as `firecrawl_scrape` formats/options, applied per page
- Returns a job `id` — poll with `firecrawl_check_crawl_status`

### `firecrawl_check_crawl_status`
- `id` (required, from `firecrawl_crawl`)
- Returns status (`scraping`/`completed`), page counts, and data as pages finish

### `firecrawl_extract`
LLM-powered structured data extraction from one or more URLs.
- `urls` (required, array)
- `prompt`: natural-language description of what to extract
- `schema`: JSON schema for the desired output shape (use instead of or with `prompt`)

### `firecrawl_parse`
*(Verify on reconnect — likely parses a given document/page, e.g. PDF or complex HTML, into clean structured content without the crawl/search overhead.)*

---

## Search

### `firecrawl_search` — confirmed working
Web/news/image search with optional full-page content scraping of results.
- `query` (required)
- `limit`
- `sources`: `web` | `news` | `images`
- `scrapeOptions`: fetch full content for each result, not just snippet
- Response includes `id` and `creditsUsed` — pass `id` to `firecrawl_search_feedback` to refund 1 credit after use

### `firecrawl_search_feedback`
Send quality feedback on a prior search using its `id` (refunds 1 credit per MCP server instructions).

---

## Agent & interactive browsing

*(Names below are confirmed to exist; exact parameters unverified — check via `ToolSearch` once reconnected.)*

### `firecrawl_agent`
Runs an autonomous browsing agent against a task/instruction (multi-step navigation, not just a single scrape).

### `firecrawl_agent_status`
Poll status/result of an async `firecrawl_agent` run by its job id.

### `firecrawl_interact`
Opens a live, stateful browser session you can drive step-by-step (click/type/navigate), useful for logins or multi-step flows.

### `firecrawl_interact_stop`
Ends an `firecrawl_interact` session.

---

## Monitoring (change tracking)

*(Unverified params — likely CRUD + run/check around a scheduled watcher.)*

- `firecrawl_monitor_create` — define a monitor (URL + schedule + what to watch for)
- `firecrawl_monitor_get` — fetch one monitor's config
- `firecrawl_monitor_list` — list all monitors
- `firecrawl_monitor_update` — edit a monitor
- `firecrawl_monitor_delete` — remove a monitor
- `firecrawl_monitor_run` — trigger a monitor check on demand
- `firecrawl_monitor_check` — get the result of a specific check
- `firecrawl_monitor_checks` — list check history for a monitor

---

## Research (academic / code)

*(Unverified params.)*

- `firecrawl_research_search_papers` — search academic papers (likely arXiv/Semantic Scholar-backed)
- `firecrawl_research_read_paper` — pull full text/content of a specific paper
- `firecrawl_research_inspect_paper` — metadata/summary view of a paper
- `firecrawl_research_related_papers` — citation/similarity graph lookup
- `firecrawl_research_search_github` — search GitHub repos relevant to research topics

---

## Feedback

- `firecrawl_feedback` — general feedback on a tool result
- `firecrawl_search_feedback` — feedback specifically on a search (see above)

---

## Notes
- Credits are consumed per call and reported in `creditsUsed` on responses.
- Prefer `firecrawl_search` over generic web search for anything in this project per the MCP server's own instructions.
- Sections marked "unverified" should be confirmed by loading the tool's schema (`ToolSearch` with `select:mcp__firecrawl__<name>`) before relying on exact parameter names.
