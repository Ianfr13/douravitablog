import type { APIRoute } from "astro";
import { getEmDashCollection } from "emdash";

/**
 * Sitemap dinâmico do blog Douravita.
 *
 * Inclui: home /blog, cada post publicado, cada página institucional
 * publicada. Fora: /blog/posts (301 -> /blog, não canônica) e o RSS
 * (/blog/rss.xml) — sitemap aponta pra HTML canônico, não pra feed/redirect.
 *
 * Cache: 1 hora (curto pra novos posts entrarem rápido na indexação).
 * Google/Bing/Yandex re-fetcham na próxima visita.
 */
export const GET: APIRoute = async ({ site, url }) => {
	const siteUrl = (site?.toString() || url.origin).replace(/\/$/, "");

	const { entries: posts } = await getEmDashCollection("posts", {
		orderBy: { published_at: "desc" },
		limit: 500,
	});
	const { entries: pages } = await getEmDashCollection("pages", {
		limit: 100,
	});

	const todayIso = new Date().toISOString().slice(0, 10);

	const entries: string[] = [];

	// Home do blog (alta prioridade, atualização diária).
	// /blog/posts NÃO entra: redireciona 301 -> /blog, então listá-la geraria
	// URL não canônica no sitemap (duplica title/meta de /blog e gasta crawl budget).
	entries.push(urlEntry(`${siteUrl}/blog`, todayIso, "daily", 1.0));

	for (const post of posts) {
		const slug = post.data.slug || post.id;
		if (!slug) continue;
		const lastmod = lastModIso(post);
		entries.push(
			urlEntry(`${siteUrl}/blog/posts/${slug}`, lastmod, "weekly", 0.7),
		);
	}

	for (const page of pages) {
		const slug = page.data.slug || page.id;
		if (!slug) continue;
		const lastmod = lastModIso(page);
		entries.push(
			urlEntry(`${siteUrl}/blog/pages/${slug}`, lastmod, "monthly", 0.5),
		);
	}

	const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>`;

	return new Response(xml, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};

function urlEntry(
	loc: string,
	lastmod: string,
	changefreq: string,
	priority: number,
): string {
	return `  <url>
    <loc>${escapeXml(loc)}</loc>
    <lastmod>${lastmod}</lastmod>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority.toFixed(1)}</priority>
  </url>`;
}

function lastModIso(entry: { data: Record<string, unknown> }): string {
	const updated = entry.data.updatedAt as Date | string | undefined;
	const published = entry.data.publishedAt as Date | string | undefined;
	const value = updated || published;
	if (!value) return new Date().toISOString().slice(0, 10);
	if (value instanceof Date) return value.toISOString().slice(0, 10);
	return String(value).slice(0, 10);
}

const XML_ESCAPE_PATTERNS = [
	[/&/g, "&amp;"],
	[/</g, "&lt;"],
	[/>/g, "&gt;"],
	[/"/g, "&quot;"],
	[/'/g, "&apos;"],
] as const;

function escapeXml(str: string): string {
	let result = str;
	for (const [pattern, replacement] of XML_ESCAPE_PATTERNS) {
		result = result.replace(pattern, replacement);
	}
	return result;
}
