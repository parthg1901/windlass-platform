/**
 * The text of what the build writes for the public pages: each page's HTML around its rendered body,
 * sitemap.xml, robots.txt, llms.txt and llms-full.txt. Pure functions of the page list and the built
 * app's file names, so they can be tested without a build (documents.test.ts).
 *
 * The pages must pass the server's content security policy, which allows no inline script: their
 * scripts are files (theme.js, site.js), and their JSON-LD is a `<script type="application/ld+json">`
 * data block, which browsers never run and so is not checked against script-src.
 */
import { absolute, SITE_NAME, SITE_URL } from "./config";
import { ONE_LINER } from "./content";
import { escapeHtml } from "../docs/render";
import { DEFAULT_IMAGE, type PublicPage } from "./pages";

/** What the build of the app produced that a public page links to. */
export interface AppAssets {
	/** The app's stylesheets, as `href`s. */
	stylesheets: string[];
	/** The app's entry module, as a `src`. */
	entry: string;
	/** Font files worth preloading for the first paint, as `href`s. */
	fonts: string[];
}

/** JSON for inside a `<script>` element: nothing in it can close the element or open a comment. */
export function scriptJson(value: unknown): string {
	return JSON.stringify(value)
		.replace(/</g, "\\u003c")
		.replace(/>/g, "\\u003e")
		.replace(/&/g, "\\u0026")
		.replace(/\u2028/g, "\\u2028")
		.replace(/\u2029/g, "\\u2029");
}

/** The canonical address of a page: the root with its slash, every other path without one. */
export const canonical = (page: Pick<PublicPage, "path">): string =>
	page.path === "/" ? `${SITE_URL}/` : absolute(page.path);

/** The file a page is written to, inside the build's directory. */
export const fileOf = (page: Pick<PublicPage, "path">): string =>
	page.path === "/" ? "index.html" : `${page.path.slice(1)}/index.html`;

export function pageHtml(page: PublicPage, body: string, assets: AppAssets): string {
	const url = canonical(page);
	const image = page.image ?? DEFAULT_IMAGE;
	const meta = (attribute: "name" | "property", key: string, content: string) =>
		`<meta ${attribute}="${key}" content="${escapeHtml(content)}" />`;
	const ld = (page.jsonLd ?? []).map(item => ({ "@context": "https://schema.org", ...item }));
	const head = [
		`<meta charset="UTF-8" />`,
		`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />`,
		`<meta name="color-scheme" content="dark light" />`,
		`<title>${escapeHtml(page.title)}</title>`,
		meta("name", "description", page.description),
		`<link rel="canonical" href="${escapeHtml(url)}" />`,
		meta("name", "robots", "index, follow, max-image-preview:large"),
		meta("property", "og:type", page.ogType ?? "website"),
		meta("property", "og:site_name", SITE_NAME),
		meta("property", "og:locale", "en_US"),
		meta("property", "og:title", page.title),
		meta("property", "og:description", page.description),
		meta("property", "og:url", url),
		meta("property", "og:image", absolute(image.path)),
		meta("property", "og:image:width", String(image.width)),
		meta("property", "og:image:height", String(image.height)),
		meta("property", "og:image:alt", image.alt),
		meta("name", "twitter:card", "summary_large_image"),
		meta("name", "twitter:title", page.title),
		meta("name", "twitter:description", page.description),
		meta("name", "twitter:image", absolute(image.path)),
		meta("name", "twitter:image:alt", image.alt),
		`<meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b0c0e" />`,
		`<meta name="theme-color" media="(prefers-color-scheme: light)" content="#fafaf9" />`,
		`<link rel="icon" href="/favicon.ico" sizes="32x32" />`,
		`<link rel="icon" type="image/svg+xml" href="/mark.svg" />`,
		`<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`,
		`<link rel="manifest" href="/site.webmanifest" />`,
		`<link rel="alternate" type="text/markdown" href="/llms-full.txt" title="${escapeHtml(SITE_NAME)} for language models" />`,
		...assets.fonts.map(
			href => `<link rel="preload" as="font" type="font/woff2" href="${escapeHtml(href)}" crossorigin />`,
		),
		...assets.stylesheets.map(href => `<link rel="stylesheet" crossorigin href="${escapeHtml(href)}" />`),
		...(page.appForSignedIn || page.appForEveryone
			? [`<meta name="wlp-app" content="${escapeHtml(assets.entry)}" />`]
			: []),
		...(page.appForEveryone ? [`<meta name="wlp-app-for" content="everyone" />`] : []),
		`<script src="/theme.js"></script>`,
		`<script src="/site.js"></script>`,
		...ld.map(item => `<script type="application/ld+json">${scriptJson(item)}</script>`),
	];
	return `<!doctype html>\n<html lang="en">\n\t<head>\n\t\t${head.join("\n\t\t")}\n\t</head>\n\t<body>\n\t\t<div id="root" data-public="">${body}</div>\n\t</body>\n</html>\n`;
}

/**
 * The app's shell for every address that is not a public page: the built index.html as it is, kept
 * out of search results (the app's pages are a signed-in person's own).
 */
export function appShellHtml(built: string): string {
	if (built.includes('name="robots"')) return built;
	const tag = '<meta name="robots" content="noindex" />';
	// After the charset, which must come first.
	return /<meta charset[^>]*>/i.test(built)
		? built.replace(/(<meta charset[^>]*>)/i, `$1\n\t\t${tag}`)
		: built.replace(/<head>/i, `<head>\n\t\t${tag}`);
}

export function sitemapXml(pages: PublicPage[]): string {
	const urls = pages.map(
		page =>
			`\t<url>\n\t\t<loc>${escapeHtml(canonical(page))}</loc>${page.lastModified ? `\n\t\t<lastmod>${page.lastModified}</lastmod>` : ""}\n\t</url>`,
	);
	return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export function robotsTxt(): string {
	return [
		"# Search engines and answer engines are welcome on the public pages.",
		"# The app's own pages are a signed-in person's: they say noindex.",
		"User-agent: *",
		"Allow: /",
		"",
		`Sitemap: ${SITE_URL}/sitemap.xml`,
		"",
	].join("\n");
}

/** llms.txt (https://llmstxt.org): what the site is, in a sentence, and a link to each public page by section. */
export function llmsTxt(pages: PublicPage[]): string {
	const sections = new Map<string, PublicPage[]>();
	for (const page of pages) sections.set(page.llms.section, [...(sections.get(page.llms.section) ?? []), page]);
	const lines = [
		`# ${SITE_NAME}`,
		"",
		`> ${ONE_LINER}`,
		"",
		"It runs the Windlass agent, Claude Code, Codex and OpenCode, hosted or on your own machines, with your own API keys. The platform is open source (Apache-2.0) and can be self-hosted; the hosted service signs in invited accounts.",
		"",
	];
	for (const [section, members] of sections) {
		lines.push(`## ${section}`, "");
		for (const page of members) lines.push(`- [${page.title}](${canonical(page)}): ${page.llms.summary}`);
		lines.push("");
	}
	lines.push(
		"## Optional",
		"",
		`- [Every public page as Markdown](${SITE_URL}/llms-full.txt): the full text of the pages above, in one file`,
		"",
	);
	return lines.join("\n");
}

/** llms-full.txt: every public page's Markdown, each under its title and address. */
export function llmsFullTxt(pages: PublicPage[]): string {
	return pages.map(page => `<!-- ${canonical(page)} -->\n${page.markdown().trim()}\n`).join("\n---\n\n");
}
