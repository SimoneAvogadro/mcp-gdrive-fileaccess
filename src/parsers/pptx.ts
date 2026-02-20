import { unzipSync } from "fflate";

export interface SlideText {
	slideNumber: number;
	text: string;
}

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

/**
 * Parse a PPTX buffer and return text per slide with [IMAGE: filename] placeholders + list of image names.
 * Images are shape-level objects on each slide, so placeholders are appended after the slide's text.
 */
export function parsePptxWithImages(buffer: ArrayBuffer): {
	slides: SlideText[];
	imageNames: string[];
} {
	const data = new Uint8Array(buffer);
	const slidePattern = /^ppt\/slides\/slide(\d+)\.xml$/;
	const relsPattern = /^ppt\/slides\/_rels\/slide(\d+)\.xml\.rels$/;

	const files = unzipSync(data, {
		filter: (file) => slidePattern.test(file.name) || relsPattern.test(file.name),
	});

	// Discover slide numbers
	const slideNumbers = new Set<number>();
	for (const name of Object.keys(files)) {
		const m = slidePattern.exec(name);
		if (m) slideNumbers.add(parseInt(m[1], 10));
	}
	const sorted = Array.from(slideNumbers).sort((a, b) => a - b);

	const imageNamesSet = new Set<string>();
	const results: SlideText[] = [];

	for (const num of sorted) {
		const slideFile = `ppt/slides/slide${num}.xml`;
		const relsFile = `ppt/slides/_rels/slide${num}.xml.rels`;

		const slideXml = files[slideFile];
		if (!slideXml) continue;

		// Build rId → filename map from this slide's rels
		const rIdToFile = new Map<string, string>();
		const relsXml = files[relsFile];
		if (relsXml) {
			const relsStr = new TextDecoder().decode(relsXml);
			const relRegex = /<Relationship\s[^>]*\/>/g;
			let relMatch;
			while ((relMatch = relRegex.exec(relsStr)) !== null) {
				const tag = relMatch[0];
				const idMatch = tag.match(/Id="([^"]+)"/);
				const targetMatch = tag.match(/Target="([^"]+)"/);
				if (idMatch && targetMatch) {
					// Target is like "../media/image1.png" — extract just the filename
					const target = targetMatch[1];
					const fileName = target.includes("/") ? target.split("/").pop()! : target;
					rIdToFile.set(idMatch[1], fileName);
				}
			}
		}

		const xml = new TextDecoder().decode(slideXml);

		// Extract text paragraphs
		const paragraphs: string[] = [];
		const paraRegex = /<a:p[\s>][\s\S]*?<\/a:p>/g;
		let paraMatch;
		while ((paraMatch = paraRegex.exec(xml)) !== null) {
			const paraXml = paraMatch[0];
			const texts: string[] = [];
			const textRegex = /<a:t>([^<]*)<\/a:t>/g;
			let textMatch;
			while ((textMatch = textRegex.exec(paraXml)) !== null) {
				texts.push(textMatch[1]);
			}
			if (texts.length > 0) {
				paragraphs.push(decodeXmlEntities(texts.join("")));
			}
		}

		// Collect image placeholders from <a:blip r:embed="rIdX">
		const imagePlaceholders: string[] = [];
		const blipRegex = /<a:blip\s[^>]*r:embed="([^"]+)"[^>]*\/?>/g;
		let blipMatch;
		while ((blipMatch = blipRegex.exec(xml)) !== null) {
			const rId = blipMatch[1];
			const fileName = rIdToFile.get(rId);
			if (fileName) {
				imagePlaceholders.push(`[IMAGE: ${fileName}]`);
				imageNamesSet.add(fileName);
			}
		}

		// Combine: text paragraphs + image placeholders appended at the end
		const allParts = [...paragraphs, ...imagePlaceholders];
		const text = allParts.join("\n");
		if (text.trim().length > 0) {
			results.push({ slideNumber: num, text });
		}
	}

	return {
		slides: results,
		imageNames: Array.from(imageNamesSet),
	};
}

export function parsePptxToText(buffer: ArrayBuffer): SlideText[] {
	const data = new Uint8Array(buffer);
	const slidePattern = /^ppt\/slides\/slide(\d+)\.xml$/;

	const files = unzipSync(data, {
		filter: (file) => slidePattern.test(file.name),
	});

	const slides: { number: number; name: string }[] = [];
	for (const name of Object.keys(files)) {
		const match = slidePattern.exec(name);
		if (match) {
			slides.push({ number: parseInt(match[1], 10), name });
		}
	}

	// Sort by slide number (not lexicographic)
	slides.sort((a, b) => a.number - b.number);

	const results: SlideText[] = [];
	for (const slide of slides) {
		const xml = new TextDecoder().decode(files[slide.name]);

		// Split by paragraphs <a:p>...</a:p>, then extract text runs <a:t>...</a:t>
		const paragraphs: string[] = [];
		const paraRegex = /<a:p[\s>][\s\S]*?<\/a:p>/g;
		let paraMatch;
		while ((paraMatch = paraRegex.exec(xml)) !== null) {
			const paraXml = paraMatch[0];
			const texts: string[] = [];
			const textRegex = /<a:t>([^<]*)<\/a:t>/g;
			let textMatch;
			while ((textMatch = textRegex.exec(paraXml)) !== null) {
				texts.push(textMatch[1]);
			}
			if (texts.length > 0) {
				paragraphs.push(decodeXmlEntities(texts.join("")));
			}
		}

		const text = paragraphs.join("\n");
		if (text.trim().length > 0) {
			results.push({ slideNumber: slide.number, text });
		}
	}

	return results;
}
