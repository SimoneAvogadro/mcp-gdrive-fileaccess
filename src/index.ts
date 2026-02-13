import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { createDriveClient, TokenExpiredError } from "./drive/client";
import { GOOGLE_MIME, OFFICE_MIME, OTHER_MIME } from "./drive/types";
import type { Props } from "./utils";

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
	server = new McpServer({
		name: "MCP GDrive FileAccess",
		version: "1.0.0",
	});

	async init() {
		this.server.tool(
			"search_drive",
			"Search files on Google Drive by keyword. Returns file IDs, names, types, and modification dates. Use this to find files before downloading them with download_file.",
			{ query: z.string().describe("Search query (keywords to find in file names or content)") },
			async ({ query }) => {
				console.log(`[search_drive] query="${query}"`);
				const drive = this.getDriveClient();
				try {
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
				} catch (err) {
					console.error(`[search_drive] error:`, err);
					return this.handleDriveError(err);
				}
			},
		);

		this.server.tool(
			"list_folder",
			"List files in a Google Drive folder. If no folder_id is provided, lists the root folder. Returns file IDs, names, types, and modification dates. Use download_file to retrieve a specific file.",
			{
				folder_id: z.string().optional().describe("Google Drive folder ID (omit for root folder)"),
			},
			async ({ folder_id }) => {
				const folderId = folder_id || "root";
				console.log(`[list_folder] folder_id="${folderId}"`);
				const drive = this.getDriveClient();
				try {
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
				} catch (err) {
					console.error(`[list_folder] error:`, err);
					return this.handleDriveError(err);
				}
			},
		);

		this.server.tool(
			"download_file",
			"Download a file from Google Drive in its native format. Supports Office documents (DOC/DOCX, XLS/XLSX, PPT/PPTX), PDF, ODT, ODS, text files (TXT, CSV, HTML, XML), and images. Google Workspace files (Google Docs, Sheets, Slides) are not supported — use the built-in Google Drive integration for those. Use this tool whenever you need to read or analyze a file from Google Drive. You can pass either the file ID or the exact file name.",
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
				const drive = this.getDriveClient();
				try {
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

					// PDF, Office, ODS, ODT → resource blob
					if (BINARY_MIMES.has(mimeType)) {
						console.log(`[download_file] downloading binary file`);
						const buffer = await drive.downloadFile(file.id);
						console.log(`[download_file] downloaded ${buffer.byteLength} bytes, converting to base64`);
						const base64 = arrayBufferToBase64(buffer);
						console.log(`[download_file] base64 ready (${base64.length} chars)`);
						return {
							content: [{
								type: "resource",
								resource: {
									uri: `drive:///${file.id}/${file.name}`,
									blob: base64,
									mimeType,
								},
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
				} catch (err) {
					console.error(`[download_file] error:`, err);
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
