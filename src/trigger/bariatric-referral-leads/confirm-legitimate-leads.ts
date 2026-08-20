import { task } from "@trigger.dev/sdk";

// Second agent in the pipeline: the search task finds raw candidate practice addresses,
// this task decides which of them are actually legitimate, actionable referral leads —
// rule-based, no network calls, so it's fast and free to run every week.

export type CandidateGroupPayload = {
  key: string;
  street: string;
  city: string;
  zip: string;
  fullAddress: string;
  names: string[];
  specialties: string[];
  npis: string[];
  npiStatuses: string[];
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
  const haystack = `${group.fullAddress} ${group.names.join(" ")}`.toUpperCase();
  return NON_PATIENT_FACING_KEYWORDS.some((kw) => haystack.includes(kw));
}

function hasActiveProvider(group: CandidateGroupPayload): boolean {
  return group.npiStatuses.some((status) => status === "A");
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

function dedupeKey(group: CandidateGroupPayload): string {
  return `${[...group.names].sort().join("|")}|${buildingKey(group)}`.toUpperCase();
}

function mergeGroups(a: CandidateGroupPayload, b: CandidateGroupPayload): CandidateGroupPayload {
  return {
    ...a,
    names: [...new Set([...a.names, ...b.names])],
    specialties: [...new Set([...a.specialties, ...b.specialties])],
    npis: [...new Set([...a.npis, ...b.npis])],
    npiStatuses: [...new Set([...a.npiStatuses, ...b.npiStatuses])],
    phone: a.phone || b.phone,
  };
}

export const confirmLegitimateLeads = task({
  id: "confirm-legitimate-leads",
  run: async (payload: { groups: CandidateGroupPayload[] }) => {
    let rejectedInactive = 0;
    let rejectedNonPatientFacing = 0;

    const passed = payload.groups.filter((group) => {
      if (!hasActiveProvider(group)) {
        rejectedInactive++;
        return false;
      }
      if (isNonPatientFacing(group)) {
        rejectedNonPatientFacing++;
        return false;
      }
      return true;
    });

    const byDedupeKey = new Map<string, CandidateGroupPayload>();
    for (const group of passed) {
      const key = dedupeKey(group);
      const existing = byDedupeKey.get(key);
      byDedupeKey.set(key, existing ? mergeGroups(existing, group) : group);
    }

    const confirmed = [...byDedupeKey.values()];
    const mergedCount = passed.length - confirmed.length;

    console.log(
      `Confirm: ${payload.groups.length} candidates -> ${confirmed.length} legitimate ` +
        `(${rejectedInactive} inactive, ${rejectedNonPatientFacing} non-patient-facing, ${mergedCount} merged as duplicate suites)`
    );

    return { confirmed, rejectedInactive, rejectedNonPatientFacing, mergedCount };
  },
});
