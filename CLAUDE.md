# trigger-demo

## Web scraping / crawling

Web access for this project goes through the **Firecrawl MCP server** (`mcp__firecrawl__*`),
configured in [.mcp.json](.mcp.json) with the API key in [.env](.env). Use it instead of
generic web search or ad hoc fetching for anything involving a URL — search, single-page
scrapes, full-site crawls, sitemaps, structured extraction, screenshots, or monitoring a
page for changes. This is also the tool to reach for on the bariatric-referral-leads
website lookups that return 403s to plain fetches.

Before using a Firecrawl tool, check [FIRECRAWL_CHEATSHEET.md](FIRECRAWL_CHEATSHEET.md) —
it lists every available tool, what it's for, and its parameters. Pick the tool that matches
the task rather than defaulting to `firecrawl_scrape` for everything:

- One page, need its content → `firecrawl_scrape`
- Don't know the URL yet → `firecrawl_search`
- Need every URL on a site → `firecrawl_map`
- Need content from many/all pages on a site → `firecrawl_crawl`
- Need structured fields (not just markdown) → `firecrawl_extract`
- Need a screenshot → `firecrawl_scrape` with `formats: ["screenshot"]`
- Multi-step navigation (logins, clicks, forms) → `firecrawl_interact`
- Watching a page for changes over time → `firecrawl_monitor_*`

The cheat sheet flags which tool parameters are confirmed vs. unverified — if a call using
an "unverified" tool fails or behaves unexpectedly, pull its live schema with `ToolSearch`
(`select:mcp__firecrawl__<name>`) and update the cheat sheet.
