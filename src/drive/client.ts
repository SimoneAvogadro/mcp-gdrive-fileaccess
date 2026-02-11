import type { DriveFile, DriveFileList } from "./types";

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const FIELDS = "id,name,mimeType,modifiedTime,size,parents";

export class TokenExpiredError extends Error {
	constructor() {
		super("Google access token expired");
		this.name = "TokenExpiredError";
	}
}

export function createDriveClient(accessToken: string) {
	async function driveRequest(url: string, init?: RequestInit): Promise<Response> {
		const resp = await fetch(url, {
			...init,
			headers: {
				Authorization: `Bearer ${accessToken}`,
				...init?.headers,
			},
		});

		if (resp.status === 401) {
			throw new TokenExpiredError();
		}

		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`Drive API error ${resp.status}: ${text}`);
		}

		return resp;
	}

	return {
		/**
		 * Search files by full-text query.
		 */
		async searchFiles(query: string, pageSize = 20): Promise<DriveFile[]> {
			const params = new URLSearchParams({
				q: `fullText contains '${query.replace(/'/g, "\\'")}'`,
				fields: `files(${FIELDS})`,
				pageSize: String(pageSize),
				orderBy: "modifiedTime desc",
			});
			const resp = await driveRequest(`${DRIVE_API}/files?${params}`);
			const data = (await resp.json()) as DriveFileList;
			return data.files || [];
		},

		/**
		 * List files in a folder (default: root).
		 */
		async listFolder(folderId = "root", pageSize = 50): Promise<DriveFile[]> {
			const params = new URLSearchParams({
				q: `'${folderId}' in parents and trashed = false`,
				fields: `files(${FIELDS})`,
				pageSize: String(pageSize),
				orderBy: "modifiedTime desc",
			});
			const resp = await driveRequest(`${DRIVE_API}/files?${params}`);
			const data = (await resp.json()) as DriveFileList;
			return data.files || [];
		},

		/**
		 * Get file metadata.
		 */
		async getFileMetadata(fileId: string): Promise<DriveFile> {
			const params = new URLSearchParams({ fields: FIELDS });
			const resp = await driveRequest(`${DRIVE_API}/files/${fileId}?${params}`);
			return (await resp.json()) as DriveFile;
		},

		/**
		 * Download a binary file (non-Google Workspace).
		 */
		async downloadFile(fileId: string): Promise<ArrayBuffer> {
			const resp = await driveRequest(`${DRIVE_API}/files/${fileId}?alt=media`);
			return resp.arrayBuffer();
		},

		/**
		 * Export a Google Workspace file to a specific MIME type (binary).
		 */
		async exportFile(fileId: string, mimeType: string): Promise<ArrayBuffer> {
			const params = new URLSearchParams({ mimeType });
			const resp = await driveRequest(`${DRIVE_API}/files/${fileId}/export?${params}`);
			return resp.arrayBuffer();
		},

		/**
		 * Export a Google Workspace file to a specific MIME type (text).
		 */
		async exportFileAsText(fileId: string, mimeType: string): Promise<string> {
			const params = new URLSearchParams({ mimeType });
			const resp = await driveRequest(`${DRIVE_API}/files/${fileId}/export?${params}`);
			return resp.text();
		},
	};
}

export type DriveClient = ReturnType<typeof createDriveClient>;
