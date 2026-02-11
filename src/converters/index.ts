/**
 * Dispatcher: routes file conversion based on MIME type.
 */
import type { DriveClient } from "../drive/client";
import type { DriveFile } from "../drive/types";
import { GOOGLE_MIME, OFFICE_MIME, OTHER_MIME } from "../drive/types";
import { convertWithCloudflareAI } from "./cloudflare-native";
import { convertDocxWithMammoth, convertXlsxWithSheetJS } from "./fallbacks";
import { convertGoogleDoc, convertGoogleSheet, convertGoogleSlides } from "./google-workspace";
import { convertPptxToMarkdown } from "./pptx";

// 4MB threshold for fallback converters
const LARGE_FILE_THRESHOLD = 4 * 1024 * 1024;

// MIME types supported by Cloudflare AI toMarkdown
const CF_AI_SUPPORTED = new Set<string>([
	OFFICE_MIME.DOCX,
	OFFICE_MIME.DOC,
	OFFICE_MIME.XLSX,
	OFFICE_MIME.XLS,
	OTHER_MIME.PDF,
	OTHER_MIME.HTML,
	OTHER_MIME.CSV,
	OTHER_MIME.XML,
	OTHER_MIME.TEXT_XML,
	OTHER_MIME.ODS,
	OTHER_MIME.ODT,
]);

export async function convertFile(
	drive: DriveClient,
	file: DriveFile,
	env: Env,
): Promise<string> {
	const { mimeType } = file;
	const fileSize = file.size ? Number(file.size) : 0;

	// Google Workspace types — use export API
	if (mimeType === GOOGLE_MIME.DOC) {
		return convertGoogleDoc(drive, file);
	}
	if (mimeType === GOOGLE_MIME.SHEET) {
		return convertGoogleSheet(drive, file);
	}
	if (mimeType === GOOGLE_MIME.SLIDES) {
		return convertGoogleSlides(drive, file);
	}

	// PPTX — always use custom converter (CF AI doesn't support it)
	if (mimeType === OFFICE_MIME.PPTX || mimeType === OFFICE_MIME.PPT) {
		const buffer = await drive.downloadFile(file.id);
		return convertPptxToMarkdown(file.name, buffer);
	}

	// Large DOCX — use mammoth fallback
	if (mimeType === OFFICE_MIME.DOCX && fileSize > LARGE_FILE_THRESHOLD) {
		const buffer = await drive.downloadFile(file.id);
		const md = await convertDocxWithMammoth(buffer);
		return `# ${file.name}\n\n${md}`;
	}

	// Large XLSX — use SheetJS fallback
	if (mimeType === OFFICE_MIME.XLSX && fileSize > LARGE_FILE_THRESHOLD) {
		const buffer = await drive.downloadFile(file.id);
		const md = convertXlsxWithSheetJS(buffer);
		return `# ${file.name}\n\n${md}`;
	}

	// Cloudflare AI toMarkdown for supported types
	if (CF_AI_SUPPORTED.has(mimeType)) {
		const buffer = await drive.downloadFile(file.id);
		try {
			const md = await convertWithCloudflareAI(env, file.name, buffer, mimeType);
			return `# ${file.name}\n\n${md}`;
		} catch (err) {
			// Fallback for DOCX/XLSX if CF AI fails
			if (mimeType === OFFICE_MIME.DOCX) {
				console.warn("CF AI failed for DOCX, falling back to mammoth:", err);
				const md = await convertDocxWithMammoth(buffer);
				return `# ${file.name}\n\n${md}`;
			}
			if (mimeType === OFFICE_MIME.XLSX || mimeType === OFFICE_MIME.XLS) {
				console.warn("CF AI failed for XLSX, falling back to SheetJS:", err);
				const md = convertXlsxWithSheetJS(buffer);
				return `# ${file.name}\n\n${md}`;
			}
			throw err;
		}
	}

	// Plain text — download directly
	if (mimeType === OTHER_MIME.PLAIN || mimeType?.startsWith("text/")) {
		const buffer = await drive.downloadFile(file.id);
		const text = new TextDecoder().decode(buffer);
		return `# ${file.name}\n\n${text}`;
	}

	// Unsupported type — return metadata
	return [
		`# ${file.name}`,
		"",
		`**Type:** ${mimeType}`,
		`**Size:** ${file.size || "unknown"} bytes`,
		`**Modified:** ${file.modifiedTime || "unknown"}`,
		"",
		"*This file type is not supported for conversion. Only metadata is shown.*",
	].join("\n");
}
