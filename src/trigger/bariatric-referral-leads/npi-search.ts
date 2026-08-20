// Free, no-API-key provider search via the public CMS NPI Registry (NPPES) API.
// Docs: https://npiregistry.cms.hhs.gov/api-page

export const SEED = { lat: 42.0667665, lon: -71.1036592 }; // North Easton, MA 02356

// Towns whose centers fall within ~15 miles of the seed point. Over-including a few
// border towns here is fine — every individual result is geocoded and distance-filtered
// later, so this list only needs to be a safe superset, not a precise radius.
export const TOWNS = [
  "Easton",
  "Brockton",
  "Stoughton",
  "Sharon",
  "Mansfield",
  "Norton",
  "Raynham",
  "West Bridgewater",
  "Bridgewater",
  "Canton",
  "Foxborough",
  "Randolph",
  "Avon",
  "Holbrook",
  "Abington",
  "Whitman",
  "East Bridgewater",
  "Walpole",
  "Rockland",
  "Attleboro",
];

export const SPECIALTIES: Array<{ label: string; taxonomyQuery: string }> = [
  { label: "OB/GYN", taxonomyQuery: "Obstetrics & Gynecology" },
  { label: "Endocrinology", taxonomyQuery: "Endocrinology" },
  { label: "Primary Care", taxonomyQuery: "Family Medicine" },
  { label: "Internal Medicine", taxonomyQuery: "Internal Medicine" },
  { label: "Cardiology", taxonomyQuery: "Cardiovascular Disease" },
];

type NpiAddress = {
  address_1: string;
  address_2?: string;
  city: string;
  state: string;
  postal_code: string;
  telephone_number?: string;
  address_purpose?: string;
};

type NpiResult = {
  number: string;
  enumeration_type: "NPI-1" | "NPI-2";
  basic: {
    organization_name?: string;
    first_name?: string;
    last_name?: string;
    credential?: string;
    status?: string; // "A" = active. Missing/other = treat as not-confirmed-active.
  };
  addresses: NpiAddress[];
  practiceLocations?: NpiAddress[];
  taxonomies: Array<{ desc: string; primary: boolean }>;
};

export type Candidate = {
  npi: string;
  name: string;
  specialtyLabel: string;
  primaryTaxonomy: string;
  addressLine: string;
  city: string;
  postalCode: string;
  phone: string;
  npiStatus: string;
};

function providerName(basic: NpiResult["basic"]): string {
  if (basic.organization_name) return basic.organization_name;
  const cred = basic.credential ? `, ${basic.credential}` : "";
  return `${basic.first_name ?? ""} ${basic.last_name ?? ""}${cred}`.trim();
}

// A provider's top-level "addresses" or "practiceLocations" can span many states (e.g. a
// doctor licensed in both WI and MA) — only the Massachusetts locations are useful leads.
function massachusettsAddresses(result: NpiResult): NpiAddress[] {
  const all = [...(result.addresses ?? []), ...(result.practiceLocations ?? [])];
  const seen = new Set<string>();
  const unique: NpiAddress[] = [];
  for (const addr of all) {
    if (addr.state !== "MA") continue;
    const key = `${addr.address_1}|${addr.city}|${addr.postal_code}`.toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(addr);
  }
  return unique;
}

async function searchNpiRegistry(city: string, taxonomyQuery: string): Promise<NpiResult[]> {
  const params = new URLSearchParams({
    version: "2.1",
    city,
    state: "MA",
    taxonomy_description: taxonomyQuery,
    limit: "200",
  });

  const response = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`NPI Registry search failed (${response.status}) for ${city}/${taxonomyQuery}`);
  }

  const data = (await response.json()) as { results?: NpiResult[] };
  return data.results ?? [];
}

export async function sweepAllTownsAndSpecialties(): Promise<Candidate[]> {
  const candidates: Candidate[] = [];

  for (const town of TOWNS) {
    for (const specialty of SPECIALTIES) {
      const results = await searchNpiRegistry(town, specialty.taxonomyQuery);

      for (const result of results) {
        const name = providerName(result.basic);
        if (!name) continue;

        const primaryTaxonomy =
          result.taxonomies.find((t) => t.primary)?.desc ?? specialty.taxonomyQuery;

        for (const addr of massachusettsAddresses(result)) {
          candidates.push({
            npi: result.number,
            name,
            specialtyLabel: specialty.label,
            primaryTaxonomy,
            addressLine: `${addr.address_1}${addr.address_2 ? " " + addr.address_2 : ""}`,
            city: addr.city,
            postalCode: addr.postal_code,
            phone: addr.telephone_number ?? "",
            npiStatus: result.basic.status ?? "A",
          });
        }
      }
    }
  }

  return candidates;
}
