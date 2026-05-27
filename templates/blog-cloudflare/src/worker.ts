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
	/^\/blog\/posts(\/|$)/,
	/^\/blog\/tag\//,
	/^\/blog\/category\//,
	/^\/blog\/pages\//,
	/^\/blog\/categorias\/?$/,
	/^\/blog\/sitemap\.xml$/,
	/^\/blog\/rss\.xml$/,
	/^\/posts(\/|$)/,
	/^\/tag\//,
	/^\/category\//,
	/^\/pages\//,
	// Feeds/sitemap: sem isso, Google desiste no fetch do GSC (1.5s render +
	// timeout curto). Cron warmup ja puxa sitemap.xml a cada 1min — entrar
	// aqui faz esse fetch popular o cache, e GSC/bots subsequentes pegam HIT.
	/^\/sitemap\.xml$/,
	/^\/rss\.xml$/,
];

// Media servida pelo EmDash worker — JA traz Cache-Control: max-age=31536000
// immutable no upstream, mas CF CDN nao cacheia Workers output sem caches.default.
// Sem cache de edge, cada visita re-renderiza (220ms render + R2 fetch).
// Cachear aqui evita esse roundtrip pra arquivos com URL imutavel (storageKey
// e content-addressed: muda quando o conteudo muda).
const CACHEABLE_MEDIA_PATTERNS = [
	/^\/_emdash\/api\/media\/file\//,
];

