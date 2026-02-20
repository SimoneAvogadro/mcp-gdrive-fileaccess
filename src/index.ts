import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { createDriveClient, TokenExpiredError } from "./drive/client";
import { GOOGLE_MIME, OFFICE_MIME, OTHER_MIME, TEXT_EXTRACTABLE_MIMES, SPREADSHEET_MIMES } from "./drive/types";
import { parseSpreadsheetToCSV } from "./parsers/spreadsheet";
import { parseDocxWithImages } from "./parsers/docx";
import { extractDocxImages } from "./parsers/docx-images";
import { parsePptxToText } from "./parsers/pptx";
import { refreshAccessToken, type Props } from "./utils";

const BINARY_MIMES: Set<string> = new Set([
	...Object.values(OFFICE_MIME),
	OTHER_MIME.PDF,
	OTHER_MIME.ODS,
	OTHER_MIME.ODT,
]);

const GOOGLE_WORKSPACE_MIMES: Set<string> = new Set(Object.values(GOOGLE_MIME));

function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const CHUNK = 0x2000; // 8 KB — safe for String.fromCharCode.apply
	let binary = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
	}
	return btoa(binary);
}

function isTextMime(mimeType: string): boolean {
	return mimeType.startsWith("text/");
}

export class OfficeMCP extends McpAgent<CloudflareEnv, Record<string, never>, Props> {
	server = new McpServer(
		{
			name: "MCP GDrive FileAccess",
			version: "1.0.0",
			icons: [
				{
					src: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="24" fill="#1a73e8"/><path d="M40 38h30l22 22v36a6 6 0 0 1-6 6H46a6 6 0 0 1-6-6V38z" fill="#fff"/><path d="M70 38l22 22H76a6 6 0 0 1-6-6V38z" fill="#a0c4ff"/><rect x="50" y="70" width="28" height="4" rx="2" fill="#1a73e8"/><rect x="50" y="80" width="20" height="4" rx="2" fill="#1a73e8"/></svg>')}`,
					mimeType: "image/svg+xml",
					sizes: ["any"],
				},
			],
		},
		{
			instructions: `This server provides access to files stored in Google Drive.

IMPORTANT — choosing the right download tool:
• For DOCX, XLSX, or PPTX files: PREFER download_simplified_text_version. It returns the file's text content directly in the response, which is faster and more reliable. Only use download_file for these formats if the user explicitly needs the original binary file (e.g., to preserve formatting, images, or layout).
• For PDFs, images, ODT, ODS, and plain text files: use download_file (download_simplified_text_version does not support these).
• For Google Docs, Sheets, or Slides: use the built-in Google Drive integration instead (neither tool supports Google Workspace files).

DOCX image workflow:
• download_simplified_text_version for DOCX files includes [IMAGE: filename] placeholders showing where images appear in the text.
• To view specific images, use extract_docx_images with the filenames from the placeholders.
• You can extract all images at once (omit image_names) or request only specific ones.`,
		},
	);

	/** Base URL captured from the first incoming request (e.g. "https://my-worker.example.com") */
	private baseUrl = "";

	async fetch(request: Request): Promise<Response> {
		if (!this.baseUrl) {
			this.baseUrl = new URL(request.url).origin;
		}
		return super.fetch(request);
	}

