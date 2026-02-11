/**
 * Fallback converters for large files (>4MB) where env.AI.toMarkdown() may fail.
 * Uses mammoth.js for DOCX and SheetJS for XLSX.
 */
import { convertToMarkdown } from "mammoth";
import * as XLSX from "xlsx";

/**
 * Convert DOCX to Markdown using mammoth.js.
 */
export async function convertDocxWithMammoth(buffer: ArrayBuffer): Promise<string> {
	const result = await convertToMarkdown({ arrayBuffer: buffer });
	if (result.messages.length > 0) {
		console.warn("mammoth warnings:", result.messages.map((m) => m.message).join("; "));
	}
	return result.value;
}

/**
 * Convert XLSX to Markdown table using SheetJS.
 */
export function convertXlsxWithSheetJS(buffer: ArrayBuffer): string {
	const workbook = XLSX.read(buffer, { type: "array" });

	const sheets: string[] = [];

	for (const sheetName of workbook.SheetNames) {
		const sheet = workbook.Sheets[sheetName];
		const csv = XLSX.utils.sheet_to_csv(sheet);

		if (!csv.trim()) continue;

		sheets.push(`## ${sheetName}\n\n${csvToMarkdownTable(csv)}`);
	}

	if (sheets.length === 0) {
		return "*Empty workbook*";
	}

	return sheets.join("\n\n");
}

function csvToMarkdownTable(csv: string): string {
	const lines = csv.trim().split("\n");
	if (lines.length === 0) return "";

	const rows = lines.map((line) => line.split(",").map((cell) => cell.trim()));
	const header = rows[0];
	const separator = header.map(() => "---");
	const mdRows = [header, separator, ...rows.slice(1)];
	return mdRows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}
