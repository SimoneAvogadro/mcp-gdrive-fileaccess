declare module "mammoth" {
	interface ConvertResult {
		value: string;
		messages: Array<{ message: string; type: string }>;
	}
	function convertToMarkdown(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>;
	function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>;
	function extractRawText(input: { arrayBuffer: ArrayBuffer }): Promise<ConvertResult>;
	export { convertToMarkdown, convertToHtml, extractRawText };
}
