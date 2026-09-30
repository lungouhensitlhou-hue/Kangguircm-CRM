import { importRows, parseCsv } from "@rcm/core";
import { HttpError, route } from "@/lib/api";

export const dynamic = "force-dynamic";

/** Body: raw CSV text (text/csv). Columns: name, npi, specialty, city, state, zip, phone, website, contact_name, contact_email, title. */
export const POST = route(async (req) => {
  const text = await req.text();
  if (text.length > 5_000_000) throw new HttpError(413, "CSV too large (5MB max)");
  const rows = parseCsv(text);
  if (!rows.length) throw new HttpError(400, "CSV has no data rows");
  if (rows.length > 20000) throw new HttpError(400, "Too many rows (20,000 max per import)");
  return importRows(rows);
});
