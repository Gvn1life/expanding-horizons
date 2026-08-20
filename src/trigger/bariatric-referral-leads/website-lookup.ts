// Best-effort website lookup via Google's Custom Search JSON API. Free tier covers 100
// queries/day; we only look up new leads (capped at 25/week), so this never approaches
// the limit. Returns "" (not an error) when unconfigured or nothing is found — a missing
// website shouldn't block a lead from being logged.

export async function findWebsite(query: string): Promise<string> {
  const apiKey = process.env.GOOGLE_CUSTOM_SEARCH_API_KEY;
  const engineId = process.env.GOOGLE_CUSTOM_SEARCH_ENGINE_ID;
  if (!apiKey || !engineId) return "";

  const params = new URLSearchParams({ key: apiKey, cx: engineId, q: query, num: "1" });

  try {
    const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params.toString()}`);
    if (!response.ok) {
      console.log(`Website lookup failed (${response.status}) for "${query}"`);
      return "";
    }
    const data = (await response.json()) as { items?: Array<{ link?: string }> };
    return data.items?.[0]?.link ?? "";
  } catch (err) {
    console.log(`Website lookup error for "${query}": ${err}`);
    return "";
  }
}
