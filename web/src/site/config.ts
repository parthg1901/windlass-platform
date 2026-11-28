/**
 * What the public pages need to know about where they are published. Read at build time: the prerender
 * (web/site-build.ts) writes these into the pages' HTML, sitemap.xml, robots.txt and llms.txt.
 *
 *   VITE_WLP_SITE_URL     the public origin the pages are canonical at (no trailing slash).
 *                         Defaults to the platform's own address.
 *   VITE_WLP_ACCESS_URL   where "Request access" leads (a form or a mailto: link). Unset, the pages
 *                         offer "Sign in" alone and say that access is by invitation.
 */

export const SITE_NAME = "Windlass";

export const SITE_URL: string = (import.meta.env.VITE_WLP_SITE_URL || "https://usewindlass.com").replace(/\/+$/, "");

export const ACCESS_URL: string | null = import.meta.env.VITE_WLP_ACCESS_URL || null;

/** An absolute address on the site, for canonical links, Open Graph and the sitemap. */
export function absolute(path: string): string {
	return SITE_URL + (path.startsWith("/") ? path : `/${path}`);
}