	async init() {
		this.server.tool(
			"search_drive",
			"Search files on Google Drive by keyword. Returns file IDs, names, types, and modification dates. Use this to find files before downloading them.",
			{ query: z.string().describe("Search query (keywords to find in file names or content)") },
			async ({ query }) => {
				console.log(`[search_drive] query="${query}"`);
				try {
					return await this.withTokenRefresh(async (drive) => {
						const files = await drive.searchFiles(query);
						console.log(`[search_drive] found ${files.length} file(s)`);
						if (files.length === 0) {
							return { content: [{ type: "text", text: "No files found matching your query." }] };
						}
						const result = files.map((f) => ({
							id: f.id,
							name: f.name,
							type: f.mimeType,
							modified: f.modifiedTime,
							size: f.size,
						}));
						return {
							content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						};
					});
				} catch (err) {
					console.error(`[search_drive] error:`, err);
					return this.handleDriveError(err);
				}
			},
		);

		this.server.tool(
			"list_folder",
			"List files in a Google Drive folder. If no folder_id is provided, lists the root folder. Returns file IDs, names, types, and modification dates.",
			{
				folder_id: z.string().optional().describe("Google Drive folder ID (omit for root folder)"),
			},
			async ({ folder_id }) => {
				const folderId = folder_id || "root";
				console.log(`[list_folder] folder_id="${folderId}"`);
				try {
					return await this.withTokenRefresh(async (drive) => {
						const files = await drive.listFolder(folderId);
						console.log(`[list_folder] found ${files.length} item(s) in folder "${folderId}"`);
						if (files.length === 0) {
							return { content: [{ type: "text", text: "Folder is empty." }] };
						}
						const result = files.map((f) => ({
							id: f.id,
							name: f.name,
							type: f.mimeType,
							modified: f.modifiedTime,
							size: f.size,
							isFolder: f.mimeType === GOOGLE_MIME.FOLDER,
						}));
						return {
							content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
						};
					});
				} catch (err) {
					console.error(`[list_folder] error:`, err);
					return this.handleDriveError(err);
				}
			},
		);

		this.server.tool(
			"download_file",
			"Download a file from Google Drive in its native binary format. Returns the file as a temporary download URL (for Office/PDF/ODT/ODS) or inline content (for text and images). Supported types: DOC/DOCX, XLS/XLSX, PPT/PPTX, PDF, ODT, ODS, text files (TXT, CSV, HTML, XML), and images. Binary files larger than 25 MB are not supported. Google Workspace files (Google Docs, Sheets, Slides) are not supported — use the built-in Google Drive integration for those. IMPORTANT: For DOCX, XLSX, and PPTX files, prefer download_simplified_text_version instead — it returns the text content directly without requiring URL access. Only use this tool for those formats when the user explicitly needs the original binary file with full formatting, images, or layout. You can pass either the file ID or the exact file name.",
			{
				file_id: z.string().optional().describe("Google Drive file ID to download"),
				file_name: z.string().optional().describe("Exact file name to download (alternative to file_id). If multiple files match, returns a list to disambiguate."),
			},
			async ({ file_id, file_name }) => {
				if (!file_id && !file_name) {
					return {
						content: [{ type: "text", text: "Either file_id or file_name must be provided." }],
						isError: true,
					};
				}
				console.log(`[download_file] file_id="${file_id ?? ""}" file_name="${file_name ?? ""}"`);
				try {
					return await this.withTokenRefresh(async (drive) => {
						let file;
						if (file_id) {
							file = await drive.getFileMetadata(file_id);
						} else {
							const matches = await drive.findByName(file_name!);
							console.log(`[download_file] name lookup "${file_name}" → ${matches.length} match(es)`);
							if (matches.length === 0) {
								return {
									content: [{ type: "text", text: `No file found with name "${file_name}".` }],
									isError: true,
								};
							}
							if (matches.length > 1) {
								const list = matches.map((f) => `  - "${f.name}" (id: ${f.id}, type: ${f.mimeType}, modified: ${f.modifiedTime})`).join("\n");
								return {
									content: [{
										type: "text",
										text: `Multiple files found with name "${file_name}". Use file_id to specify which one:\n${list}`,
									}],
								};
							}
							file = matches[0];
						}
						const mimeType = file.mimeType;
						console.log(`[download_file] "${file.name}" mimeType=${mimeType} size=${file.size ?? "unknown"}`);

						// Google Workspace → not supported, use built-in integration
						if (GOOGLE_WORKSPACE_MIMES.has(mimeType)) {
							console.log(`[download_file] Google Workspace file, rejecting: ${mimeType}`);
							return {
								content: [{
									type: "text",
									text: `Google Workspace files (${mimeType}) are not supported by this tool. Use the built-in Google Drive integration for Google Docs, Sheets, and Slides.`,
								}],
								isError: true,
							};
						}

						// Text files (plain, CSV, HTML, XML) → return as text content
						if (isTextMime(mimeType)) {
							console.log(`[download_file] downloading text file`);
							const buffer = await drive.downloadFile(file.id);
							const text = new TextDecoder().decode(buffer);
							console.log(`[download_file] text decoded (${text.length} chars)`);
							return {
								content: [{ type: "text", text }],
							};
						}

						// Images → return as native MCP image content
						if (mimeType.startsWith("image/")) {
							console.log(`[download_file] downloading image`);
							const buffer = await drive.downloadFile(file.id);
							console.log(`[download_file] downloaded ${buffer.byteLength} bytes, converting to base64`);
							const base64 = arrayBufferToBase64(buffer);
							console.log(`[download_file] base64 ready (${base64.length} chars)`);
							return {
								content: [{
									type: "image",
									data: base64,
									mimeType,
								}],
							};
						}

						// PDF, Office, ODS, ODT → temporary blob URL
						if (BINARY_MIMES.has(mimeType)) {
							console.log(`[download_file] downloading binary file`);
							const buffer = await drive.downloadFile(file.id);
							console.log(`[download_file] downloaded ${buffer.byteLength} bytes, storing in KV`);
							const blobId = crypto.randomUUID();
							await this.env.OAUTH_KV.put(`blob:${blobId}`, buffer, {
								expirationTtl: 300,
								metadata: { mimeType, fileName: file.name },
							});
							const downloadUrl = `${this.baseUrl}/blob/${blobId}`;
							console.log(`[download_file] blob stored, URL: ${downloadUrl}`);
							return {
								content: [{
									type: "text",
									text: `File ready for download:\n${downloadUrl}\n\nFile: ${file.name}\nType: ${mimeType}\nSize: ${buffer.byteLength} bytes\n\nNote: this link expires in 5 minutes and can only be used once.`,
								}],
							};
						}

						// Unsupported type
						console.warn(`[download_file] unsupported file type: ${mimeType}`);
						return {
							content: [{
								type: "text",
								text: `Unsupported file type: ${mimeType}. Supported types: Office documents (DOC, DOCX, XLS, XLSX, PPT, PPTX), PDF, ODT, ODS, text files (TXT, CSV, HTML, XML), and images.`,
							}],
							isError: true,
						};
					});
				} catch (err) {
					console.error(`[download_file] error:`, err);
					return this.handleDriveError(err);
				}
			},
		);

		this.server.tool(
			"download_simplified_text_version",
			"Recommended way to read DOCX, PPTX, and XLSX files from Google Drive. Downloads the file and returns its text content directly in the response — no URL or additional access needed. DOCX returns extracted paragraphs, PPTX returns text organized by slide, XLSX returns CSV data per sheet. All formatting, images, charts, and layout are stripped. If the user needs the original file with full formatting and layout preserved, use download_file instead. Google Workspace files (Google Docs, Sheets, Slides) are not supported — use the built-in Google Drive integration for those. You can pass either the file ID or the exact file name.",
			{
				file_id: z.string().optional().describe("Google Drive file ID to download"),
				file_name: z.string().optional().describe("Exact file name to download (alternative to file_id). If multiple files match, returns a list to disambiguate."),
			},
			async ({ file_id, file_name }) => {
				if (!file_id && !file_name) {
					return {
						content: [{ type: "text", text: "Either file_id or file_name must be provided." }],
						isError: true,
					};
				}
				console.log(`[download_simplified_text_version] file_id="${file_id ?? ""}" file_name="${file_name ?? ""}"`);
				try {
					return await this.withTokenRefresh(async (drive) => {
						let file;
						if (file_id) {
							file = await drive.getFileMetadata(file_id);
						} else {
							const matches = await drive.findByName(file_name!);
							console.log(`[download_simplified_text_version] name lookup "${file_name}" → ${matches.length} match(es)`);
							if (matches.length === 0) {
								return {
									content: [{ type: "text", text: `No file found with name "${file_name}".` }],
									isError: true,
								};
							}
							if (matches.length > 1) {
								const list = matches.map((f) => `  - "${f.name}" (id: ${f.id}, type: ${f.mimeType}, modified: ${f.modifiedTime})`).join("\n");
								return {
									content: [{
										type: "text",
										text: `Multiple files found with name "${file_name}". Use file_id to specify which one:\n${list}`,
									}],
								};
							}
							file = matches[0];
						}
						const mimeType = file.mimeType;
						console.log(`[download_simplified_text_version] "${file.name}" mimeType=${mimeType}`);

						// Google Workspace → not supported, use built-in integration
						if (GOOGLE_WORKSPACE_MIMES.has(mimeType)) {
							return {
								content: [{
									type: "text",
									text: `Google Workspace files (${mimeType}) are not supported by this tool. Use the built-in Google Drive integration for Google Docs, Sheets, and Slides.`,
								}],
								isError: true,
							};
						}

						// Only supported formats
						if (!TEXT_EXTRACTABLE_MIMES.has(mimeType)) {
							return {
								content: [{
									type: "text",
									text: `This tool only supports DOCX, PPTX, and XLSX files. The file "${file.name}" has type ${mimeType}. Use download_file instead.`,
								}],
								isError: true,
							};
						}

						console.log(`[download_simplified_text_version] downloading file`);
						const buffer = await drive.downloadFile(file.id);
						console.log(`[download_simplified_text_version] downloaded ${buffer.byteLength} bytes, parsing`);

						// DOCX → plain text paragraphs with image placeholders
						if (mimeType === OFFICE_MIME.DOCX) {
							try {
								const { text, imageNames } = parseDocxWithImages(buffer);
								if (text.trim().length === 0) {
									return {
										content: [{ type: "text", text: `The document "${file.name}" contains no text.` }],
									};
								}
								console.log(`[download_simplified_text_version] DOCX parsed (${text.length} chars, ${imageNames.length} image(s))`);
								return {
									content: [{ type: "text", text }],
								};
							} catch (parseErr) {
								const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
								console.error(`[download_simplified_text_version] DOCX parse error:`, parseErr);
								return {
									content: [{
										type: "text",
										text: `Failed to parse DOCX "${file.name}": ${msg}`,
									}],
									isError: true,
								};
							}
						}

						// PPTX → text per slide
						if (mimeType === OFFICE_MIME.PPTX) {
							try {
								const slides = parsePptxToText(buffer);
								if (slides.length === 0) {
									return {
										content: [{ type: "text", text: `The presentation "${file.name}" contains no text.` }],
									};
								}
								console.log(`[download_simplified_text_version] PPTX parsed (${slides.length} slide(s))`);
								const content: { type: "text"; text: string }[] = [];
								for (const slide of slides) {
									content.push({
										type: "text",
										text: `--- Slide ${slide.slideNumber} ---\n${slide.text}`,
									});
								}
								return { content };
							} catch (parseErr) {
								const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
								console.error(`[download_simplified_text_version] PPTX parse error:`, parseErr);
								return {
									content: [{
										type: "text",
										text: `Failed to parse PPTX "${file.name}": ${msg}`,
									}],
									isError: true,
								};
							}
						}

						// XLSX → CSV per sheet (existing logic)
						let sheets;
						try {
							sheets = parseSpreadsheetToCSV(buffer);
						} catch (parseErr) {
							const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
							console.error(`[download_simplified_text_version] XLSX parse error:`, parseErr);
							return {
								content: [{
									type: "text",
									text: `Failed to parse spreadsheet "${file.name}": ${msg}`,
								}],
								isError: true,
							};
						}

						if (sheets.length === 0) {
							return {
								content: [{ type: "text", text: `The spreadsheet "${file.name}" contains no data.` }],
							};
						}

						console.log(`[download_simplified_text_version] XLSX parsed ${sheets.length} sheet(s)`);

						if (sheets.length === 1) {
							return {
								content: [{ type: "text", text: sheets[0].csv }],
							};
						}

						// Multiple sheets: summary + one element per sheet
						const content: { type: "text"; text: string }[] = [
							{ type: "text", text: `Spreadsheet "${file.name}" contains ${sheets.length} sheets: ${sheets.map((s) => s.sheetName).join(", ")}` },
						];
						for (const sheet of sheets) {
							content.push({
								type: "text",
								text: `--- Sheet: ${sheet.sheetName} ---\n${sheet.csv}`,
							});
						}
						return { content };
					});
				} catch (err) {
					console.error(`[download_simplified_text_version] error:`, err);
					return this.handleDriveError(err);
				}
			},
		);

		this.server.tool(
			"extract_docx_images",
			"Extract images from a DOCX file on Google Drive. Use this after download_simplified_text_version to retrieve the actual images referenced by [IMAGE: filename] placeholders in the text. You can extract all images or specific ones by name. Returns images as inline image content. You can pass either the file ID or the exact file name.",
			{
				file_id: z.string().optional().describe("Google Drive file ID to download"),
				file_name: z.string().optional().describe("Exact file name to download (alternative to file_id). If multiple files match, returns a list to disambiguate."),
				image_names: z.array(z.string()).optional().describe("Specific image filenames to extract (e.g. [\"image1.png\", \"image3.png\"]). If omitted, all images are returned."),
			},
			async ({ file_id, file_name, image_names }) => {
				if (!file_id && !file_name) {
					return {
						content: [{ type: "text", text: "Either file_id or file_name must be provided." }],
						isError: true,
					};
				}
				console.log(`[extract_docx_images] file_id="${file_id ?? ""}" file_name="${file_name ?? ""}" image_names=${image_names ? JSON.stringify(image_names) : "all"}`);
				try {
					return await this.withTokenRefresh(async (drive) => {
						let file;
						if (file_id) {
							file = await drive.getFileMetadata(file_id);
						} else {
							const matches = await drive.findByName(file_name!);
							console.log(`[extract_docx_images] name lookup "${file_name}" → ${matches.length} match(es)`);
							if (matches.length === 0) {
								return {
									content: [{ type: "text", text: `No file found with name "${file_name}".` }],
									isError: true,
								};
							}
							if (matches.length > 1) {
								const list = matches.map((f) => `  - "${f.name}" (id: ${f.id}, type: ${f.mimeType}, modified: ${f.modifiedTime})`).join("\n");
								return {
									content: [{
										type: "text",
										text: `Multiple files found with name "${file_name}". Use file_id to specify which one:\n${list}`,
									}],
								};
							}
							file = matches[0];
						}

						if (file.mimeType !== OFFICE_MIME.DOCX) {
							return {
								content: [{
									type: "text",
									text: `This tool only supports DOCX files. The file "${file.name}" has type ${file.mimeType}.`,
								}],
								isError: true,
							};
						}

						console.log(`[extract_docx_images] downloading DOCX`);
						const buffer = await drive.downloadFile(file.id);
						console.log(`[extract_docx_images] downloaded ${buffer.byteLength} bytes, extracting images`);

						const images = extractDocxImages(buffer, image_names);
						if (images.length === 0) {
							const msg = image_names
								? `No matching images found in "${file.name}". Requested: ${image_names.join(", ")}`
								: `No images found in "${file.name}".`;
							return { content: [{ type: "text", text: msg }] };
						}

						console.log(`[extract_docx_images] extracted ${images.length} image(s)`);
						const content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[] = [
							{ type: "text", text: `Extracted ${images.length} image(s) from "${file.name}": ${images.map((i) => i.fileName).join(", ")}` },
						];
						for (const img of images) {
							content.push({
								type: "image",
								data: arrayBufferToBase64(img.data.buffer as ArrayBuffer),
								mimeType: img.mimeType,
							});
						}
						return { content };
					});
				} catch (err) {
					console.error(`[extract_docx_images] error:`, err);
					return this.handleDriveError(err);
				}
			},
		);
	}

