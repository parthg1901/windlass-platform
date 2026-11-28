/** The rules every public page is held to, and what the build writes for them (documents.ts). */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SITE_URL } from "./config";
import { FAQ } from "./content";
import {
	appShellHtml,
	canonical,
	fileOf,
	llmsFullTxt,
	llmsTxt,
	pageHtml,
	robotsTxt,
	scriptJson,
	sitemapXml,
} from "./documents";
import { PUBLIC_PAGES } from "./pages";
import { renderSite } from "./render";

const ASSETS = {
	stylesheets: ["/assets/index-abc.css"],
	entry: "/assets/index-abc.js",
	fonts: ["/assets/geist-latin-wght-normal-abc.woff2"],
};
const BUILT =
	'<!doctype html>\n<html lang="en">\n\t<head>\n\t\t<meta charset="UTF-8" />\n\t\t<title>Windlass</title>\n\t\t<script type="module" crossorigin src="/assets/index-abc.js"></script>\n\t</head>\n\t<body><div id="root"></div></body>\n</html>\n';

describe.each(PUBLIC_PAGES.map(page => [page.path, page] as const))("the public page %s", (_path, page) => {
	const body = renderToStaticMarkup(page.render());
	const html = pageHtml(page, body, ASSETS);

	it("has a title and a description of a length search results show whole", () => {
		expect(page.title.length).toBeGreaterThan(10);
		expect(page.title.length).toBeLessThanOrEqual(70);
		expect(page.description.length).toBeGreaterThan(50);
		expect(page.description.length).toBeLessThanOrEqual(160);
	});

	it("renders without a browser, with one h1 and a main landmark", () => {
		expect(body.match(/<h1[\s>]/g)).toHaveLength(1);
		expect(body).toContain("<main");
	});

	it("has its canonical address, Open Graph and Twitter tags", () => {
		expect(html).toContain(`<link rel="canonical" href="${canonical(page)}" />`);
		for (const tag of [
			'property="og:title"',
			'property="og:description"',
			'property="og:image"',
			'property="og:url"',
			'name="twitter:card" content="summary_large_image"',
			'name="description"',
		]) {
			expect(html).toContain(tag);
		}
		expect(canonical(page).startsWith(SITE_URL)).toBe(true);
	});

	it("runs no inline script: scripts are files, and JSON-LD is a data block that parses", () => {
		for (const [, attributes, content] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
			if (/type="application\/ld\+json"/.test(attributes ?? "")) {
				const data = JSON.parse(content ?? "");
				expect(data["@context"]).toBe("https://schema.org");
			} else {
				expect(attributes).toMatch(/\bsrc="\/[^"]+"/);
				expect(content).toBe("");
			}
		}
		expect(body).not.toMatch(/<script\b/);
		expect(body).not.toMatch(/\son[a-z]+="/);
	});

	it("is written to a file of its own, and has Markdown for llms-full.txt", () => {
		expect(fileOf(page)).toMatch(/(^|\/)index\.html$/);
		expect(page.markdown().trim().length).toBeGreaterThan(100);
	});
});

describe("the landing page", () => {
	const landing = PUBLIC_PAGES.find(page => page.path === "/");
	if (!landing) throw new Error("no landing page");
	const body = renderToStaticMarkup(landing.render());

	it("answers in its FAQPage JSON-LD what it shows on the page", () => {
		const faq = landing.jsonLd?.find(item => (item as { "@type"?: string })["@type"] === "FAQPage") as
			| { mainEntity: { name: string; acceptedAnswer: { text: string } }[] }
			| undefined;
		expect(faq?.mainEntity.map(entry => entry.name)).toEqual(FAQ.map(item => item.question));
		const text = body
			.replace(/&#x27;|&#39;/g, "'")
			.replace(/&quot;/g, '"')
			.replace(/&amp;/g, "&");
		for (const item of FAQ) {
			expect(text).toContain(item.question);
			expect(text).toContain(item.answer);
		}
	});

	it("keeps sign-in reachable and promises no dates or numbers of users", () => {
		expect(body).toContain('href="/signin"');
		// The words people read: an agent's logo is drawn with numbers of its own, which are no promise.
		expect(body.replace(/<svg\b[\s\S]*?<\/svg>/g, "")).not.toMatch(
			// Prices are the billing plans' own (content.ts PLANS, from server/src/billing/plans.ts).
			/coming (soon|in)|20\d\d|customers|trusted by/i,
		);
	});

	it("names the app's entry for a signed-in visitor, and only there", () => {
		expect(pageHtml(landing, body, ASSETS)).toContain('<meta name="wlp-app" content="/assets/index-abc.js" />');
		expect(pageHtml(landing, body, ASSETS)).not.toContain("wlp-app-for");
		for (const page of PUBLIC_PAGES.filter(other => !other.appForSignedIn && !other.appForEveryone)) {
			expect(pageHtml(page, "", ASSETS)).not.toContain("wlp-app");
		}
	});

	it("loads the app for every visitor of a docs page, so its search and menu work", () => {
		const docs = PUBLIC_PAGES.filter(page => page.path.startsWith("/docs"));
		expect(docs.length).toBeGreaterThan(5);
		for (const page of docs) {
			const html = pageHtml(page, "", ASSETS);
			expect(html).toContain('<meta name="wlp-app" content="/assets/index-abc.js" />');
			expect(html).toContain('<meta name="wlp-app-for" content="everyone" />');
		}
	});
});

describe("the site's files", () => {
	it("keep the app's shell out of search results", () => {
		const shell = appShellHtml(BUILT);
		expect(shell).toContain('<meta charset="UTF-8" />\n\t\t<meta name="robots" content="noindex" />');
		expect(appShellHtml(shell)).toBe(shell);
	});

	it("list every public page in the sitemap and in llms.txt", () => {
		const sitemap = sitemapXml(PUBLIC_PAGES);
		const llms = llmsTxt(PUBLIC_PAGES);
		const full = llmsFullTxt(PUBLIC_PAGES);
		for (const page of PUBLIC_PAGES) {
			expect(sitemap).toContain(`<loc>${canonical(page)}</loc>`);
			expect(llms).toContain(`](${canonical(page)})`);
			expect(full).toContain(`<!-- ${canonical(page)} -->`);
		}
		expect(llms.startsWith("# Windlass\n\n> ")).toBe(true);
		expect(robotsTxt()).toContain(`Sitemap: ${SITE_URL}/sitemap.xml`);
	});

	it("write the shell, every page and the site's text files", () => {
		const files = renderSite(ASSETS, BUILT).map(entry => entry.file);
		expect(files).toEqual([
			"app.html",
			...PUBLIC_PAGES.map(fileOf),
			"sitemap.xml",
			"robots.txt",
			"llms.txt",
			"llms-full.txt",
		]);
	});

	it("put JSON in a script element that nothing in it can close", () => {
		const text = scriptJson({ answer: "</script><script>alert(1)</script> <!-- & \u2028" });
		expect(text).not.toMatch(/[<>&\u2028]/);
		expect(JSON.parse(text).answer).toBe("</script><script>alert(1)</script> <!-- & \u2028");
	});
});
