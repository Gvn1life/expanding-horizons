import { google } from "googleapis";

export const SHEET_TAB = "Leads";
export const HEADER_ROW = [
  "Practice/Org Name",
  "Specialty",
  "Address",
  "Phone",
  "Distance (mi)",
  "NPI(s)",
  "First Found",
  "Last Seen",
];

export type LeadRow = {
  name: string;
  specialty: string;
  address: string;
  phone: string;
  distanceMiles: number;
  npis: string[];
};

export function normalizeAddressKey(address: string): string {
  return address.trim().toUpperCase().replace(/\s+/g, " ");
}

function getSheetsClient() {
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is not set");
  if (!privateKey) throw new Error("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY is not set");

  const auth = new google.auth.JWT({
    email,
    // Trigger.dev dashboard / .env values store the key with literal "\n" sequences —
    // convert them back to real newlines before signing.
    key: privateKey.replace(/\\n/g, "\n"),
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  return google.sheets({ version: "v4", auth });
}

function getSheetId(): string {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  if (!sheetId) throw new Error("GOOGLE_SHEET_ID is not set");
  return sheetId;
}

/** Creates the "Leads" tab if the spreadsheet doesn't already have one. */
async function ensureSheetTabExists(): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSheetId();

  const spreadsheet = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets.properties.title",
  });
  const titles = spreadsheet.data.sheets?.map((s) => s.properties?.title) ?? [];
  if (titles.includes(SHEET_TAB)) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title: SHEET_TAB } } }] },
  });
}

async function ensureHeader(): Promise<void> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSheetId();

  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TAB}!A1:H1`,
  });

  if (!existing.data.values || existing.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${SHEET_TAB}!A1:H1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER_ROW] },
    });
  }
}

/** Maps normalized address -> 1-indexed sheet row number, for existing leads. */
async function readExistingAddressRows(): Promise<Map<string, number>> {
  const sheets = getSheetsClient();
  const spreadsheetId = getSheetId();

  const result = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SHEET_TAB}!A2:C`,
  });

  const map = new Map<string, number>();
  const rows = result.data.values ?? [];
  rows.forEach((row, index) => {
    const address = row[2]; // column C
    if (address) map.set(normalizeAddressKey(address), index + 2); // +2: header + 1-index
  });
  return map;
}

/**
 * Normalized address keys already present in the sheet. Callers use this to skip re-geocoding
 * practices that were already confirmed in-radius on a previous run — only genuinely new
 * addresses need to hit the geocoders each week.
 */
export async function getKnownLeadKeys(): Promise<Set<string>> {
  await ensureSheetTabExists();
  await ensureHeader();
  const existing = await readExistingAddressRows();
  return new Set(existing.keys());
}

/**
 * Appends genuinely new leads (capped per run, closest-first — pass `leads` pre-sorted by
 * distance) and touches the "Last Seen" date for every already-known lead found again, with
 * no cap. Because already-added leads are skipped on later runs, the cap naturally rolls
 * forward week to week: run 1 adds the 25 closest, run 2 adds the next 25 closest, etc.
 * Returns counts for logging.
 */
export async function syncLeadsToSheet(
  leads: LeadRow[],
  maxNewLeadsPerRun = 25
): Promise<{ added: number; updated: number }> {
  await ensureSheetTabExists();
  await ensureHeader();
  const existingByAddress = await readExistingAddressRows();
  const sheets = getSheetsClient();
  const spreadsheetId = getSheetId();
  const today = new Date().toISOString().slice(0, 10);

  const newRows: string[][] = [];
  const lastSeenUpdates: { range: string; values: string[][] }[] = [];

  for (const lead of leads) {
    const key = normalizeAddressKey(lead.address);
    const existingRow = existingByAddress.get(key);

    if (existingRow) {
      lastSeenUpdates.push({
        range: `${SHEET_TAB}!H${existingRow}:H${existingRow}`,
        values: [[today]],
      });
    } else if (newRows.length < maxNewLeadsPerRun) {
      newRows.push([
        lead.name,
        lead.specialty,
        lead.address,
        lead.phone,
        lead.distanceMiles.toFixed(1),
        lead.npis.join(", "),
        today,
        today,
      ]);
    }
  }

  if (newRows.length > 0) {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${SHEET_TAB}!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: newRows },
    });
  }

  if (lastSeenUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: { valueInputOption: "RAW", data: lastSeenUpdates },
    });
  }

  return { added: newRows.length, updated: lastSeenUpdates.length };
}
