import { task } from "@trigger.dev/sdk";

// Second agent in the pipeline: the search task finds raw candidate practice addresses,
// this task decides which of them are actually legitimate, actionable referral leads —
// rule-based, no network calls, so it's fast and free to run every week.

export type ProviderPayload = {
  npi: string;
  name: string;
  specialtyLabel: string;
  primaryTaxonomy: string;
  npiStatus: string; // "A" = active. Missing/other = treat as not-confirmed-active.
};

export type CandidateGroupPayload = {
  key: string;
  street: string;
  city: string;
  zip: string;
  fullAddress: string;
  practiceName: string; // org/practice name at this address, from an NPI-2 record if one was found
  providers: ProviderPayload[];
  phone: string;
};

// Keywords that mark an address as administrative rather than a place patients (or referral
// coordinators) actually visit — not useful as an outreach target.
const NON_PATIENT_FACING_KEYWORDS = [
  "BILLING",
  "MEDICAL RECORDS",
  "HEALTH INFORMATION",
  "PO BOX",
  "P.O. BOX",
  "ADMINISTRATION",
  "ADMIN OFFICE",
  "CORPORATE OFFICE",
  "ACCOUNTS PAYABLE",
  "REGISTRATION DEPT",
  "REGISTRATION DEPARTMENT",
  "CODING DEPT",
  "HUMAN RESOURCES",
  "CREDENTIALING",
  "CENTRAL BUSINESS OFFICE",
];

function isNonPatientFacing(group: CandidateGroupPayload): boolean {
  const names = group.providers.map((p) => p.name).join(" ");
  const haystack = `${group.fullAddress} ${group.practiceName} ${names}`.toUpperCase();
  return NON_PATIENT_FACING_KEYWORDS.some((kw) => haystack.includes(kw));
}

// Dr. Lin doesn't operate on patients over 65, so geriatric-focused practices/providers
// aren't useful referral sources even when they share a specialty search hit (e.g. an
// "Internal Medicine, Geriatric Medicine" board description matching the Internal Medicine
// sweep). Matches on either the provider's own primary taxonomy/name or the practice name.
// Covers common synonyms beyond the literal word "geriatric" (e.g. "South Shore Elder Care").
const GERIATRIC_KEYWORDS = ["geriatric", "elder care", "eldercare", "elderly care", "senior care"];
function isGeriatric(text: string): boolean {
  const lower = text.toLowerCase();
  return GERIATRIC_KEYWORDS.some((kw) => lower.includes(kw));
}

// Strips suite/unit/floor/room info so two suites in the same building collapse to one
// "building" for dedup purposes (the actual geocoded location is the same either way).
function buildingKey(group: CandidateGroupPayload): string {
  const stripped = group.street
    .replace(/\b(STE|SUITE|UNIT|FL|FLOOR|RM|ROOM|BLDG|BUILDING)\.?\s*[\w-]*/gi, "")
    .replace(/#\s*[\w-]*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return `${stripped}|${group.city}|${group.zip}`.toUpperCase();
}

// Keyed by provider NPIs rather than names — robust to name-formatting differences between
// duplicate sightings of the same doctor (e.g. credential suffix present on one, not the other).
function dedupeKey(group: CandidateGroupPayload): string {
  const npiKey = [...group.providers.map((p) => p.npi)].sort().join("|");
  return `${npiKey}|${buildingKey(group)}`.toUpperCase();
}

function mergeGroups(a: CandidateGroupPayload, b: CandidateGroupPayload): CandidateGroupPayload {
  const byNpi = new Map(a.providers.map((p) => [p.npi, p]));
  for (const p of b.providers) {
    if (!byNpi.has(p.npi)) byNpi.set(p.npi, p);
  }
  return {
    ...a,
    practiceName: a.practiceName || b.practiceName,
    providers: [...byNpi.values()],
    phone: a.phone || b.phone,
  };
}

export type ConfirmResult = {
  confirmed: CandidateGroupPayload[];
  rejectedGeriatricPractices: number;
  rejectedNonPatientFacing: number;
  rejectedEmptyAfterProviderFilter: number;
  removedInactiveProviders: number;
  removedGeriatricProviders: number;
  mergedCount: number;
};

// Pure filtering/dedup logic, split out from the task wrapper so it can run directly (e.g.
// in a local test script) without needing a live Trigger.dev execution context.
export function confirmGroups(groups: CandidateGroupPayload[]): ConfirmResult {
  let rejectedGeriatricPractices = 0;
  let rejectedNonPatientFacing = 0;
  let rejectedEmptyAfterProviderFilter = 0;
  let removedInactiveProviders = 0;
  let removedGeriatricProviders = 0;

  const passed: CandidateGroupPayload[] = [];

  for (const group of groups) {
    // Check the address line too, not just the practice name — some facilities (e.g. VA
    // "GERIATRICS & EXTENDED CARE" buildings) carry the department name in the address
    // rather than as a registered organization name.
    if (isGeriatric(`${group.practiceName} ${group.fullAddress}`)) {
      rejectedGeriatricPractices++;
      continue;
    }
    if (isNonPatientFacing(group)) {
      rejectedNonPatientFacing++;
      continue;
    }

    const keptProviders = group.providers.filter((p) => {
      if (p.npiStatus !== "A") {
        removedInactiveProviders++;
        return false;
      }
      if (isGeriatric(p.primaryTaxonomy) || isGeriatric(p.name)) {
        removedGeriatricProviders++;
        return false;
      }
      return true;
    });

    if (keptProviders.length === 0) {
      rejectedEmptyAfterProviderFilter++;
      continue;
    }

    passed.push({ ...group, providers: keptProviders });
  }

  const byDedupeKey = new Map<string, CandidateGroupPayload>();
  for (const group of passed) {
    const key = dedupeKey(group);
    const existing = byDedupeKey.get(key);
    byDedupeKey.set(key, existing ? mergeGroups(existing, group) : group);
  }

  const confirmed = [...byDedupeKey.values()];
  const mergedCount = passed.length - confirmed.length;

  console.log(
    `Confirm: ${groups.length} candidate addresses -> ${confirmed.length} legitimate ` +
      `(${rejectedGeriatricPractices} geriatric practices, ${rejectedNonPatientFacing} non-patient-facing, ` +
      `${rejectedEmptyAfterProviderFilter} left with no active/eligible provider, ${mergedCount} merged as duplicate suites; ` +
      `provider-level: ${removedInactiveProviders} inactive removed, ${removedGeriatricProviders} geriatric removed)`
  );

  return {
    confirmed,
    rejectedGeriatricPractices,
    rejectedNonPatientFacing,
    rejectedEmptyAfterProviderFilter,
    removedInactiveProviders,
    removedGeriatricProviders,
    mergedCount,
  };
}

export const confirmLegitimateLeads = task({
  id: "confirm-legitimate-leads",
  run: async (payload: { groups: CandidateGroupPayload[] }) => confirmGroups(payload.groups),
});
