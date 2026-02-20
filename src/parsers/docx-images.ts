import { unzipSync } from "fflate";

export interface ExtractedImage {
	fileName: string;
	mimeType: string;
	data: Uint8Array;
}

const EXTENSION_MIME: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".bmp": "image/bmp",
	".tiff": "image/tiff",
	".tif": "image/tiff",
	".svg": "image/svg+xml",
	".webp": "image/webp",
};

// Extensions for formats that Claude cannot display
const SKIP_EXTENSIONS = new Set([".emf", ".wmf"]);

function getExtension(fileName: string): string {
	const dot = fileName.lastIndexOf(".");
	return dot >= 0 ? fileName.slice(dot).toLowerCase() : "";
}

/**
 * Extract images from a DOCX file.
 *
 * @param buffer - The DOCX file as an ArrayBuffer
 * @param imageNames - Optional list of image filenames to extract. If omitted, all images are returned.
 * @returns Array of extracted images with fileName, mimeType, and raw data
 */
export function extractDocxImages(
	buffer: ArrayBuffer,
	imageNames?: string[],
): ExtractedImage[] {
	const data = new Uint8Array(buffer);
	const nameFilter = imageNames ? new Set(imageNames) : null;

	const files = unzipSync(data, {
		filter: (file) => file.name.startsWith("word/media/"),
	});

	const results: ExtractedImage[] = [];

	for (const [path, content] of Object.entries(files)) {
		const fileName = path.split("/").pop()!;
		const ext = getExtension(fileName);

		// Skip non-displayable formats
		if (SKIP_EXTENSIONS.has(ext)) continue;

		// If specific names requested, filter
		if (nameFilter && !nameFilter.has(fileName)) continue;

		const mimeType = EXTENSION_MIME[ext];
		if (!mimeType) continue;

		results.push({ fileName, mimeType, data: content });
	}

	return results;
}
