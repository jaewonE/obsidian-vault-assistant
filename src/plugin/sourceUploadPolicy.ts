export const NOTEBOOKLM_ALLOWED_UPLOAD_EXTENSIONS = new Set([
	"pdf",
	"txt",
	"md",
	"docx",
	"csv",
	"avif",
	"bmp",
	"gif",
	"ico",
	"jp2",
	"png",
	"webp",
	"tif",
	"tiff",
	"heic",
	"heif",
	"jpeg",
	"jpg",
	"jpe",
	"3g2",
	"3gp",
	"aac",
	"aif",
	"aifc",
	"aiff",
	"amr",
	"au",
	"avi",
	"cda",
	"m4a",
	"mid",
	"mp3",
	"mp4",
	"mpeg",
	"ogg",
	"opus",
	"ra",
	"ram",
	"snd",
	"wav",
	"wma",
]);

const TEXT_UPLOAD_EXTENSIONS = new Set(["md", "txt"]);

export type SourceUploadMethod = "text" | "file";

export interface SourceUploadPart {
	sourceType: SourceUploadMethod;
	title: string;
	text?: string;
	filePath?: string;
}

export interface SourceUploadPlan {
	path: string;
	extension: string;
	method: SourceUploadMethod;
	contentHash: string;
	parts: SourceUploadPart[];
}

export interface FilterAllowedUploadPathsResult {
	allowedPaths: string[];
	ignoredCount: number;
	ignoredExtensions: string[];
}

export function getFileExtension(path: string): string {
	const normalizedPath = typeof path === "string" ? path.trim() : "";
	if (!normalizedPath) {
		return "";
	}

	const lastDotIndex = normalizedPath.lastIndexOf(".");
	if (lastDotIndex <= 0 || lastDotIndex >= normalizedPath.length - 1) {
		return "";
	}

	return normalizedPath.slice(lastDotIndex + 1).toLocaleLowerCase();
}

export function getUploadMethodForPath(path: string): SourceUploadMethod | null {
	const extension = getFileExtension(path);
	if (!extension || !NOTEBOOKLM_ALLOWED_UPLOAD_EXTENSIONS.has(extension)) {
		return null;
	}
	if (TEXT_UPLOAD_EXTENSIONS.has(extension)) {
		return "text";
	}
	return "file";
}

export function buildTextUploadPlan(params: {
	path: string;
	text: string;
	contentHash: string;
}): SourceUploadPlan {
	const { path, text, contentHash } = params;
	return {
		path,
		extension: getFileExtension(path),
		method: "text",
		contentHash,
		parts: [
			{
				sourceType: "text",
				title: path,
				text,
			},
		],
	};
}

export function buildFileUploadPlan(params: {
	path: string;
	filePath: string;
	contentHash: string;
}): SourceUploadPlan {
	const { path, filePath, contentHash } = params;
	return {
		path,
		extension: getFileExtension(path),
		method: "file",
		contentHash,
		parts: [
			{
				sourceType: "file",
				title: path,
				filePath,
			},
		],
	};
}

export function filterAllowedUploadPaths(paths: string[]): FilterAllowedUploadPathsResult {
	const allowedPaths: string[] = [];
	const seenAllowed = new Set<string>();
	const ignoredExtensions = new Set<string>();
	let ignoredCount = 0;

	for (const path of paths) {
		if (getUploadMethodForPath(path)) {
			if (!seenAllowed.has(path)) {
				seenAllowed.add(path);
				allowedPaths.push(path);
			}
			continue;
		}

		ignoredCount += 1;
		const extension = getFileExtension(path);
		ignoredExtensions.add(extension || "(no-extension)");
	}

	return {
		allowedPaths,
		ignoredCount,
		ignoredExtensions: [...ignoredExtensions].sort((left, right) => left.localeCompare(right)),
	};
}
