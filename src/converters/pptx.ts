/**
 * PPTX → Markdown converter using JSZip + fast-xml-parser.
 * Extracts text from slides and notes.
 */
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	isArray: (name) => {
		// These elements can appear multiple times
		return [
			"p:sldId", "Relationship",
			"p:sp", "p:grpSp",
			"a:p", "a:r", "a:t",
			"p:cSld", "p:txBody",
		].includes(name);
	},
});

interface SlideIdEntry {
	"@_id": string;
	"@_r:id": string;
}

interface Relationship {
	"@_Id": string;
	"@_Target": string;
	"@_Type": string;
}

export async function convertPptxToMarkdown(
	fileName: string,
	buffer: ArrayBuffer,
): Promise<string> {
	const zip = await JSZip.loadAsync(buffer);

	// Read presentation.xml for slide order
	const presXml = await zip.file("ppt/presentation.xml")?.async("text");
	if (!presXml) {
		throw new Error("Invalid PPTX: missing ppt/presentation.xml");
	}
	const pres = parser.parse(presXml);

	// Get slide IDs in order
	const slideIdList = pres?.["p:presentation"]?.["p:sldIdLst"]?.["p:sldId"];
	if (!slideIdList) {
		return `# ${fileName}\n\n*No slides found.*`;
	}
	const slideIds: SlideIdEntry[] = Array.isArray(slideIdList) ? slideIdList : [slideIdList];

	// Read relationships to map rId → slide file
	const relsXml = await zip.file("ppt/_rels/presentation.xml.rels")?.async("text");
	if (!relsXml) {
		throw new Error("Invalid PPTX: missing presentation relationships");
	}
	const rels = parser.parse(relsXml);
	const relationships: Relationship[] = Array.isArray(rels?.Relationships?.Relationship)
		? rels.Relationships.Relationship
		: [rels?.Relationships?.Relationship].filter(Boolean);

	const relMap = new Map<string, string>();
	for (const rel of relationships) {
		relMap.set(rel["@_Id"], rel["@_Target"]);
	}

	const output: string[] = [`# ${fileName}`];

	for (let i = 0; i < slideIds.length; i++) {
		const rId = slideIds[i]["@_r:id"];
		const target = relMap.get(rId);
		if (!target) continue;

		// Normalize path
		const slidePath = target.startsWith("/") ? target.slice(1) : `ppt/${target}`;

		output.push(`\n## Slide ${i + 1}`);

		// Extract slide text
		const slideXml = await zip.file(slidePath)?.async("text");
		if (slideXml) {
			const slideText = extractTextFromSlide(slideXml);
			if (slideText) {
				output.push(slideText);
			}
		}

		// Extract notes if present
		const slideNum = slidePath.match(/slide(\d+)\.xml/)?.[1];
		if (slideNum) {
			const notesPath = `ppt/notesSlides/notesSlide${slideNum}.xml`;
			const notesXml = await zip.file(notesPath)?.async("text");
			if (notesXml) {
				const notesText = extractTextFromSlide(notesXml);
				if (notesText) {
					output.push(`\n**Notes:**\n${notesText}`);
				}
			}
		}
	}

	return output.join("\n");
}

function extractTextFromSlide(xml: string): string {
	const parsed = parser.parse(xml);

	// Navigate to shape tree — works for both slides and notes
	const root = parsed["p:sld"] || parsed["p:notes"];
	if (!root) return "";

	const spTree = root["p:cSld"]?.["p:spTree"];
	if (!spTree) return "";

	const lines: string[] = [];
	extractShapeText(spTree, lines);

	return lines.join("\n");
}

function extractShapeText(node: any, lines: string[]): void {
	if (!node || typeof node !== "object") return;

	// Process shapes (p:sp)
	const shapes = node["p:sp"];
	if (shapes) {
		const shapeArr = Array.isArray(shapes) ? shapes : [shapes];
		for (const shape of shapeArr) {
			const txBody = shape["p:txBody"];
			if (txBody) {
				extractParagraphs(txBody, lines);
			}
		}
	}

	// Process group shapes (p:grpSp) recursively
	const groups = node["p:grpSp"];
	if (groups) {
		const groupArr = Array.isArray(groups) ? groups : [groups];
		for (const group of groupArr) {
			extractShapeText(group, lines);
		}
	}
}

function extractParagraphs(txBody: any, lines: string[]): void {
	const paragraphs = txBody["a:p"];
	if (!paragraphs) return;

	const paraArr = Array.isArray(paragraphs) ? paragraphs : [paragraphs];

	for (const para of paraArr) {
		const text = extractRunText(para);
		if (!text.trim()) continue;

		// Check for bullet points
		const pPr = para["a:pPr"];
		const level = pPr?.["@_lvl"] ? Number(pPr["@_lvl"]) : 0;
		const indent = "  ".repeat(level);

		const hasBullet = pPr?.["a:buChar"] || pPr?.["a:buAutoNum"];
		const isBullet = hasBullet || (pPr && pPr["a:buNone"] === undefined && level > 0);

		if (isBullet) {
			lines.push(`${indent}- ${text.trim()}`);
		} else {
			lines.push(text.trim());
		}
	}
}

function extractRunText(para: any): string {
	const runs = para["a:r"];
	if (!runs) {
		// Check for field text (a:fld)
		const fld = para["a:fld"];
		if (fld) {
			const fldArr = Array.isArray(fld) ? fld : [fld];
			return fldArr.map((f: any) => getTextContent(f["a:t"])).join("");
		}
		return "";
	}

	const runArr = Array.isArray(runs) ? runs : [runs];
	return runArr.map((run: any) => getTextContent(run["a:t"])).join("");
}

function getTextContent(t: any): string {
	if (t === undefined || t === null) return "";
	if (typeof t === "string") return t;
	if (typeof t === "number") return String(t);
	// fast-xml-parser may wrap text in an object with #text
	if (t["#text"] !== undefined) return String(t["#text"]);
	return "";
}