	private getDriveClient() {
		if (!this.props?.accessToken) {
			throw new Error("Not authenticated. Please sign in with Google first.");
		}
		return createDriveClient(this.props.accessToken);
	}

	private async withTokenRefresh<T>(operation: (drive: ReturnType<typeof createDriveClient>) => Promise<T>): Promise<T> {
		const drive = this.getDriveClient();
		try {
			return await operation(drive);
		} catch (err) {
			if (!(err instanceof TokenExpiredError)) throw err;

			if (!this.props.refreshToken) {
				console.warn("[withTokenRefresh] No refresh token available, cannot refresh");
				throw err;
			}

			console.log("[withTokenRefresh] Access token expired, attempting refresh...");
			const newAccessToken = await refreshAccessToken({
				client_id: this.env.GOOGLE_CLIENT_ID,
				client_secret: this.env.GOOGLE_CLIENT_SECRET,
				refresh_token: this.props.refreshToken,
			});

			this.props.accessToken = newAccessToken;
			await this.ctx.storage.put("props", this.props);
			console.log("[withTokenRefresh] Token refreshed and persisted");

			const newDrive = createDriveClient(newAccessToken);
			return await operation(newDrive);
		}
	}

	private handleDriveError(err: unknown) {
		if (err instanceof TokenExpiredError) {
			return {
				content: [{
					type: "text" as const,
					text: "Google access token has expired. Please re-authenticate by reconnecting the MCP server.",
				}],
				isError: true,
			};
		}
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: "text" as const, text: `Error: ${message}` }],
			isError: true,
		};
	}
}

export default new OAuthProvider({
	apiHandler: OfficeMCP.serve("/mcp"),
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: GoogleHandler as any,
	tokenEndpoint: "/token",
});
