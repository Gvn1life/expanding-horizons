// Geocoding for the weekly sweep. Bulk candidate addresses go through the Census Bureau's
// free batch geocoder (one HTTP call for the whole list, no key, no rate limit) since it's
// built for exactly this volume. OpenStreetMap's Nominatim — free but capped at 1 req/sec —
// is used only as a per-address fallback for the small number of addresses Census can't
// match (e.g. newer buildings not yet in TIGER), and for the one-off seed-address lookup.

export type LatLon = { lat: number; lon: number };

const NOMINATIM_USER_AGENT =
  "bariatric-referral-leads/1.0 (weekly lead-gen automation via Trigger.dev)";

export type BatchAddress = {
  key: string; // caller's own identifier for mapping results back — never put into the CSV row
  street: string;
  city: string;
  state: string;
  zip: string;
};

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/** Batch-geocodes up to ~10,000 addresses in a single free Census Bureau API call. */
export async function batchGeocodeAddresses(
  addresses: BatchAddress[]
): Promise<Map<string, LatLon>> {
  const results = new Map<string, LatLon>();
  if (addresses.length === 0) return results;

  // CSV row IDs must be simple sequential numbers, not the caller's key — a key containing a
  // comma (e.g. a full "street, city, state zip" string) would otherwise corrupt the row and
  // silently shift every column, which is what caused the batch geocoder to return 0 matches.
  const escape = (value: string) => value.replace(/"/g, '""');
  const csvLines = addresses.map(
    (a, index) => `${index},"${escape(a.street)}","${escape(a.city)}","${a.state}","${a.zip}"`
  );
  const csvBody = csvLines.join("\n") + "\n";

  const form = new FormData();
  form.append("addressFile", new Blob([csvBody], { type: "text/csv" }), "addresses.csv");
  form.append("benchmark", "Public_AR_Current");

  const response = await fetch("https://geocoding.geo.census.gov/geocoder/locations/addressbatch", {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    throw new Error(`Census batch geocoder failed (${response.status})`);
  }

  const text = await response.text();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const fields = parseCsvLine(line);
    const [indexStr, , matchStatus, , , latLon] = fields;
    if (matchStatus !== "Match" || !latLon) continue;

    const address = addresses[Number(indexStr)];
    if (!address) continue;

    const [lon, lat] = latLon.split(",").map(Number);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      results.set(address.key, { lat, lon });
    }
  }

  return results;
}

export async function geocodeAddress(address: string): Promise<LatLon | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(
    address
  )}`;

  const response = await fetch(url, {
    headers: { "User-Agent": NOMINATIM_USER_AGENT },
  });

  if (!response.ok) {
    throw new Error(`Nominatim geocode failed (${response.status}) for "${address}"`);
  }

  const results = (await response.json()) as Array<{ lat: string; lon: string }>;
  if (results.length === 0) return null;

  return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}

export function haversineMiles(a: LatLon, b: LatLon): number {
  const EARTH_RADIUS_MILES = 3958.8;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return EARTH_RADIUS_MILES * 2 * Math.asin(Math.sqrt(h));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
