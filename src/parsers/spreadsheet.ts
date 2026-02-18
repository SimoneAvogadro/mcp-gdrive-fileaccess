import * as XLSX from "xlsx";

export interface SheetCSV {
	sheetName: string;
	csv: string;
}

export function parseSpreadsheetToCSV(buffer: ArrayBuffer): SheetCSV[] {
	const workbook = XLSX.read(new Uint8Array(buffer), { type: "array" });
	const results: SheetCSV[] = [];

	for (const sheetName of workbook.SheetNames) {
		const sheet = workbook.Sheets[sheetName];
		const csv = XLSX.utils.sheet_to_csv(sheet);
		if (csv.trim().length === 0) continue;
		results.push({ sheetName, csv });
	}

	return results;
}
