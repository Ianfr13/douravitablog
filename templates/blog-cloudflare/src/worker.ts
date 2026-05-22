import handler from "@astrojs/cloudflare/entrypoints/server";

export { PluginBridge } from "@emdash-cms/cloudflare/sandbox";

// Edge cache via Cloudflare Workers Cache API (caches.default).
// Por que aqui (worker.ts) e nao em src/middleware.ts:
// - Cloudflare Cache Rules no painel exigem acesso ao dashboard (Ian nao tem).
// - Cache Rules via API estavam retornando "internal server error" generico.
// - caches.default no Worker e a API mais low-level e funciona sem
//   configuracao extra. Ele JA respeita Cache-Control:s-maxage do response.
//
// Estrategia:
// 1. Filtra GET em paths whitelisted (posts, tag, category, pages, home/blog).
// 2. Normaliza cache key strippando tracking params (utm_*, fbclid, gclid, etc).
// 3. cache.match -> se HIT, devolve com x-edge-cache:HIT.
// 4. Se MISS, render via handler do Astro, e cache.put em background (waitUntil).
//    Cache-Control:s-maxage=60 e setado pelo template Astro; defesa em
//    profundidade aqui caso algum route esqueca de setar.
//
// Invalidacao: TTL natural de 60s (mudanca em post aparece em <=60s).
// stale-while-revalidate=86400 faz CF servir stale por 24h enquanto revalida
// em background — usuario nunca espera o render lento (~2s, 15 queries no D1).

const CACHEABLE_HTML_PATTERNS = [
	/^\/$/,
	/^\/blog\/?$/,
	/^\/posts(\/|$)/,
	/^\/tag\//,
	/^\/category\//,
	/^\/pages\//,
];

// Media servida pelo EmDash worker — JA traz Cache-Control: max-age=31536000
// immutable no upstream, mas CF CDN nao cacheia Workers output sem caches.default.
// Sem cache de edge, cada visita re-renderiza (220ms render + R2 fetch).
// Cachear aqui evita esse roundtrip pra arquivos com URL imutavel (storageKey
// e content-addressed: muda quando o conteudo muda).
const CACHEABLE_MEDIA_PATTERNS = [
	/^\/_emdash\/api\/media\/file\//,
];

const TRACKING_PARAMS = [
	"fbclid",
	"gclid",
	"ttclid",
	"tbclid",
	"utm_source",
	"utm_medium",
	"utm_campaign",
	"utm_content",
	"utm_term",
	"ref",
];

const DEFAULT_CACHE_CONTROL =
	"public, s-maxage=60, stale-while-revalidate=86400";

type CacheKind = "html" | "media" | null;

function classifyCacheable(request: Request): CacheKind {
	if (request.method !== "GET") return null;
	const url = new URL(request.url);
	if (CACHEABLE_HTML_PATTERNS.some((re) => re.test(url.pathname))) return "html";
	if (CACHEABLE_MEDIA_PATTERNS.some((re) => re.test(url.pathname))) return "media";
	return null;
}

function makeCacheKey(request: Request): Request {
	const url = new URL(request.url);
	for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
	url.searchParams.sort();
	return new Request(url.toString(), { method: "GET" });
}

export default {
	async fetch(
		request: Request,
		env: unknown,
		ctx: ExecutionContext,
	): Promise<Response> {
		const kind = classifyCacheable(request);
		if (!kind) {
			// @ts-expect-error handler default export shape from @astrojs/cloudflare
			return handler.fetch(request, env, ctx);
		}

		const cache = caches.default;
		// Media tem URL imutavel (storageKey content-addressed) entao nao precisa
		// stripar tracking params; pra HTML, normaliza pra evitar fragmentacao
		// por marketing.
		const cacheKey = kind === "html" ? makeCacheKey(request) : request;

		const cached = await cache.match(cacheKey);
		if (cached) {
			const r = new Response(cached.body, cached);
			r.headers.set("x-edge-cache", "HIT");
			return r;
		}

		// @ts-expect-error handler default export shape from @astrojs/cloudflare
		const response: Response = await handler.fetch(request, env, ctx);

		if (
			response.status !== 200 ||
			response.headers.has("set-cookie") ||
			response.headers.get("cache-control")?.includes("no-store")
		) {
			return response;
		}

		const headers = new Headers(response.headers);
		// Pra HTML: garante s-maxage=60 (curto, conteudo muda quando aprova post).
		// Pra media: preserva o Cache-Control upstream (EmDash ja manda
		// max-age=31536000 immutable nas imagens — storageKey é content-addressed).
		if (kind === "html") {
			const existingCC = headers.get("cache-control") || "";
			if (!existingCC.includes("s-maxage")) {
				headers.set("Cache-Control", DEFAULT_CACHE_CONTROL);
			}
		}

		const responseToCache = new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
		const responseToUser = responseToCache.clone();
		responseToUser.headers.set("x-edge-cache", "MISS");

		ctx.waitUntil(cache.put(cacheKey, responseToCache));
		return responseToUser;
	},
};
