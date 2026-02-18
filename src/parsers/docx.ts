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
