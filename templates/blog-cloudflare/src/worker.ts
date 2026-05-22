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

const CACHEABLE_PATTERNS = [
	/^\/$/,
	/^\/blog\/?$/,
	/^\/posts(\/|$)/,
	/^\/tag\//,
	/^\/category\//,
	/^\/pages\//,
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

function isCacheable(request: Request): boolean {
	if (request.method !== "GET") return false;
	const url = new URL(request.url);
	return CACHEABLE_PATTERNS.some((re) => re.test(url.pathname));
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
		if (!isCacheable(request)) {
			// @ts-expect-error handler default export shape from @astrojs/cloudflare
			return handler.fetch(request, env, ctx);
		}

		const cache = caches.default;
		const cacheKey = makeCacheKey(request);

		const cached = await cache.match(cacheKey);
		if (cached) {
			const r = new Response(cached.body, cached);
			r.headers.set("x-edge-cache", "HIT");
			return r;
		}

		// @ts-expect-error handler default export shape from @astrojs/cloudflare
		const response: Response = await handler.fetch(request, env, ctx);

		// So cacheia 200 OK sem set-cookie (set-cookie indica resposta personalizada).
		if (
			response.status !== 200 ||
			response.headers.has("set-cookie") ||
			response.headers.get("cache-control")?.includes("no-store")
		) {
			return response;
		}

		const headers = new Headers(response.headers);
		const existingCC = headers.get("cache-control") || "";
		if (!existingCC.includes("s-maxage")) {
			headers.set("Cache-Control", DEFAULT_CACHE_CONTROL);
		}

		// Cria 2 copias da resposta: uma vai pro cache, outra pro usuario.
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
