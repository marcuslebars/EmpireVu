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
export function toSheet(raw: string[][], sheetName: string | null = null, rawLines?: number[]): ParsedSheet {
  const numbered = raw.map((r, i) => ({ cells: r.map(clean), line: rawLines?.[i] ?? i + 1 })).filter((r) => r.cells.some((c) => c !== ""));
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

/** Shared strings are held in memory while a sheet streams: past this, the file is refused. */
export const MAX_SHARED_STRINGS_BYTES = 32 * 1024 * 1024;

/**
 * The entries of a zip (an .xlsx) from its central directory, without inflating anything:
 * name + uncompressed size. Null when it isn't a readable zip (or needs ZIP64). PURE.
 */
export function zipEntries(bytes: Uint8Array): Array<{ name: string; size: number }> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.byteLength - 22 - 65_535);
  let eocd = -1;
  for (let i = bytes.byteLength - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out: Array<{ name: string; size: number }> = [];
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== 0x02014b50) return null;
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    if (size === 0xffffffff) return null;
    out.push({ name: new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLen)), size });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const XLSX_UNREADABLE = "We couldn't open that spreadsheet. Save it again as .xlsx or .csv and try again.";
const tooManyRows = () => new ImportFileError(`That sheet has more than ${MAX_ROWS.toLocaleString("en-CA")} rows — the most we take at once. Split it into smaller files.`);

/**
 * XLSX → the sheet with the most rows (usually the only one). STREAMED (exceljs WorkbookReader)
 * and stopped at MAX_ROWS: a full workbook load of a 10 MB file with 240k rows takes ~900 MB, so
 * it's never loaded whole. The shared-strings part (held in memory) is size-checked from the zip
 * directory first.
 */
export async function parseXlsx(bytes: Uint8Array): Promise<ParsedSheet> {
  const entries = zipEntries(bytes);
  if (!entries || !entries.some((e) => e.name.startsWith("xl/"))) throw new ImportFileError(XLSX_UNREADABLE);
  const shared = entries.find((e) => e.name === "xl/sharedStrings.xml");
  if (shared && shared.size > MAX_SHARED_STRINGS_BYTES) throw new ImportFileError("That spreadsheet is too big to read. Save just the customer columns as a .csv and try again.");

  const ExcelJS = (await import("exceljs")).default;
  const { Readable } = await import("node:stream");
  let best: { name: string | null; raw: string[][]; lines: number[] } | null = null;
  try {
    const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([Buffer.from(bytes)]), {
      worksheets: "emit",
      sharedStrings: "cache",
      styles: "cache",
      hyperlinks: "ignore",
      entries: "ignore",
    });
    for await (const sheet of reader) {
      const raw: string[][] = [];
      const lines: number[] = [];
      for await (const row of sheet as AsyncIterable<{ number: number; values: unknown }>) {
        if (raw.length > MAX_ROWS + 1) throw tooManyRows();
        const values = (Array.isArray(row.values) ? row.values : []) as unknown[];
        // exceljs row.values is 1-based (index 0 is empty).
        const cells: string[] = [];
        for (let c = 1; c < Math.min(values.length, MAX_COLUMNS + 20); c++) cells.push(cellText(values[c]));
        raw.push(cells);
        lines.push(row.number);
      }
      const name = (sheet as { name?: string }).name ?? null;
      if (!best || raw.length > best.raw.length) best = { name, raw, lines };
    }
  } catch (err) {
    if (err instanceof ImportFileError) throw err;
    throw new ImportFileError(XLSX_UNREADABLE);
  }
  if (!best || best.raw.length === 0) throw new ImportFileError("That spreadsheet is empty.");
  return toSheet(best.raw, best.name, best.lines);
}

export async function parseImportFile(bytes: Uint8Array, kind: FileKind): Promise<ParsedSheet> {
  if (bytes.byteLength > MAX_FILE_BYTES) throw new ImportFileError("That file is over 10 MB. Split it into smaller files.");
  return kind === "xlsx" ? parseXlsx(bytes) : parseCsv(bytes);
}
