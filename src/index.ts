import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { createDriveClient, TokenExpiredError, InsufficientScopeError } from "./drive/client";
import { GOOGLE_MIME, OFFICE_MIME, OTHER_MIME, TEXT_EXTRACTABLE_MIMES, SPREADSHEET_MIMES, MEMORY_ALLOWED_MIMES, MEMORY_MAX_SIZE, MEMORY_ROOT_SEGMENTS, UPLOAD_ALLOWED_EXTENSIONS } from "./drive/types";
import type { DriveClient } from "./drive/client";
import { parseSpreadsheetToCSV } from "./parsers/spreadsheet";
import { parseDocxWithImages } from "./parsers/docx";
import { extractOfficeImages } from "./parsers/docx-images";
import { parsePptxWithImages } from "./parsers/pptx";
import { parsePdfWithImages, extractPdfImages } from "./parsers/pdf";
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
• For DOCX, XLSX, PPTX, or PDF files: PREFER download_simplified_text_version. It returns the file's text content directly in the response, which is faster and more reliable. Only use download_file for these formats if the user explicitly needs the original binary file (e.g., to preserve formatting, images, or layout).
• For images, ODT, ODS, and plain text files: use download_file (download_simplified_text_version does not support these).
• For Google Docs, Sheets, or Slides: use the built-in Google Drive integration instead (neither tool supports Google Workspace files).

Image workflow (DOCX, PPTX & PDF):
• download_simplified_text_version for DOCX, PPTX, and PDF files includes [IMAGE: filename] placeholders showing where images appear in the document.
• To view specific images, use extract_images with the filenames from the placeholders.
• You can extract all images at once (omit image_names) or request only specific ones.
• Works with DOCX, PPTX, and PDF files. PDF images are extracted as PNG.

Shared memory (AI/Claude folder on Google Drive):
• Use write_memory_file, read_memory_file, list_memory_files, delete_memory_file to persist knowledge ACROSS projects and ACROSS Claude clients (Claude Code, Claude Desktop, Claude Web).
• Unlike CLAUDE.md (which is local to a single project in Claude Code) or Claude's built-in conversation memory (which is per-conversation), this memory lives on the user's Google Drive in an "AI/Claude" folder and is accessible from ANY Claude client and ANY project.
• Use cases: cross-project context (e.g., architectural decisions that apply to multiple repos), user preferences that should follow them everywhere, shared reference material, handoff notes between Claude Code and Claude Web sessions.
• Organize by project or topic using subfolders (e.g., "myproject/architecture.md", "preferences/coding-style.md").
• Only use this for content that genuinely needs to persist across project/client boundaries. For project-local context, prefer CLAUDE.md; for conversation-local context, prefer built-in memory.

