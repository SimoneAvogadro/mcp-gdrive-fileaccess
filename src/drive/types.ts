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

// Native spreadsheet MIME types supported by the text parser (XLSX only for now)
export const SPREADSHEET_MIMES: Set<string> = new Set([
	OFFICE_MIME.XLSX,
]);

// MIME types that can be converted to plain text by download_simplified_text_version
export const TEXT_EXTRACTABLE_MIMES: Set<string> = new Set([
	OFFICE_MIME.XLSX,
	OFFICE_MIME.DOCX,
	OFFICE_MIME.PPTX,
	OTHER_MIME.PDF,
]);

// Allowed file extensions for upload_file tool (extension → MIME type)
export const UPLOAD_ALLOWED_EXTENSIONS: Record<string, string> = {
	".docx": OFFICE_MIME.DOCX,
	".xlsx": OFFICE_MIME.XLSX,
	".pptx": OFFICE_MIME.PPTX,
	".doc": OFFICE_MIME.DOC,
	".xls": OFFICE_MIME.XLS,
	".ppt": OFFICE_MIME.PPT,
	".pdf": OTHER_MIME.PDF,
	".odt": OTHER_MIME.ODT,
	".ods": OTHER_MIME.ODS,
	".txt": OTHER_MIME.PLAIN,
	".csv": OTHER_MIME.CSV,
	".html": OTHER_MIME.HTML,
	".xml": OTHER_MIME.XML,
	".md": "text/markdown",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".json": "application/json",
	".yaml": "application/x-yaml",
	".yml": "application/x-yaml",
	".js": "application/javascript",
	".ts": "application/typescript",
	".py": "text/x-python",
	".sh": "application/x-sh",
	".sql": "application/sql",
	".rtf": "application/rtf",
};

// MIME types under application/* that are text-decodable (not binary)
export const TEXT_DECODABLE_APP_MIMES: Set<string> = new Set([
	"application/json",
	"application/xml",
	"application/javascript",
	"application/x-yaml",
	"application/sql",
	"application/rtf",
	"application/x-sh",
	"application/typescript",
]);

// Shared memory file constants
export const MEMORY_ALLOWED_MIMES: Record<string, string> = {
	".txt": "text/plain",
	".md": "text/markdown",
};
export const MEMORY_MAX_SIZE = 1 * 1024 * 1024;
export const MEMORY_ROOT_SEGMENTS = ["AI", "Claude"] as const;

