import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";
import { GoogleHandler } from "./google-handler";
import { convertFile } from "./converters/index";
import { createDriveClient, TokenExpiredError } from "./drive/client";
import { GOOGLE_MIME } from "./drive/types";
import type { Props } from "./utils";

export class OfficeMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: "MCP Office Converter",
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
			"convert_to_markdown",
			"Download a file from Google Drive and convert it to Markdown. Supports DOCX, XLSX, PPTX, PDF, Google Docs, Google Sheets, Google Slides, HTML, CSV, ODT, ODS, and more.",
			{
				file_id: z.string().describe("Google Drive file ID to download and convert"),
			},
			async ({ file_id }) => {
				const drive = this.getDriveClient();
				try {
					const file = await drive.getFileMetadata(file_id);
					const markdown = await convertFile(drive, file, this.env);
					return {
						content: [{ type: "text", text: markdown }],
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
