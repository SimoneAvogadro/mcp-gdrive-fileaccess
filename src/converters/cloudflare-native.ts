/**
 * Convert files using Cloudflare AI's toMarkdown() API.
 * Supports DOCX, XLSX, PDF, HTML, CSV, XML, ODS, ODT and more.
 */
export async function convertWithCloudflareAI(
	env: Env,
	fileName: string,
	buffer: ArrayBuffer,
	mimeType: string,
): Promise<string> {
	const blob = new Blob([buffer], { type: mimeType });

	const results = await (env.AI as any).toMarkdown([{ name: fileName, blob }]);

	if (!results || results.length === 0) {
		throw new Error("AI.toMarkdown returned no results");
	}

	const result = results[0];
	if (result.format === "error") {
		throw new Error(`AI.toMarkdown error: ${result.data || "unknown error"}`);
	}

	return result.data as string;
}