Uploading files (upload_file):
• Creates a NEW file on Google Drive — never overwrites existing files with the same name.
• Use versioned file names (e.g., report_v2.docx, data_2026-02.xlsx) to avoid conflicts.
• Supports office documents, PDF, text, images, and OpenDocument formats. Max 5 MB.
• Text content is passed as-is; binary content (images, Office, PDF) must be base64-encoded.`,
		},
	);

	/** Registered memory tools — toggled visible/hidden based on props.mode */
	private memoryTools: RegisteredTool[] = [];

	/** Registered upload tools — toggled visible/hidden based on props.mode */
	private uploadTools: RegisteredTool[] = [];

	/** Base URL captured from the first incoming request (e.g. "https://my-worker.example.com") */
	private baseUrl = "";

	async _init(props: Props) {
		await super._init(props);

		// Legacy migration: old "full" sessions (before version field) meant "memory only"
		if (!this.props.version) {
			if (this.props.mode === "full") this.props.mode = "memory";
			this.props.version = 2;
			await this.ctx.storage.put("props", this.props);
		}

		this.syncToolVisibility();
	}

	private syncToolVisibility() {
		const mode = this.props?.mode;
		// Memory: enabled for "memory" and "full"
		const enableMemory = mode === "memory" || mode === "full";
		for (const tool of this.memoryTools) {
			if (enableMemory) tool.enable(); else tool.disable();
		}
		// Upload: enabled only for "full"
		const enableUpload = mode === "full";
		for (const tool of this.uploadTools) {
			if (enableUpload) tool.enable(); else tool.disable();
		}
	}

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
			"Download a file from Google Drive in its native binary format. Returns the file as a temporary download URL (for Office/PDF/ODT/ODS) or inline content (for text and images). Supported types: DOC/DOCX, XLS/XLSX, PPT/PPTX, PDF, ODT, ODS, text files (TXT, CSV, HTML, XML), and images. Binary files larger than 25 MB are not supported. Google Workspace files (Google Docs, Sheets, Slides) are not supported — use the built-in Google Drive integration for those. IMPORTANT: For DOCX, XLSX, and PPTX files, prefer download_simplified_text_version instead — it returns the text content directly without requiring URL access. Only use this tool for those formats when the user explicitly needs the original binary file with full formatting, images, or layout. You can pass either the file ID or the exact file name. WARNING: the temporary download URL for binary files is single-use and expires in 5 minutes — do NOT reuse it or share it; call this tool again if you need to download the same file a second time.",
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
									text: `File ready for download:\n${downloadUrl}\n\nFile: ${file.name}\nType: ${mimeType}\nSize: ${buffer.byteLength} bytes\n\nWARNING: this link is single-use and expires in 5 minutes. Do NOT reuse it — call download_file again if you need the file a second time.`,
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
			"Recommended way to read DOCX, PPTX, XLSX, and PDF files from Google Drive. Downloads the file and returns its text content directly in the response — no URL or additional access needed. DOCX returns extracted paragraphs, PPTX returns text organized by slide, PDF returns text organized by page, XLSX returns CSV data per sheet. All formatting, charts, and layout are stripped. Images are replaced with [IMAGE: filename] placeholders — use the extract_images tool with those filenames to view the actual images (works for DOCX, PPTX, and PDF). If the user needs the original file with full formatting and layout preserved, use download_file instead. Google Workspace files (Google Docs, Sheets, Slides) are not supported — use the built-in Google Drive integration for those. You can pass either the file ID or the exact file name.",
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
									text: `This tool only supports DOCX, PPTX, XLSX, and PDF files. The file "${file.name}" has type ${mimeType}. Use download_file instead.`,
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

						// PPTX → text per slide with image placeholders
						if (mimeType === OFFICE_MIME.PPTX) {
							try {
								const { slides, imageNames } = parsePptxWithImages(buffer);
								if (slides.length === 0) {
									return {
										content: [{ type: "text", text: `The presentation "${file.name}" contains no text.` }],
									};
								}
								console.log(`[download_simplified_text_version] PPTX parsed (${slides.length} slide(s), ${imageNames.length} image(s))`);
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

						// PDF → text per page with image placeholders
						if (mimeType === OTHER_MIME.PDF) {
							try {
								const { pages, imageNames } = await parsePdfWithImages(buffer);
								if (pages.length === 0) {
									return {
										content: [{ type: "text", text: `The PDF "${file.name}" contains no extractable text or images. It may be a scanned document.` }],
									};
								}
								console.log(`[download_simplified_text_version] PDF parsed (${pages.length} page(s), ${imageNames.length} image(s))`);
								const content: { type: "text"; text: string }[] = [];
								for (const page of pages) {
									content.push({
										type: "text",
										text: `--- Page ${page.pageNumber} ---\n${page.text}`,
									});
								}
								return { content };
							} catch (parseErr) {
								const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
								console.error(`[download_simplified_text_version] PDF parse error:`, parseErr);
								if (msg.includes("password") || msg.includes("encrypted")) {
									return {
										content: [{
											type: "text",
											text: `The PDF "${file.name}" is password-protected or encrypted and cannot be parsed. Use download_file to get the raw binary instead.`,
										}],
										isError: true,
									};
								}
								return {
									content: [{
										type: "text",
										text: `Failed to parse PDF "${file.name}": ${msg}`,
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
			"extract_images",
			"Extract images from a DOCX, PPTX, or PDF file on Google Drive. Use this after download_simplified_text_version to retrieve the actual images referenced by [IMAGE: filename] placeholders in the text. You can extract all images or specific ones by name. Returns images as inline image content. PDF images are extracted as PNG. You can pass either the file ID or the exact file name.",
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
				console.log(`[extract_images] file_id="${file_id ?? ""}" file_name="${file_name ?? ""}" image_names=${image_names ? JSON.stringify(image_names) : "all"}`);
				try {
					return await this.withTokenRefresh(async (drive) => {
						let file;
						if (file_id) {
							file = await drive.getFileMetadata(file_id);
						} else {
							const matches = await drive.findByName(file_name!);
							console.log(`[extract_images] name lookup "${file_name}" → ${matches.length} match(es)`);
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

						// Validate supported file types
						if (file.mimeType !== OFFICE_MIME.DOCX && file.mimeType !== OFFICE_MIME.PPTX && file.mimeType !== OTHER_MIME.PDF) {
							return {
								content: [{
									type: "text",
									text: `This tool only supports DOCX, PPTX, and PDF files. The file "${file.name}" has type ${file.mimeType}.`,
								}],
								isError: true,
							};
						}

						console.log(`[extract_images] downloading file`);
						const buffer = await drive.downloadFile(file.id);
						console.log(`[extract_images] downloaded ${buffer.byteLength} bytes, extracting images`);

						let images: { fileName: string; mimeType: string; data: Uint8Array }[];
						if (file.mimeType === OTHER_MIME.PDF) {
							images = await extractPdfImages(buffer, image_names);
						} else {
							// DOCX or PPTX — use ZIP-based extraction
							const mediaPrefix = file.mimeType === OFFICE_MIME.DOCX ? "word/media/" : "ppt/media/";
							// For PPTX without explicit image_names, filter to only slide-referenced images
							// (ppt/media/ contains theme/layout/master images we don't want)
							let filterNames = image_names;
							if (file.mimeType === OFFICE_MIME.PPTX && !image_names) {
								const { imageNames: slideImageNames } = parsePptxWithImages(buffer);
								filterNames = slideImageNames;
							}
							images = extractOfficeImages(buffer, mediaPrefix, filterNames);
						}
						if (images.length === 0) {
							const msg = image_names
								? `No matching images found in "${file.name}". Requested: ${image_names.join(", ")}`
								: `No images found in "${file.name}".`;
							return { content: [{ type: "text", text: msg }] };
						}

						console.log(`[extract_images] extracted ${images.length} image(s)`);
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
					console.error(`[extract_images] error:`, err);
					return this.handleDriveError(err);
				}
			},
		);

		this.memoryTools.push(this.server.tool(
			"write_memory_file",
			"Write or update a text file in the shared AI/Claude folder on Google Drive. Use this to persist knowledge ACROSS projects and ACROSS Claude clients (Claude Code, Claude Desktop, Claude Web). Ideal for cross-project context, user preferences, shared reference material, or handoff notes between sessions. NOT a replacement for CLAUDE.md (project-local) or conversation memory. Supports .txt and .md files. Organize by project/topic using subfolders (e.g., \"myproject/architecture.md\").",
			{
				path: z.string().describe("Relative path within AI/Claude (e.g., \"notes.md\" or \"myproject/design.md\")"),
				content: z.string().describe("Text content to write"),
			},
			async ({ path, content }) => {
				console.log(`[write_memory_file] path="${path}"`);
				try {
					const parsed = this.validateMemoryPath(path);
					const contentBytes = new TextEncoder().encode(content);
					if (contentBytes.byteLength > MEMORY_MAX_SIZE) {
						return {
							content: [{ type: "text", text: `Content too large (${contentBytes.byteLength} bytes). Maximum is ${MEMORY_MAX_SIZE} bytes (1 MB).` }],
							isError: true,
						};
					}
					return await this.withTokenRefresh(async (drive) => {
						const { parentId, fileName, mimeType, existingFileId } = await this.resolveMemoryPath(drive, path);
						if (existingFileId) {
							await drive.updateFileContent(existingFileId, content, mimeType);
							console.log(`[write_memory_file] updated existing file ${existingFileId}`);
							return { content: [{ type: "text", text: `Updated AI/Claude/${path}` }] };
						}
						const created = await drive.createFile(fileName, content, mimeType, parentId);
						console.log(`[write_memory_file] created file ${created.id}`);
						return { content: [{ type: "text", text: `Created AI/Claude/${path}` }] };
					});
				} catch (err) {
					console.error(`[write_memory_file] error:`, err);
					return this.handleDriveError(err);
				}
			},
		));

		this.memoryTools.push(this.server.tool(
			"read_memory_file",
			"Read a text file from the shared AI/Claude folder on Google Drive. Use this to retrieve cross-project and cross-client memory persisted by any Claude client (Claude Code, Claude Desktop, Claude Web).",
			{
				path: z.string().describe("Relative path within AI/Claude (e.g., \"notes.md\" or \"myproject/design.md\")"),
			},
			async ({ path }) => {
				console.log(`[read_memory_file] path="${path}"`);
				try {
					this.validateMemoryPath(path);
					return await this.withTokenRefresh(async (drive) => {
						const result = await this.findMemoryFile(drive, path);
						if (!result) {
							return {
								content: [{ type: "text", text: `File not found: AI/Claude/${path}` }],
								isError: true,
							};
						}
						const buffer = await drive.downloadFile(result.fileId);
						const text = new TextDecoder().decode(buffer);
						console.log(`[read_memory_file] read ${text.length} chars from ${result.fileId}`);
						return { content: [{ type: "text", text }] };
					});
				} catch (err) {
					console.error(`[read_memory_file] error:`, err);
					return this.handleDriveError(err);
				}
			},
		));

		this.memoryTools.push(this.server.tool(
			"list_memory_files",
			"List files and subfolders in the shared AI/Claude memory folder on Google Drive. Shows cross-project and cross-client memory files persisted by any Claude client. Optionally specify a subfolder path.",
			{
				path: z.string().optional().describe("Subfolder path within AI/Claude (e.g., \"myproject\"). Omit to list the root AI/Claude folder."),
			},
			async ({ path }) => {
				console.log(`[list_memory_files] path="${path ?? ""}"`);
				try {
					return await this.withTokenRefresh(async (drive) => {
						let folderId: string;
						if (path) {
							// Validate that path segments are safe (no .., no file extension needed)
							const segments = path.split("/").filter(Boolean);
							for (const seg of segments) {
								if (seg === ".." || seg === ".") {
									return {
										content: [{ type: "text", text: `Invalid path segment: "${seg}"` }],
										isError: true,
									};
								}
							}
							// Walk the subfolder path without creating folders
							const rootId = await this.getOrCreateMemoryRoot(drive);
							let currentId = rootId;
							for (const seg of segments) {
								const matches = await drive.findInFolder(seg, currentId);
								const folder = matches.find((f) => f.mimeType === GOOGLE_MIME.FOLDER);
								if (!folder) {
									return {
										content: [{ type: "text", text: `Folder not found: AI/Claude/${path}` }],
										isError: true,
									};
								}
								currentId = folder.id;
							}
							folderId = currentId;
						} else {
							folderId = await this.getOrCreateMemoryRoot(drive);
						}

						const files = await drive.listFolder(folderId);
						console.log(`[list_memory_files] found ${files.length} item(s)`);
						if (files.length === 0) {
							return { content: [{ type: "text", text: "Folder is empty." }] };
						}
						const result = files.map((f) => ({
							name: f.name,
							type: f.mimeType === GOOGLE_MIME.FOLDER ? "folder" : "file",
							modified: f.modifiedTime,
							size: f.size,
							id: f.id,
						}));
						return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
					});
				} catch (err) {
					console.error(`[list_memory_files] error:`, err);
					return this.handleDriveError(err);
				}
			},
		));

		this.memoryTools.push(this.server.tool(
			"delete_memory_file",
			"Permanently delete a file from the shared AI/Claude memory folder on Google Drive. Removes cross-project/cross-client memory that is no longer needed.",
			{
				path: z.string().describe("Relative path within AI/Claude (e.g., \"notes.md\" or \"myproject/old-notes.md\")"),
			},
			async ({ path }) => {
				console.log(`[delete_memory_file] path="${path}"`);
				try {
					this.validateMemoryPath(path);
					return await this.withTokenRefresh(async (drive) => {
						const result = await this.findMemoryFile(drive, path);
						if (!result) {
							return {
								content: [{ type: "text", text: `File not found: AI/Claude/${path}` }],
								isError: true,
							};
						}
						await drive.deleteFile(result.fileId);
						console.log(`[delete_memory_file] deleted ${result.fileId}`);
						return { content: [{ type: "text", text: `Deleted AI/Claude/${path}` }] };
					});
				} catch (err) {
					console.error(`[delete_memory_file] error:`, err);
					return this.handleDriveError(err);
				}
			},
		));

		const UPLOAD_MAX_SIZE = 5 * 1024 * 1024; // 5 MB
		const supportedExtensions = Object.keys(UPLOAD_ALLOWED_EXTENSIONS).join(", ");

		this.uploadTools.push(this.server.tool(
			"upload_file",
			`Upload a new file to Google Drive. Creates a NEW file — never overwrites existing files with the same name. Use versioned file names (e.g., report_v2.docx, data_2026-02.xlsx) to avoid conflicts. Supported extensions: ${supportedExtensions}. Max file size: 5 MB. For text files (.txt, .csv, .html, .xml, .md), pass plain text content. For binary files (images, Office, PDF), pass base64-encoded content.`,
			{
				file_name: z.string().describe("File name with extension (e.g., \"report_v2.docx\", \"photo.png\")"),
				content: z.string().describe("File content: plain text for text files, base64-encoded for binary files"),
				folder_id: z.string().optional().describe("Target folder ID on Google Drive (omit to upload to root)"),
			},
			async ({ file_name, content, folder_id }) => {
				console.log(`[upload_file] file_name="${file_name}" folder_id="${folder_id ?? "root"}"`);
				try {
					// Validate extension
					const dotIdx = file_name.lastIndexOf(".");
					if (dotIdx === -1) {
						return {
							content: [{ type: "text", text: `File name must have an extension. Supported: ${supportedExtensions}` }],
							isError: true,
						};
					}
					const ext = file_name.slice(dotIdx).toLowerCase();
					const mimeType = UPLOAD_ALLOWED_EXTENSIONS[ext];
					if (!mimeType) {
						return {
							content: [{ type: "text", text: `Unsupported extension "${ext}". Supported: ${supportedExtensions}` }],
							isError: true,
						};
					}

					// Validate file name
					const baseName = file_name.slice(0, dotIdx);
					if (!baseName || baseName.trim().length === 0) {
						return {
							content: [{ type: "text", text: "File name cannot be empty or whitespace-only before the extension." }],
							isError: true,
						};
					}
					if (file_name.length > 255) {
						return {
							content: [{ type: "text", text: `File name too long (${file_name.length} chars). Maximum is 255 characters.` }],
							isError: true,
						};
					}
					if (/[\x00-\x1f\x7f]/.test(file_name)) {
						return {
							content: [{ type: "text", text: "File name contains invalid control characters." }],
							isError: true,
						};
					}

					// Encode content to bytes
					let bytes: Uint8Array;
					if (mimeType.startsWith("text/") || mimeType === "text/markdown") {
						bytes = new TextEncoder().encode(content);
					} else {
						try {
							const binary = atob(content);
							bytes = new Uint8Array(binary.length);
							for (let i = 0; i < binary.length; i++) {
								bytes[i] = binary.charCodeAt(i);
							}
						} catch {
							return {
								content: [{ type: "text", text: "Invalid base64 content. Binary files (images, Office, PDF) must be base64-encoded." }],
								isError: true,
							};
						}
					}

					// Check size
					if (bytes.byteLength > UPLOAD_MAX_SIZE) {
						return {
							content: [{ type: "text", text: `File too large (${bytes.byteLength} bytes). Maximum is ${UPLOAD_MAX_SIZE} bytes (5 MB).` }],
							isError: true,
						};
					}

					return await this.withTokenRefresh(async (drive) => {
						const targetFolder = folder_id ?? "root";

						// Block uploads into the AI/Claude memory folder
						if (targetFolder !== "root") {
							const memoryRootId = await this.ctx.storage.get<string>("memoryRootFolderId");
							if (memoryRootId && await this.isFolderInsideMemoryRoot(drive, targetFolder, memoryRootId)) {
								return {
									content: [{ type: "text", text: "Cannot upload to the AI/Claude memory folder. Use write_memory_file instead." }],
									isError: true,
								};
							}
						}

						// Note: This duplicate check is best-effort (TOCTOU race possible with concurrent calls).
						// createBinaryFile always uses POST, so the worst case is two files with the same name,
						// never an overwrite of existing content.
						const existing = await drive.findInFolder(file_name, targetFolder);
						if (existing.length > 0) {
							const baseName = file_name.slice(0, dotIdx);
							return {
								content: [{
									type: "text",
									text: `A file named "${file_name}" already exists in the target folder (id: ${existing[0].id}). This tool never overwrites existing files. Try a versioned name like "${baseName}_v2${ext}".`,
								}],
								isError: true,
							};
						}

						const created = await drive.createBinaryFile(
							file_name,
							bytes,
							mimeType,
							targetFolder === "root" ? undefined : targetFolder,
						);
						console.log(`[upload_file] created file ${created.id}`);
						return {
							content: [{
								type: "text",
								text: `File uploaded successfully.\nName: ${created.name}\nID: ${created.id}\nLink: https://drive.google.com/file/d/${created.id}/view`,
							}],
						};
					});
				} catch (err) {
					console.error(`[upload_file] error:`, err);
					return this.handleDriveError(err);
				}
			},
		));
	}

	private checkWhitelist() {
		const { WHITELIST_USERS, WHITELIST_DOMAINS } = this.env;
		if (!WHITELIST_USERS && !WHITELIST_DOMAINS) return;

		const email = (this.props?.email || "").toLowerCase();
		const domain = email.split("@")[1] || "";
		const allowedUsers = WHITELIST_USERS ? WHITELIST_USERS.split(",").map((u) => u.trim().toLowerCase()) : [];
		const allowedDomains = WHITELIST_DOMAINS ? WHITELIST_DOMAINS.split(",").map((d) => d.trim().toLowerCase()) : [];

		if (!allowedUsers.includes(email) && !allowedDomains.includes(domain)) {
			throw new Error(`Access denied: ${this.props?.email || "unknown"} is not authorized to use this service.`);
		}
	}

	private getDriveClient() {
		this.checkWhitelist();
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
		if (err instanceof InsufficientScopeError) {
			return {
				content: [{
					type: "text" as const,
					text: "This operation requires additional Google Drive permissions (drive.file scope) that were not granted in your current session. Please disconnect and reconnect this MCP server — you'll be prompted to grant the additional permission.",
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

	/**
	 * Check if a folder is the memory root or a subfolder of it.
	 * Walks the parent chain up to 5 levels to detect nesting.
	 */
	private async isFolderInsideMemoryRoot(drive: DriveClient, folderId: string, memoryRootId: string): Promise<boolean> {
		let currentId = folderId;
		for (let i = 0; i < 5; i++) {
			if (currentId === memoryRootId) return true;
			try {
				const meta = await drive.getFileMetadata(currentId);
				if (!meta.parents || meta.parents.length === 0) return false;
				currentId = meta.parents[0];
			} catch {
				return false;
			}
		}
		return false;
	}

	private validateMemoryPath(path: string): { segments: string[]; fileName: string; extension: string } {
		const segments = path.split("/").filter(Boolean);
		if (segments.length === 0) {
			throw new Error("Path cannot be empty.");
		}
		if (segments.length > 5) {
			throw new Error("Path too deep (max 5 segments).");
		}
		for (const seg of segments) {
			if (seg === ".." || seg === ".") {
				throw new Error(`Invalid path segment: "${seg}"`);
			}
		}
		const fileName = segments[segments.length - 1];
		const dotIdx = fileName.lastIndexOf(".");
		if (dotIdx === -1) {
			throw new Error(`File must have .txt or .md extension.`);
		}
		const extension = fileName.slice(dotIdx).toLowerCase();
		if (!MEMORY_ALLOWED_MIMES[extension]) {
			throw new Error(`Unsupported extension "${extension}". Only .txt and .md are allowed.`);
		}
		return { segments, fileName, extension };
	}

	private async getOrCreateMemoryRoot(drive: DriveClient): Promise<string> {
		// Check DO storage cache
		const cached = await this.ctx.storage.get<string>("memoryRootFolderId");
		if (cached) {
			try {
				const meta = await drive.getFileMetadata(cached);
				if (meta.mimeType === GOOGLE_MIME.FOLDER) {
					return cached;
				}
			} catch {
				// Cache is stale, fall through to recreate
			}
		}

		// Walk MEMORY_ROOT_SEGMENTS ("AI" / "Claude"), creating as needed
		let parentId = "root";
		for (const segment of MEMORY_ROOT_SEGMENTS) {
			const matches = await drive.findInFolder(segment, parentId);
			const folder = matches.find((f) => f.mimeType === GOOGLE_MIME.FOLDER);
			if (folder) {
				parentId = folder.id;
			} else {
				const created = await drive.createFolder(segment, parentId === "root" ? undefined : parentId);
				console.log(`[getOrCreateMemoryRoot] created folder "${segment}" → ${created.id}`);
				parentId = created.id;
			}
		}

		await this.ctx.storage.put("memoryRootFolderId", parentId);
		return parentId;
	}

	private async findMemoryFile(drive: DriveClient, path: string): Promise<{ fileId: string; fileName: string } | null> {
		const segments = path.split("/").filter(Boolean);
		const rootId = await this.getOrCreateMemoryRoot(drive);
		let currentId = rootId;

		// Walk subfolders (all segments except the last one, which is the file)
		for (let i = 0; i < segments.length - 1; i++) {
			const matches = await drive.findInFolder(segments[i], currentId);
			const folder = matches.find((f) => f.mimeType === GOOGLE_MIME.FOLDER);
			if (!folder) return null;
			currentId = folder.id;
		}

		const fileName = segments[segments.length - 1];
		const matches = await drive.findInFolder(fileName, currentId);
		if (matches.length === 0) return null;
		return { fileId: matches[0].id, fileName };
	}

	private async resolveMemoryPath(drive: DriveClient, path: string): Promise<{ parentId: string; fileName: string; mimeType: string; existingFileId: string | null }> {
		const { segments, fileName, extension } = this.validateMemoryPath(path);
		const mimeType = MEMORY_ALLOWED_MIMES[extension];
		const rootId = await this.getOrCreateMemoryRoot(drive);
		let currentId = rootId;

		// Walk/create subfolders (all segments except the last one)
		for (let i = 0; i < segments.length - 1; i++) {
			const matches = await drive.findInFolder(segments[i], currentId);
			const folder = matches.find((f) => f.mimeType === GOOGLE_MIME.FOLDER);
			if (folder) {
				currentId = folder.id;
			} else {
				const created = await drive.createFolder(segments[i], currentId);
				console.log(`[resolveMemoryPath] created subfolder "${segments[i]}" → ${created.id}`);
				currentId = created.id;
			}
		}

		// Check if file already exists
		const fileMatches = await drive.findInFolder(fileName, currentId);
		const existingFileId = fileMatches.length > 0 ? fileMatches[0].id : null;

		return { parentId: currentId, fileName, mimeType, existingFileId };
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