// Search/suggest API: EmDash core devolve Cache-Control: private, no-store
// (assume conteudo dinamico por usuario). Pro blog publico, a busca e
// determinista (mesmo query → mesmos resultados pra qualquer um), entao da
// pra forcar cache no edge. Sem isso, cada keystroke do LiveSearch dispara
// uma roundtrip de ~2.5s no D1 (FTS5 + N queries pra hidratar resultados).
const CACHEABLE_API_PATTERNS = [
	/^\/_emdash\/api\/search$/,
	/^\/_emdash\/api\/search\/suggest$/,
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

// max-age=120: cache do browser. TTL maior que o cron interval (1min) garante
//   que o cache nao expira entre ciclos do scheduled handler — sem MISS no
//   intervalo. Trade: novo post leva ate 2min pra aparecer pra quem ja
//   visitou. Trade-off aceitavel; antes de aumentar mais, considerar invalidar
//   via API quando o bot Discord aprova.
// s-maxage=120: CF CDN edge cache, mesmo intervalo.
// max-age=0 + must-revalidate: browser SEMPRE revalida ao acessar. Sem isso,
//   leitor que visita post anonimo e depois loga via FB ve o HTML cacheado
//   (anonimo) ate o ciclo expirar. Custo: cada navegacao do leitor faz
//   round-trip pra CDN (mas response do CDN eh ~50ms, imperceptivel). CDN
//   ainda cacheia agressivo via s-maxage; so o browser local que revalida.
// SEM stale-while-revalidate pra HTML: ela serve stale por ate 24h, e o
//   cookie reader_session muda durante essa janela quando user loga. Browser
//   exibiria a versao anonima cacheada mesmo apos login bem-sucedido.
const DEFAULT_CACHE_CONTROL =
	"public, max-age=0, must-revalidate, s-maxage=120";

type CacheKind = "html" | "media" | "api" | null;

function classifyCacheable(request: Request): CacheKind {
	if (request.method !== "GET") return null;
	const url = new URL(request.url);
	if (CACHEABLE_HTML_PATTERNS.some((re) => re.test(url.pathname))) return "html";
	if (CACHEABLE_API_PATTERNS.some((re) => re.test(url.pathname))) return "api";
	if (CACHEABLE_MEDIA_PATTERNS.some((re) => re.test(url.pathname))) return "media";
	return null;
}

function makeCacheKey(request: Request): Request {
	const url = new URL(request.url);
	for (const p of TRACKING_PARAMS) url.searchParams.delete(p);
	url.searchParams.sort();
	return new Request(url.toString(), { method: "GET" });
}

// Versao do cache de search. Bump quando muda o shape do response
// (campos novos no JSON, regras de sanitize, normalizacao do snippet) pra
// invalidar TODAS as keys cached sem precisar esperar TTL ou purge manual.
const SEARCH_CACHE_VERSION = "3"; // v3: PT JSON cleanup + best-column snippet

// Cache key pra search API: normaliza o param `q` (trim + lowercase + collapse
// whitespace) pra maximizar reuso entre usuarios. "Diabetes ", "diabetes",
// "DIABETES" todas caem na mesma chave.
function makeSearchCacheKey(request: Request): Request {
	const url = new URL(request.url);
	const q = url.searchParams.get("q");
	if (q !== null) {
		const normalized = q.trim().toLowerCase().replace(/\s+/g, " ");
		url.searchParams.set("q", normalized);
	}
	url.searchParams.set("_sv", SEARCH_CACHE_VERSION);
	url.searchParams.sort();
	return new Request(url.toString(), { method: "GET" });
}

// TTL maior pra search API: queries repetem entre usuarios (termos comuns como
// "diabetes", "menopausa", etc) e a janela onde um novo post afeta resultados
// e relativamente tolerante (5min de delay pra novo post aparecer na busca e
// aceitavel; o cron warmup nao cobre buscas, entao max-age curto demais
// devolveria MISS constante).
const SEARCH_CACHE_CONTROL =
	"public, max-age=300, s-maxage=300, stale-while-revalidate=86400";

const LEGACY_PUBLIC_PATHS = [
	/^\/posts(\/|$)/,
	/^\/tag\//,
	/^\/category\//,
	/^\/pages\//,
	/^\/categorias\/?$/,
	/^\/sitemap\.xml$/,
	/^\/rss\.xml$/,
];

const BLOG_PREFIX_PATHS = [
	"posts",
	"tag",
	"category",
	"pages",
	"categorias",
	"sitemap.xml",
	"rss.xml",
	"search",
	// Rotas Astro custom do blog (reader auth Facebook + endpoint proxy
	// de comentarios). Resolvem em src/pages/api/* — Astro nao adiciona
	// prefixo /blog automaticamente, entao a gente strip aqui.
	"api",
];

function redirectLegacyPublicPath(request: Request): Response | null {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const url = new URL(request.url);
	if (!LEGACY_PUBLIC_PATHS.some((re) => re.test(url.pathname))) return null;
	url.pathname = `/blog${url.pathname}`;
	return Response.redirect(url.toString(), 301);
}

function stripBlogPrefixForAstro(request: Request): Request {
	const url = new URL(request.url);
	const match = url.pathname.match(/^\/blog\/([^/]+)(\/.*)?$/);
	if (!match) return request;
	const firstSegment = match[1];
	if (!firstSegment || !BLOG_PREFIX_PATHS.includes(firstSegment)) return request;
	url.pathname = url.pathname.replace(/^\/blog/, "") || "/";
	return new Request(url.toString(), request);
}

// Cache key separado pra variantes WebP de media. Sem isso, primeira request
// (com Accept: image/webp) salvaria WebP no cache, mas a SEGUNDA (sem webp,
// ex: bot/curl velho) leria o WebP e quebraria. Usando params distintos, cada
// variante tem seu proprio slot — sem cross-contamination.
//
// `_v` e version marker: bump pra invalidar todas as variantes WebP cacheadas
// quando o algoritmo de transformacao muda. v1 = sem quality (lossless, ruim
// pra fotos JPG). v2 = quality 75 (lossy padrao p fotos).
const MEDIA_CACHE_VERSION = "2";

function makeMediaCacheKey(request: Request, asWebp: boolean): Request {
	if (!asWebp) return request;
	const url = new URL(request.url);
	url.searchParams.set("_fmt", "webp");
	url.searchParams.set("_v", MEDIA_CACHE_VERSION);
	return new Request(url.toString(), { method: "GET" });
}

// Heuristica simples: todo browser que manda Accept: image/webp suporta WebP.
// Cobre 97%+ do trafego (Safari 14+, Chrome 23+, FF 65+, Edge 18+). Crawlers
// e curls velhos caem no fallback (raw JPG/PNG).
function clientAcceptsWebp(request: Request): boolean {
	const accept = request.headers.get("accept") ?? "";
	return accept.includes("image/webp");
}

// Tenta converter pra WebP via CF Images binding. Retorna null se:
// - binding nao disponivel
// - input nao e imagem decodavel (SVG, video, etc.)
// - transformacao falha (timeout, formato exotico)
// O caller usa esse null pra cair no fallback do raw upstream.
type ImagesBinding = {
	input?: (body: ReadableStream | ArrayBuffer) => {
		transform: (opts: { width?: number; height?: number; fit?: string }) => unknown;
		output: (opts: { format: string; quality?: number }) => Promise<{ response: () => Response }>;
	};
};

// Quality default 75: padrao da industria pra fotos JPG → WebP. Acima de 80
// o ganho de tamanho deteriora rapidamente; abaixo de 70 artefatos visiveis
// aparecem em areas de gradiente (rosto, ceu). 75 corta ~70% do JPG mantendo
// qualidade percebida indistinguivel.
//
// CRITICO: sem quality explicito, o binding gera WebP lossless, que pra fotos
// (input ja lossy) fica 2-3x MAIOR que o JPG original — o oposto do desejado.
// Bug confirmado em prod 2026-05-23 antes do fix.
const WEBP_QUALITY = 75;

async function transformToWebp(
	body: ReadableStream | null,
	env: { IMAGES?: ImagesBinding },
	width?: number,
): Promise<Response | null> {
	if (!body) return null;
	const images = env.IMAGES;
	if (!images?.input) return null;
	try {
		let pipeline = images.input(body) as {
			transform: (opts: { width?: number; height?: number; fit?: string }) => typeof pipeline;
			output: (opts: { format: string; quality?: number }) => Promise<{ response: () => Response }>;
		};
		if (width && width > 0) {
			pipeline = pipeline.transform({ width });
		}
		const output = await pipeline.output({ format: "image/webp", quality: WEBP_QUALITY });
		return output.response();
	} catch {
		return null;
	}
}

export default {
	async fetch(
		request: Request,
		env: unknown,
		ctx: ExecutionContext,
	): Promise<Response> {
		// Static assets do public/ (imagens, favicon, etc) vao pra ASSETS
		// binding direto — sem isso, o handler do Astro engole o request
		// e devolve a home (catch-all do SSR).
		if (request.method === "GET" || request.method === "HEAD") {
			const url = new URL(request.url);
			if (/\.(webp|png|jpg|jpeg|gif|svg|ico|avif)$/i.test(url.pathname)) {
				const assets = (env as { ASSETS?: { fetch: (r: Request) => Promise<Response> } }).ASSETS;
				if (assets) {
					const assetResponse = await assets.fetch(request);
					if (assetResponse.status === 200) return assetResponse;
				}
			}
		}

		const redirect = redirectLegacyPublicPath(request);
		if (redirect) return redirect;

		const kind = classifyCacheable(request);
		const handlerRequest = stripBlogPrefixForAstro(request);
		if (!kind) {
			// @ts-expect-error handler default export shape from @astrojs/cloudflare
			return handler.fetch(handlerRequest, env, ctx);
		}

		// Bypass edge cache pra leitores logados via Facebook. O HTML inclui
		// nome/avatar do leitor (ReaderAuthBar) + form custom sem campos
		// name/email. Sem isso, anonimos cacheariam HTML e logados veriam
		// "Continuar com Facebook" mesmo com cookie valido. Pula tanto a
		// leitura quanto a escrita do cache pra esses requests.
		if (kind === "html" && (request.headers.get("cookie") || "").includes("reader_session=")) {
			// @ts-expect-error handler default export shape
			return handler.fetch(handlerRequest, env, ctx);
		}

		const cache = caches.default;
		// Pra media: cache key inclui marker `_fmt=webp` se cliente aceita WebP,
		// pra evitar contaminacao cross-variant (ver makeMediaCacheKey).
		const wantWebp = kind === "media" && clientAcceptsWebp(request);
		const cacheKey =
			kind === "html"
				? makeCacheKey(request)
				: kind === "api"
					? makeSearchCacheKey(request)
					: kind === "media"
						? makeMediaCacheKey(request, wantWebp)
						: request;

		const cached = await cache.match(cacheKey);
		if (cached) {
			const r = new Response(cached.body, cached);
			r.headers.set("x-edge-cache", "HIT");
			return r;
		}

		// @ts-expect-error handler default export shape from @astrojs/cloudflare
		let response: Response = await handler.fetch(handlerRequest, env, ctx);

		// IMPORTANTE: o check `no-store` so se aplica a HTML/media. Pra search API
		// o EmDash core SEMPRE manda `private, no-store` (assume contexto de
		// usuario logado); a gente sobrescreve abaixo porque a busca publica do
		// blog e determinista.
		if (
			response.status !== 200 ||
			response.headers.has("set-cookie") ||
			(kind !== "api" && response.headers.get("cache-control")?.includes("no-store"))
		) {
			return response;
		}

		// Media WebP conversion: tenta IMAGES binding pra reduzir ~70% do
		// peso de JPGs/PNGs. Falha silenciosa (mantem original) se:
		// - binding indisponivel (free plan sem CF Images)
		// - input nao decodavel (SVG/video/AVIF ja otimo)
		// - upstream nao retornou imagem decodavel
		// Param `?w=` opcional restringe largura (template astro usa pra srcset).
		if (wantWebp && response.headers.get("content-type")?.startsWith("image/")) {
			const contentType = response.headers.get("content-type") ?? "";
			// SVG nao precisa (ja vetorial); animated GIF/WebP nao queremos converter
			// pra WebP estatico — quebraria animacao.
			const skipFormats = ["image/svg", "image/gif", "image/webp", "image/avif"];
			if (!skipFormats.some((f) => contentType.includes(f))) {
				const widthParam = new URL(request.url).searchParams.get("w");
				const width = widthParam ? parseInt(widthParam, 10) : undefined;
				const webp = await transformToWebp(response.body, env as { IMAGES?: ImagesBinding }, width);
				if (webp) {
					const newHeaders = new Headers(response.headers);
					newHeaders.set("Content-Type", "image/webp");
					newHeaders.delete("Content-Length"); // recalculado pelo runtime
					// Vary: Accept e informativo (CDN externos respeitam, workers cache
					// nao usa diretamente — por isso a cache key separa via _fmt).
					newHeaders.set("Vary", "Accept");
					response = new Response(webp.body, {
						status: 200,
						headers: newHeaders,
					});
				}
			}
		}

		const headers = new Headers(response.headers);
		// Pra HTML: SOBRESCREVE Cache-Control pra garantir max-age (browser cache).
		// Os templates Astro tambem setam um header similar mas podem estar
		// desatualizados; worker.ts e a fonte unica de verdade pra HTML cache.
		// Pra api (search): sobrescreve o `private, no-store` do EmDash core.
		// Pra media: preserva o Cache-Control upstream (EmDash ja manda
		// max-age=31536000 immutable nas imagens — storageKey é content-addressed).
		if (kind === "html") {
			headers.set("Cache-Control", DEFAULT_CACHE_CONTROL);
		} else if (kind === "api") {
			headers.set("Cache-Control", SEARCH_CACHE_CONTROL);
			// Debug marker: pra confirmar que o worker novo esta rodando o
			// override de api cache. Remover depois que estabilizar.
			headers.set("x-emdash-search-version", SEARCH_CACHE_VERSION);
			// CORS: LiveSearch chama da mesma origem hoje, mas se algum dia for
			// embedado, sem isso o cached response pode quebrar; barato adicionar.
			if (!headers.has("Access-Control-Allow-Origin")) {
				headers.set("Access-Control-Allow-Origin", "*");
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

	// Cron trigger (config em wrangler.jsonc): roda a cada 1min e faz self-fetch
	// em URLs principais. Objetivo: manter o isolate quente (cold start do
	// EmDash core leva ~800ms entre rt.setup+rt.market+rt.db) e o caches.default
	// sempre fresh. Sem isso, primeira visita em PoP frio paga ~1.8s — confirmado
	// 2026-05-22 com Ian no Network tab DevTools.
	//
	// Limitacao: cron roda em 1 PoP por execucao (CF nao distribui), entao so
	// aquece esse PoP. Pra cobrir mais PoPs, dependeria de Workers Cron Reserve
	// (feature paga) ou disparar de varios lugares externos. Mesmo assim, manter
	// 1 PoP sempre warm ja ajuda — outros pegam menos cold porque ao chegar a
	// primeira request, o codigo do worker ja foi promovido pra "globalmente
	// quente" no rolling cache da CF.
	async scheduled(
		event: ScheduledEvent,
		env: unknown,
		ctx: ExecutionContext,
	): Promise<void> {
		const origin = "https://douravita.com.br";

		// Lista base: home + index de posts + blog. Sempre aquece.
			const baseUrls = [
				`${origin}/`,
				`${origin}/blog`,
				`${origin}/blog/posts`,
			];

		// Pre-warm de TODAS as URLs do sitemap (posts individuais, pages, etc).
			// Sem isso, cada /blog/posts/<slug> e MISS no primeiro acesso → ~2.5s render
		// (17-21 queries D1 + template). Com warmup, primeiro acesso vira HIT
		// em ~150ms.
		// Limite de 50 URLs por safety (cron tem ~30s wall clock; self-fetch
		// em paralelo via Promise.allSettled). 50 cobre o blog atual com folga.
		const sitemapUrls = await fetchSitemapUrls(this, env, ctx, origin, 50);

			// Dedup: sitemap inclui /blog e /blog/posts (que ja estao em baseUrls).
		const warmupUrls = Array.from(new Set([...baseUrls, ...sitemapUrls]));

		// Pre-warm tambem a busca pra termos comuns. Sem isso, primeira
		// keystroke ainda paga ~2.5s. Lista mantida pequena: o cache da
		// search e per-query, entao so vale aquecer queries que repetem muito.
		const searchWarmupQueries = [
			"diabetes",
			"menopausa",
			"longevidade",
			"musculacao",
			"memoria",
			"suplemento",
		];
		const searchUrls = searchWarmupQueries.map(
			(q) => `${origin}/_emdash/api/search?q=${encodeURIComponent(q)}&collections=posts&limit=8`,
		);

		const allUrls = [...warmupUrls, ...searchUrls];

		// Self-fetch via handler (passa pelo cache logic do default.fetch acima).
		// Promise.allSettled: 1 URL falhar nao deve abortar as outras.
		ctx.waitUntil(
			Promise.allSettled(
				allUrls.map((url) =>
					this.fetch(new Request(url, { method: "GET" }), env, ctx),
				),
			).then((results) => {
				const ok = results.filter((r) => r.status === "fulfilled").length;
				console.log(
					`[cron warmup] ${ok}/${allUrls.length} OK (${warmupUrls.length} pages + ${searchUrls.length} searches) at ${new Date(event.scheduledTime).toISOString()}`,
				);
			}),
		);
	},
};

// Pega /blog/sitemap.xml e extrai os <loc>. Filtra pra mesma origem (defesa em
// profundidade: sitemap nao deveria conter URLs cross-origin, mas se um dia
// o template mudar nao queremos self-fetch em dominios externos).
async function fetchSitemapUrls(
	self: { fetch: (req: Request, env: unknown, ctx: ExecutionContext) => Promise<Response> },
	env: unknown,
	ctx: ExecutionContext,
	origin: string,
	limit: number,
): Promise<string[]> {
	try {
		const sitemapReq = new Request(`${origin}/blog/sitemap.xml`, { method: "GET" });
		const resp = await self.fetch(sitemapReq, env, ctx);
		if (!resp.ok) {
			console.log(`[cron warmup] sitemap fetch failed: ${resp.status}`);
			return [];
		}
		const xml = await resp.text();
		const matches = xml.matchAll(/<loc>([^<]+)<\/loc>/g);
		const urls: string[] = [];
		for (const m of matches) {
			const u = m[1].trim();
			if (u.startsWith(origin) && urls.length < limit) {
				urls.push(u);
			}
		}
		return urls;
	} catch (err) {
		console.log(`[cron warmup] sitemap parse error: ${(err as Error).message}`);
		return [];
	}
}
