/**
 * Convert Google Workspace files using Drive export API.
 */
import type { DriveClient } from "../drive/client";
import type { DriveFile } from "../drive/types";

/**
 * Export a Google Doc as Markdown.
 * Google Drive API supports exporting Docs as text/markdown.
 */
export async function convertGoogleDoc(drive: DriveClient, file: DriveFile): Promise<string> {
	const markdown = await drive.exportFileAsText(file.id, "text/markdown");
	return `# ${file.name}\n\n${markdown}`;
}

/**
 * Export a Google Sheet as CSV, then convert to Markdown table.
 */
export async function convertGoogleSheet(drive: DriveClient, file: DriveFile): Promise<string> {
	const csv = await drive.exportFileAsText(file.id, "text/csv");
	return `# ${file.name}\n\n${csvToMarkdownTable(csv)}`;
}

/**
 * Export Google Slides as plain text.
 */
export async function convertGoogleSlides(drive: DriveClient, file: DriveFile): Promise<string> {
	const text = await drive.exportFileAsText(file.id, "text/plain");
	return `# ${file.name}\n\n${text}`;
}

/**
 * Simple CSV to Markdown table converter.
 */
function csvToMarkdownTable(csv: string): string {
	const lines = csv.trim().split("\n");
	if (lines.length === 0) return "*Empty spreadsheet*";

	const rows = lines.map((line) => parseCsvLine(line));
	if (rows.length === 0) return "*Empty spreadsheet*";

	const header = rows[0];
	const separator = header.map(() => "---");

	const mdRows = [header, separator, ...rows.slice(1)];
	return mdRows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

/**
 * Basic CSV line parser that handles quoted fields.
 */
function parseCsvLine(line: string): string[] {
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"') {
				if (i + 1 < line.length && line[i + 1] === '"') {
					current += '"';
					i++;
				} else {
					inQuotes = false;
				}
			} else {
				current += ch;
			}
		} else {
			if (ch === '"') {
				inQuotes = true;
			} else if (ch === ",") {
				fields.push(current.trim());
				current = "";
			} else {
				current += ch;
			}
		}
	}
	fields.push(current.trim());
	return fields;
}
