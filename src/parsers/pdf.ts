import { definePDFJSModule, getDocumentProxy, extractText, extractImages } from "unpdf";
import { encode } from "fast-png";
import type { ExtractedImage } from "./docx-images";

// unpdf's built-in pdfjs bundle crashes on Cloudflare Workers.
// Use pdfjs-serverless directly, which is designed for edge runtimes.
let pdfjsReady: Promise<void> | undefined;
function ensurePDFJS(): Promise<void> {
	if (!pdfjsReady) {
		pdfjsReady = definePDFJSModule(() => import("pdfjs-serverless"));
	}
	return pdfjsReady;
}

export interface PageText {
	pageNumber: number;
	text: string;
}

/**
 * Parse a PDF buffer and return text per page with [IMAGE: pageN-key] placeholders + list of image names.
 * Images are appended as placeholders at the end of each page's text (similar to PPTX slides).
 */
export async function parsePdfWithImages(buffer: ArrayBuffer): Promise<{ pages: PageText[]; imageNames: string[] }> {
	await ensurePDFJS();
	const data = new Uint8Array(buffer);
	const pdf = await getDocumentProxy(data);

	try {
		const { totalPages, text: pageTexts } = await extractText(pdf, { mergePages: false });

		const pages: PageText[] = [];
		const allImageNames: string[] = [];

		for (let i = 0; i < totalPages; i++) {
			const pageNumber = i + 1;
			const pageText = pageTexts[i] ?? "";

			// Extract images to discover names/count for placeholders
			const rawImages = await extractImages(pdf, pageNumber);
			const imagePlaceholders: string[] = [];
			for (const img of rawImages) {
				const name = `page${pageNumber}-${img.key}`;
				imagePlaceholders.push(`[IMAGE: ${name}]`);
				allImageNames.push(name);
			}

			const parts = [pageText, ...imagePlaceholders].filter((p) => p.length > 0);
			const combined = parts.join("\n");
			if (combined.trim().length > 0) {
				pages.push({ pageNumber, text: combined });
			}
		}

		return { pages, imageNames: allImageNames };
	} finally {
		pdf.cleanup();
	}
}

/**
 * Extract images from a PDF file, encoding raw pixel data as PNG.
 *
 * @param buffer - The PDF file as an ArrayBuffer
 * @param filterNames - Optional list of image names to extract (e.g. ["page1-Im0"]). If omitted, all images are returned.
 * @returns Array of extracted images with fileName, mimeType, and PNG data
 */
export async function extractPdfImages(buffer: ArrayBuffer, filterNames?: string[]): Promise<ExtractedImage[]> {
	await ensurePDFJS();
	const data = new Uint8Array(buffer);
	const pdf = await getDocumentProxy(data);
	const nameFilter = filterNames ? new Set(filterNames) : null;

	try {
		const totalPages = pdf.numPages;
		const results: ExtractedImage[] = [];

		for (let i = 0; i < totalPages; i++) {
			const pageNumber = i + 1;
			const rawImages = await extractImages(pdf, pageNumber);

			for (const img of rawImages) {
				const fileName = `page${pageNumber}-${img.key}`;

				if (nameFilter && !nameFilter.has(fileName)) continue;

				// Encode raw pixel data to PNG using fast-png
				const pngData = encode({
					width: img.width,
					height: img.height,
					data: img.data,
					channels: img.channels,
				});

				results.push({
					fileName,
					mimeType: "image/png",
					data: pngData,
				});
			}
		}

		return results;
	} finally {
		pdf.cleanup();
	}
}
