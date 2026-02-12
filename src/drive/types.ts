export interface DriveFile {
	id: string;
	name: string;
	mimeType: string;
	modifiedTime?: string;
	size?: string;
	parents?: string[];
}

export interface DriveFileList {
	files: DriveFile[];
	nextPageToken?: string;
}

// Google Workspace MIME types (not downloadable, must be exported)
export const GOOGLE_MIME = {
	DOC: "application/vnd.google-apps.document",
	SHEET: "application/vnd.google-apps.spreadsheet",
	SLIDES: "application/vnd.google-apps.presentation",
	FOLDER: "application/vnd.google-apps.folder",
} as const;

// Office MIME types
export const OFFICE_MIME = {
	DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	DOC: "application/msword",
	XLS: "application/vnd.ms-excel",
	PPT: "application/vnd.ms-powerpoint",
} as const;

// Other supported MIME types
export const OTHER_MIME = {
	PDF: "application/pdf",
	HTML: "text/html",
	CSV: "text/csv",
	XML: "application/xml",
	TEXT_XML: "text/xml",
	PLAIN: "text/plain",
	ODS: "application/vnd.oasis.opendocument.spreadsheet",
	ODT: "application/vnd.oasis.opendocument.text",
} as const;

export const GOOGLE_EXPORT_MAP: Record<string, { mimeType: string; extension: string }> = {
	[GOOGLE_MIME.DOC]: { mimeType: OFFICE_MIME.DOCX, extension: ".docx" },
	[GOOGLE_MIME.SHEET]: { mimeType: OFFICE_MIME.XLSX, extension: ".xlsx" },
	[GOOGLE_MIME.SLIDES]: { mimeType: OFFICE_MIME.PPTX, extension: ".pptx" },
};

export function isGoogleWorkspace(mimeType: string): boolean {
	return Object.values(GOOGLE_MIME).includes(mimeType as any);
}
