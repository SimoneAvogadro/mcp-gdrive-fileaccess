import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { createDriveClient, TokenExpiredError } from "./drive/client";
import { GOOGLE_MIME, OFFICE_MIME, OTHER_MIME, GOOGLE_EXPORT_MAP, isGoogleWorkspace } from "./drive/types";
import type { Props } from "./utils";

const SUPPORTED_BINARY_MIMES: Set<string> = new Set([
	...Object.values(OFFICE_MIME),
	OTHER_MIME.PDF,
	OTHER_MIME.ODS,
	OTHER_MIME.ODT,
]);

function isTextMime(mimeType: string): boolean {
	return mimeType.startsWith("text/");
}

function isSupportedDirectDownload(mimeType: string): boolean {
	return SUPPORTED_BINARY_MIMES.has(mimeType) || isTextMime(mimeType) || mimeType.startsWith("image/");
}

export class OfficeMCP extends McpAgent<CloudflareEnv, Record<string, never>, Props> {
	server = new McpServer({
		name: "MCP GDrive FileAccess",
		version: "1.0.0",
	});

	async init() {
		this.server.tool(
			"search_drive",
			"Search files on Google Drive by keyword. Returns file IDs, names, types, and modification dates.",
			{ query: z.string().describe("Search query (keywords to find in file names or content)") },
			async ({ query }) => {
				const drive = this.getDriveClient();
				try {
					const files = await drive.searchFiles(query);
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
					return this.handleDriveError(err);
				}
			},
		);

		this.server.tool(
			"list_folder",
			"List files in a Google Drive folder. If no folder_id is provided, lists the root folder.",
			{
				folder_id: z.string().optional().describe("Google Drive folder ID (omit for root folder)"),
			},
			async ({ folder_id }) => {
				const drive = this.getDriveClient();
				try {
					const files = await drive.listFolder(folder_id || "root");
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
					return this.handleDriveError(err);
				}
			},
		);

		this.server.tool(
			"download_file",
			"Download a file from Google Drive in its native format. Supports Office documents (DOC/DOCX, XLS/XLSX, PPT/PPTX), Google Workspace files (exported as Office), PDF, ODT, ODS, text files (TXT, CSV, HTML, XML), and images.",
			{
				file_id: z.string().describe("Google Drive file ID to download"),
			},
			async ({ file_id }) => {
				const drive = this.getDriveClient();
				try {
					const file = await drive.getFileMetadata(file_id);
					const mimeType = file.mimeType;

					// Google Workspace → export as Office format
					if (isGoogleWorkspace(mimeType)) {
						const exportInfo = GOOGLE_EXPORT_MAP[mimeType];
						if (!exportInfo) {
							return {
								content: [{ type: "text", text: `Unsupported Google Workspace type: ${mimeType}` }],
								isError: true,
							};
						}
						const buffer = await drive.exportFile(file.id, exportInfo.mimeType);
						const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
						const fileName = file.name.replace(/\.[^.]*$/, "") + exportInfo.extension;
						return {
							content: [{
								type: "resource",
								resource: {
									uri: `drive:///${file.id}/${fileName}`,
									blob: base64,
									mimeType: exportInfo.mimeType,
								},
							}],
						};
					}

					// Text files (plain, CSV, HTML, XML) → return as text content
					if (isTextMime(mimeType)) {
						const buffer = await drive.downloadFile(file.id);
						const text = new TextDecoder().decode(buffer);
						return {
							content: [{ type: "text", text }],
						};
					}

					// Office, PDF, ODS, ODT, images → direct download as blob
					if (isSupportedDirectDownload(mimeType)) {
						const buffer = await drive.downloadFile(file.id);
						const base64 = btoa(String.fromCharCode(...new Uint8Array(buffer)));
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
					return {
						content: [{
							type: "text",
							text: `Unsupported file type: ${mimeType}. Supported types: Office documents (DOC, DOCX, XLS, XLSX, PPT, PPTX), Google Docs/Sheets/Slides, PDF, ODT, ODS, text files (TXT, CSV, HTML, XML), and images.`,
						}],
						isError: true,
					};
				} catch (err) {
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
