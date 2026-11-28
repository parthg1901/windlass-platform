/** GitLab's database IDs are positive signed 64-bit integers. Never round a numeric ID. */
export function decimalId(value: unknown): string | null {
	if (typeof value === "number" && Number.isSafeInteger(value)) value = String(value);
	return typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
		? value
		: null;
}

/** Use the JSON token, not the possibly rounded Number produced by JSON.parse. */
export function parseGitlabJson(raw: string): unknown {
	return JSON.parse(raw, (key: string, value: unknown, context?: { source?: string }) => {
		if ((key === "id" || key === "iid" || key.endsWith("_id") || key.endsWith("_iid")) && typeof value === "number") {
			return decimalId(context?.source);
		}
		return value;
	});
}

export function gitlabId(value: unknown): number | string | null {
	const id = decimalId(value);
	if (!id) return null;
	return Number.isSafeInteger(Number(id)) ? Number(id) : id;
}
