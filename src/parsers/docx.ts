import { unzipSync } from "fflate";

const XML_ENTITIES: Record<string, string> = {
	"&amp;": "&",
	"&lt;": "<",
	"&gt;": ">",
	"&apos;": "'",
	"&quot;": '"',
};

function decodeXmlEntities(text: string): string {
	return text.replace(/&(?:amp|lt|gt|apos|quot);/g, (m) => XML_ENTITIES[m] ?? m);
}

export function parseDocxToText(buffer: ArrayBuffer): string {
	const data = new Uint8Array(buffer);
	const files = unzipSync(data, {
		filter: (file) => file.name === "word/document.xml",
	});

	const docXml = files["word/document.xml"];
	if (!docXml) {
		throw new Error("Invalid DOCX: word/document.xml not found");
	}

	const xml = new TextDecoder().decode(docXml);

	// Split by paragraphs <w:p>...</w:p>, then extract text runs <w:t>...</w:t>
	const paragraphs: string[] = [];
	const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
	let paraMatch;
	while ((paraMatch = paraRegex.exec(xml)) !== null) {
		const paraXml = paraMatch[0];
		const texts: string[] = [];
		const textRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
		let textMatch;
		while ((textMatch = textRegex.exec(paraXml)) !== null) {
			texts.push(textMatch[1]);
		}
		if (texts.length > 0) {
			paragraphs.push(decodeXmlEntities(texts.join("")));
		}
	}

	return paragraphs.join("\n");
}

/**
 * Parse a DOCX buffer and return text with image placeholders + list of image names.
 * Images appear as `[IMAGE: filename]` in the text, preserving their position relative to text.
 */
export function parseDocxWithImages(buffer: ArrayBuffer): { text: string; imageNames: string[] } {
	const data = new Uint8Array(buffer);
	const files = unzipSync(data, {
		filter: (file) =>
			file.name === "word/document.xml" ||
			file.name === "word/_rels/document.xml.rels",
	});

	const docXml = files["word/document.xml"];
	if (!docXml) {
		throw new Error("Invalid DOCX: word/document.xml not found");
	}

	// Build rId → filename map from relationships
	const rIdToFile = new Map<string, string>();
	const relsXml = files["word/_rels/document.xml.rels"];
	if (relsXml) {
		const relsStr = new TextDecoder().decode(relsXml);
		const relRegex = /<Relationship\s[^>]*\/>/g;
		let relMatch;
		while ((relMatch = relRegex.exec(relsStr)) !== null) {
			const tag = relMatch[0];
			const idMatch = tag.match(/Id="([^"]+)"/);
			const targetMatch = tag.match(/Target="([^"]+)"/);
			if (idMatch && targetMatch) {
				// Target is like "media/image1.png" — extract just the filename
				const target = targetMatch[1];
				const fileName = target.includes("/") ? target.split("/").pop()! : target;
				rIdToFile.set(idMatch[1], fileName);
			}
		}
	}

	const xml = new TextDecoder().decode(docXml);
	const imageNamesSet = new Set<string>();
	const paragraphs: string[] = [];
	const paraRegex = /<w:p[\s>][\s\S]*?<\/w:p>/g;
	let paraMatch;

	while ((paraMatch = paraRegex.exec(xml)) !== null) {
		const paraXml = paraMatch[0];
		const parts: string[] = [];

		// Walk <w:r> runs in order to preserve text/image sequence
		const runRegex = /<w:r[\s>][\s\S]*?<\/w:r>/g;
		let runMatch;
		while ((runMatch = runRegex.exec(paraXml)) !== null) {
			const runXml = runMatch[0];

			// Check for drawing with embedded image reference
			const embedMatch = runXml.match(/r:embed="([^"]+)"/);
			if (embedMatch && /<w:drawing[\s>]/.test(runXml)) {
				const rId = embedMatch[1];
				const fileName = rIdToFile.get(rId);
				if (fileName) {
					parts.push(`[IMAGE: ${fileName}]`);
					imageNamesSet.add(fileName);
				}
			}

			// Extract text from <w:t> elements in this run
			const textRegex = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
			let textMatch;
			while ((textMatch = textRegex.exec(runXml)) !== null) {
				parts.push(textMatch[1]);
			}
		}

		// Also check for drawings outside <w:r> (e.g. directly in <w:p> via <w:drawing>)
		// These are typically floating images wrapped in <mc:AlternateContent> or standalone
		const drawingRegex = /<w:drawing[\s>][\s\S]*?<\/w:drawing>/g;
		const runlessDrawings: string[] = [];
		// Collect drawings that are NOT inside a <w:r>
		const strippedPara = paraXml.replace(/<w:r[\s>][\s\S]*?<\/w:r>/g, "");
		let drawMatch;
		while ((drawMatch = drawingRegex.exec(strippedPara)) !== null) {
			const embedM = drawMatch[0].match(/r:embed="([^"]+)"/);
			if (embedM) {
				const fileName = rIdToFile.get(embedM[1]);
				if (fileName) {
					runlessDrawings.push(`[IMAGE: ${fileName}]`);
					imageNamesSet.add(fileName);
				}
			}
		}
		if (runlessDrawings.length > 0) {
			parts.push(...runlessDrawings);
		}

		if (parts.length > 0) {
			paragraphs.push(decodeXmlEntities(parts.join("")));
		}
	}

	return {
		text: paragraphs.join("\n"),
		imageNames: Array.from(imageNamesSet),
	};
}
