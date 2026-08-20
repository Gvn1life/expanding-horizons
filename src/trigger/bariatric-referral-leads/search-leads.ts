import { schedules } from "@trigger.dev/sdk";
import { sweepAllTownsAndSpecialties, SEED, type Candidate } from "./npi-search.js";
import { batchGeocodeAddresses, geocodeAddress, haversineMiles, sleep, type LatLon } from "./geocode.js";
import { syncLeadsToSheet, getKnownLeadKeys, normalizeAddressKey, type LeadRow } from "./sheets.js";
import { confirmLegitimateLeads, type CandidateGroupPayload } from "./confirm-legitimate-leads.js";

// Agent 1: search. Sweeps the NPI Registry, groups results into candidate practice
// addresses, hands them to the confirm agent (agent 2, confirm-legitimate-leads.ts) to
// reject bad matches and merge duplicate suites, then geocodes and radius-filters what's
// left before syncing to the sheet.

const RADIUS_MILES = 15;
const NOMINATIM_DELAY_MS = 1100; // stay under Nominatim's 1 req/sec usage-policy limit

type Group = {
  key: string;
  street: string;
  city: string;
  zip: string;
  fullAddress: string;
  names: Set<string>;
  specialties: Set<string>;
  npis: Set<string>;
  npiStatuses: Set<string>;
  phone: string;
};

function groupByAddress(candidates: Candidate[]): Map<string, Group> {
  const groups = new Map<string, Group>();

  for (const candidate of candidates) {
    const zip = candidate.postalCode.slice(0, 5);
    const fullAddress = `${candidate.addressLine}, ${candidate.city}, MA ${zip}`;
    const key = normalizeAddressKey(fullAddress);

    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        street: candidate.addressLine,
        city: candidate.city,
        zip,
        fullAddress,
        names: new Set(),
        specialties: new Set(),
        npis: new Set(),
        npiStatuses: new Set(),
        phone: "",
      };
      groups.set(key, group);
    }

    group.names.add(candidate.name);
    group.specialties.add(candidate.specialtyLabel);
    group.npis.add(candidate.npi);
    group.npiStatuses.add(candidate.npiStatus);
    if (!group.phone && candidate.phone) group.phone = candidate.phone;
  }

  return groups;
}

function toPayload(group: Group): CandidateGroupPayload {
  return {
    key: group.key,
    street: group.street,
    city: group.city,
    zip: group.zip,
    fullAddress: group.fullAddress,
    names: [...group.names],
    specialties: [...group.specialties],
    npis: [...group.npis],
    npiStatuses: [...group.npiStatuses],
    phone: group.phone,
  };
}

// One bad Nominatim response (network hiccup, transient block) shouldn't sink the whole run —
// treat a failed lookup the same as a not-found and move on to the next address.
async function safeGeocodeAddress(address: string): Promise<LatLon | null> {
  try {
    return await geocodeAddress(address);
  } catch (err) {
    console.log(`Nominatim lookup failed for "${address}": ${err}`);
    return null;
  }
}

async function geocodeGroups(groups: CandidateGroupPayload[]): Promise<Map<string, LatLon>> {
  // Fast path: one bulk call for everything via the free Census batch geocoder.
  const batchResults = await batchGeocodeAddresses(
    groups.map((g) => ({ key: g.key, street: g.street, city: g.city, state: "MA", zip: g.zip }))
  );

  // Fallback: rate-limited Nominatim lookups for the small number Census couldn't match
  // (e.g. newer buildings not yet in the TIGER address ranges).
  const unmatched = groups.filter((g) => !batchResults.has(g.key));
  console.log(
    `Census batch geocoder matched ${groups.length - unmatched.length}/${groups.length}; ` +
      `falling back to Nominatim for ${unmatched.length}`
  );

  for (const group of unmatched) {
    let location = await safeGeocodeAddress(group.fullAddress);
    await sleep(NOMINATIM_DELAY_MS);

    // Some addresses sit on very new/private roads not yet in either geocoder's street
    // index (e.g. the seed building's own "Roche Brothers Way"). Fall back to a
    // town-level approximation rather than dropping a real lead entirely.
    if (!location) {
      location = await safeGeocodeAddress(`${group.city}, MA ${group.zip}`);
      await sleep(NOMINATIM_DELAY_MS);
    }

    if (location) batchResults.set(group.key, location);
  }

  return batchResults;
}

export const searchBariatricReferralLeads = schedules.task({
  id: "bariatric-referral-leads",
  cron: "0 12 * * 5", // Friday 8am ET (fixed UTC offset; drifts ~1hr across DST changes)
  maxDuration: 900,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 5000,
    maxTimeoutInMs: 30_000,
  },

  run: async () => {
    console.log("Sweeping NPI Registry across nearby towns and target specialties...");
    const candidates = await sweepAllTownsAndSpecialties();
    console.log(`Found ${candidates.length} raw provider/location matches`);

    const groupMap = groupByAddress(candidates);
    const groups = [...groupMap.values()];
    console.log(`Grouped into ${groups.length} unique practice addresses`);

    // Practices already logged in a prior run were already confirmed and geocoded — no need
    // to run them through the confirm agent or the geocoders again.
    const knownKeys = await getKnownLeadKeys();
    const knownGroups = groups.filter((g) => knownKeys.has(g.key));
    const newGroups = groups.filter((g) => !knownKeys.has(g.key));
    console.log(`${knownGroups.length} already known, ${newGroups.length} new candidates`);

    // Agent 2: confirm. Rejects inactive NPIs and non-patient-facing addresses, merges
    // duplicate suites of the same practice in the same building.
    const confirmResult = await confirmLegitimateLeads
      .triggerAndWait({ groups: newGroups.map(toPayload) })
      .unwrap();
    const confirmedGroups = confirmResult.confirmed;

    const locations = await geocodeGroups(confirmedGroups);

    const leads: LeadRow[] = [];
    for (const group of confirmedGroups) {
      const location = locations.get(group.key);
      if (!location) continue;

      const distanceMiles = haversineMiles(SEED, location);
      if (distanceMiles > RADIUS_MILES) continue;

      leads.push({
        name: group.names.join(" / "),
        specialty: group.specialties.join(", "),
        address: group.fullAddress,
        phone: group.phone,
        distanceMiles,
        npis: group.npis,
      });
    }
    leads.sort((a, b) => a.distanceMiles - b.distanceMiles);
    console.log(`${leads.length} confirmed practices within ${RADIUS_MILES} miles`);

    // Already-known groups just need their "Last Seen" date touched — distance and
    // legitimacy were already established when they were first added.
    const refreshLeads: LeadRow[] = knownGroups.map((group) => ({
      name: [...group.names].join(" / "),
      specialty: [...group.specialties].join(", "),
      address: group.fullAddress,
      phone: group.phone,
      distanceMiles: 0,
      npis: [...group.npis],
    }));

    const { added, updated } = await syncLeadsToSheet([...leads, ...refreshLeads]);
    console.log(`Sheet sync: ${added} new leads added, ${updated} existing leads refreshed`);

    return { confirmedWithinRadius: leads.length, added, updated };
  },
});
