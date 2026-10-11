/**
 * Reading an uploaded customer list: CSV (our own RFC 4180 reader — quotes, embedded newlines,
 * comma / semicolon / tab, a UTF-8 BOM, Windows-1252 fallback) and XLSX (exceljs, pinned). Both
 * come back as the same shape: one header row and string cells. Dates in a spreadsheet come back
 * as YYYY-MM-DD; everything else is the cell's text.
 *
 * Limits: 10 MB per file, 25,000 rows, 60 columns. PURE apart from the dynamic exceljs import.
 */

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ROWS = 25_000;
export const MAX_COLUMNS = 60;
const MAX_CELL = 2000;

export type FileKind = "csv" | "xlsx";

export interface ParsedSheet {
  headers: string[];
  rows: string[][];
  /** Each data row's row number in the spreadsheet (1-based, header included; empty rows counted). */
  lineNumbers: number[];
  sheetName: string | null;
}

export class ImportFileError extends Error {}

/** "customers.xlsx" / a content type → csv | xlsx | null. PURE. */
export function fileKindOf(fileName: string, contentType?: string | null): FileKind | null {
  const name = fileName.toLowerCase().trim();
  if (name.endsWith(".xlsx")) return "xlsx";
  if (name.endsWith(".csv") || name.endsWith(".txt")) return "csv";
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("spreadsheetml")) return "xlsx";
  if (type.includes("csv") || type === "text/plain") return "csv";
  return null;
}

/** UTF-8 (BOM stripped); bytes that aren't valid UTF-8 are read as Windows-1252 (old Excel CSVs). PURE. */
export function decodeText(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("windows-1252").decode(bytes);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** The delimiter of a CSV: whichever of , ; tab splits the first line into the most fields. PURE. */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let best = ",";
  let bestCount = 0;
  for (const d of [",", ";", "\t"]) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count++;
    }
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** RFC 4180-ish: quoted fields, "" escapes, CRLF/LF/CR, newlines inside quotes. PURE. */
export function parseCsvText(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.trim() === "") {
      field = "";
      quoted = true;
      i++;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i++;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      pushRow();
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++;
      if (rows.length > MAX_ROWS + 50) break;
      continue;
    }
    field += ch;
    i++;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

function clean(cell: string): string {
  const t = cell.split(String.fromCharCode(0)).join("").replace(/\s+/g, " ").trim();
  return t.length > MAX_CELL ? t.slice(0, MAX_CELL) : t;
}

/**
 * Raw rows → header + data rows: the first non-empty row is the header, empty rows are dropped,
 * trailing empty columns trimmed, unnamed headers become "Column 7". Throws ImportFileError on a
 * file we can't use (no header, no data, too many rows). PURE.
 */
export function toSheet(raw: string[][], sheetName: string | null = null): ParsedSheet {
  const numbered = raw.map((r, i) => ({ cells: r.map(clean), line: i + 1 })).filter((r) => r.cells.some((c) => c !== ""));
  if (numbered.length === 0) throw new ImportFileError("That file is empty.");
  const rows = numbered.map((r) => r.cells);
  const [headerRow, ...data] = rows;
  const lineNumbers = numbered.slice(1).map((r) => r.line);
  if (data.length === 0) throw new ImportFileError("That file has a header row but no customers under it.");
  if (data.length > MAX_ROWS) throw new ImportFileError(`That file has ${data.length.toLocaleString("en-CA")} rows — the most we take at once is ${MAX_ROWS.toLocaleString("en-CA")}. Split it into smaller files.`);
  let width = 0;
  for (const r of [headerRow, ...data]) {
    for (let c = r.length - 1; c >= 0; c--) {
      if (r[c] !== "") {
        width = Math.max(width, c + 1);
        break;
      }
    }
  }
  if (width > MAX_COLUMNS) throw new ImportFileError(`That file has ${width} columns — the most we read is ${MAX_COLUMNS}. Delete the columns you don't need and try again.`);
  const headers = Array.from({ length: width }, (_, c) => headerRow[c] || `Column ${c + 1}`);
  const body = data.map((r) => Array.from({ length: width }, (_, c) => r[c] ?? ""));
  return { headers, rows: body, lineNumbers, sheetName };
}

export function parseCsv(bytes: Uint8Array): ParsedSheet {
  return toSheet(parseCsvText(decodeText(bytes)));
}

function isoDate(d: Date): string {
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}

/** One exceljs cell value → text. PURE. */
export function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return isoDate(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) return (v.richText as Array<{ text?: string }>).map((p) => p.text ?? "").join("");
    if ("result" in v) return cellText(v.result);
    if (typeof v.text === "string") return v.text;
    if ("error" in v) return "";
  }
  return "";
}

/** XLSX → the sheet with the most rows (usually the only one). */
export async function parseXlsx(bytes: Uint8Array): Promise<ParsedSheet> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(Buffer.from(bytes) as unknown as ArrayBuffer);
  } catch {
    throw new ImportFileError("We couldn't open that spreadsheet. Save it again as .xlsx or .csv and try again.");
  }
  let best: { name: string; count: number; sheet: (typeof workbook.worksheets)[number] } | null = null;
  for (const sheet of workbook.worksheets) {
    const count = sheet.actualRowCount;
    if (!best || count > best.count) best = { name: sheet.name, count, sheet };
  }
  if (!best || best.count === 0) throw new ImportFileError("That spreadsheet is empty.");
  if (best.count > MAX_ROWS + 1) throw new ImportFileError(`That sheet has ${best.count.toLocaleString("en-CA")} rows — the most we take at once is ${MAX_ROWS.toLocaleString("en-CA")}. Split it into smaller files.`);
  const raw: string[][] = [];
  best.sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    // Keep the spreadsheet's row numbers (empty rows are dropped later, but still counted).
    while (raw.length < rowNumber - 1) raw.push([]);
    const values = row.values as unknown[];
    // exceljs row.values is 1-based (index 0 is empty).
    const cells: string[] = [];
    for (let c = 1; c < Math.min(values.length, MAX_COLUMNS + 20); c++) cells.push(cellText(values[c]));
    raw.push(cells);
  });
  return toSheet(raw, best.name);
}

export async function parseImportFile(bytes: Uint8Array, kind: FileKind): Promise<ParsedSheet> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ImportFileError("That file is over 10 MB. Split it into smaller files.");
  return kind === "xlsx" ? parseXlsx(bytes) : parseCsv(bytes);
}
