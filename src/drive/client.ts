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
				includeItemsFromAllDrives: "true",
				supportsAllDrives: "true",
				corpora: "allDrives",
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
				includeItemsFromAllDrives: "true",
				supportsAllDrives: "true",
				corpora: "allDrives",
			});
			const resp = await driveRequest(`${DRIVE_API}/files?${params}`);
			const data = (await resp.json()) as DriveFileList;
			return data.files || [];
		},

		/**
		 * Find files by exact name. Returns all non-trashed matches.
		 */
		async findByName(name: string): Promise<DriveFile[]> {
			const params = new URLSearchParams({
				q: `name = '${name.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}' and trashed = false`,
				fields: `files(${FIELDS})`,
				pageSize: "10",
				includeItemsFromAllDrives: "true",
				supportsAllDrives: "true",
				corpora: "allDrives",
			});
			const resp = await driveRequest(`${DRIVE_API}/files?${params}`);
			const data = (await resp.json()) as DriveFileList;
			return data.files || [];
		},

		/**
		 * Get file metadata.
		 */
		async getFileMetadata(fileId: string): Promise<DriveFile> {
			const params = new URLSearchParams({ fields: FIELDS, supportsAllDrives: "true" });
			const resp = await driveRequest(`${DRIVE_API}/files/${fileId}?${params}`);
			return (await resp.json()) as DriveFile;
		},

		/**
		 * Download a binary file (non-Google Workspace).
		 */
		async downloadFile(fileId: string): Promise<ArrayBuffer> {
			const resp = await driveRequest(`${DRIVE_API}/files/${fileId}?alt=media&supportsAllDrives=true`);
			return resp.arrayBuffer();
		},

		/**
		 * Export a Google Workspace file to a specific MIME type (binary).
		 */
		async exportFile(fileId: string, mimeType: string): Promise<ArrayBuffer> {
			const params = new URLSearchParams({ mimeType, supportsAllDrives: "true" });
			const resp = await driveRequest(`${DRIVE_API}/files/${fileId}/export?${params}`);
			return resp.arrayBuffer();
		},

		/**
		 * Find files by exact name inside a specific parent folder.
		 */
		async findInFolder(name: string, parentId: string): Promise<DriveFile[]> {
			const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
			const params = new URLSearchParams({
				q: `name = '${escapedName}' and '${parentId}' in parents and trashed = false`,
				fields: `files(${FIELDS})`,
				pageSize: "10",
			});
			const resp = await driveRequest(`${DRIVE_API}/files?${params}`);
			const data = (await resp.json()) as DriveFileList;
			return data.files || [];
		},

		/**
		 * Create a folder in Drive.
		 */
		async createFolder(name: string, parentId?: string): Promise<DriveFile> {
			const metadata: Record<string, unknown> = {
				name,
				mimeType: "application/vnd.google-apps.folder",
			};
			if (parentId) metadata.parents = [parentId];
			const resp = await driveRequest(`${DRIVE_API}/files?fields=${FIELDS}`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(metadata),
			});
			return (await resp.json()) as DriveFile;
		},

		/**
		 * Create a file with content via multipart upload.
		 */
		async createFile(name: string, content: string, mimeType: string, parentId: string): Promise<DriveFile> {
			const metadata = JSON.stringify({ name, parents: [parentId] });
			const boundary = "memory_upload_boundary";
			const body =
				`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
				`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n` +
				`--${boundary}--`;
			const resp = await driveRequest(
				`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=${FIELDS}`,
				{
					method: "POST",
					headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
					body,
				},
			);
			return (await resp.json()) as DriveFile;
		},

		/**
		 * Update file content (media-only upload).
		 */
		async updateFileContent(fileId: string, content: string, mimeType: string): Promise<DriveFile> {
			const resp = await driveRequest(
				`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media&fields=${FIELDS}`,
				{
					method: "PATCH",
					headers: { "Content-Type": mimeType },
					body: content,
				},
			);
			return (await resp.json()) as DriveFile;
		},

		/**
		 * Permanently delete a file.
		 */
		async deleteFile(fileId: string): Promise<void> {
			await driveRequest(`${DRIVE_API}/files/${fileId}`, { method: "DELETE" });
		},

};
}

export type DriveClient = ReturnType<typeof createDriveClient>;
