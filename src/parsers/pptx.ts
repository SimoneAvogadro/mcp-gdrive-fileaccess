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
