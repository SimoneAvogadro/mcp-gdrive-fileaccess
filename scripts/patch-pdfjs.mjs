/**
 * Postinstall patch for unpdf's pdfjs.mjs bundle.
 *
 * Works around an esbuild bug (esbuild#2800, workers-sdk#8014):
 * Wrangler's --supported:class-static-blocks=false causes `this` inside
 * static {} blocks to become `undefined` when the class also has static
 * private fields. Two classes in pdfjs.mjs hit this:
 *
 *   1. WorkerMessageHandler — calls this.initializeFromPort(self)
 *   2. PDFWorker — assigns this._isSameOrigin, this._createCDNWrapper, this.fromPort
 *
 * Neither block is needed for text/image extraction. This script empties them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const filePath = resolve(__dirname, "../node_modules/unpdf/dist/pdfjs.mjs");

let src;
try {
	src = readFileSync(filePath, "utf8");
} catch (err) {
	console.log("[patch-pdfjs] unpdf/dist/pdfjs.mjs not found, skipping.");
	process.exit(0);
}

let patched = 0;

// --- Patch 1: WorkerMessageHandler static block ---
// Pattern: static{"undefined"==typeof window&&...initializeFromPort(self)}
const wmhMarker = "initializeFromPort(self)";
const wmhIdx = src.indexOf(wmhMarker);
if (wmhIdx !== -1) {
	const staticStart = src.lastIndexOf("static{", wmhIdx);
	if (staticStart !== -1) {
		const blockEnd = findClosingBrace(src, staticStart + 6); // after "static"
		if (blockEnd !== -1) {
			const original = src.substring(staticStart, blockEnd + 1);
			src = src.substring(0, staticStart) + "static{}" + src.substring(blockEnd + 1);
			patched++;
			console.log(`[patch-pdfjs] Patched WorkerMessageHandler static block (${original.length} chars -> 8)`);
		}
	}
}

// --- Patch 2: PDFWorker static block ---
// Pattern: static{Fl&&(...),this._isSameOrigin=...,this._createCDNWrapper=...,this.fromPort=...}
const pwMarker = "this._isSameOrigin=";
const pwIdx = src.indexOf(pwMarker);
if (pwIdx !== -1) {
	const staticStart = src.lastIndexOf("static{", pwIdx);
	if (staticStart !== -1) {
		const blockEnd = findClosingBrace(src, staticStart + 6);
		if (blockEnd !== -1) {
			const original = src.substring(staticStart, blockEnd + 1);
			src = src.substring(0, staticStart) + "static{}" + src.substring(blockEnd + 1);
			patched++;
			console.log(`[patch-pdfjs] Patched PDFWorker static block (${original.length} chars -> 8)`);
		}
	}
}

if (patched > 0) {
	writeFileSync(filePath, src, "utf8");
	console.log(`[patch-pdfjs] Done — ${patched} static block(s) neutralized.`);
} else {
	console.log("[patch-pdfjs] No matching static blocks found (already patched or upstream fixed).");
}

/**
 * Starting at position `start` in `str`, expect '{' and count braces
 * to find the matching '}'. Returns the index of the closing brace, or -1.
 */
function findClosingBrace(str, start) {
	let depth = 0;
	for (let i = start; i < str.length; i++) {
		if (str[i] === "{") depth++;
		if (str[i] === "}") depth--;
		if (depth === 0) return i;
	}
	return -1;
}
