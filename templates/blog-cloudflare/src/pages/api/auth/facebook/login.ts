/**
 * GET /api/auth/facebook/login
 *
 * Inicia o fluxo OAuth com o Facebook. Gera um state CSRF, salva em cookie,
 * e redireciona o usuario pra tela de autorizacao do Facebook.
 *
 * Query params suportados:
 *   ?returnTo=/blog/posts/slug — pra qual URL voltar apos o login (default /)
 */

import type { APIRoute } from "astro";
import {
	buildAuthorizationUrl,
	generateState,
	stateCookieSetHeader,
} from "../../../../lib/facebook-oauth";
import { getWorkerEnv } from "../../../../lib/worker-env";

export const prerender = false;

function safeReturnTo(raw: string | null): string {
	if (!raw) return "/blog";
	if (!raw.startsWith("/") || raw.startsWith("//")) return "/blog";
	return raw;
}

export const GET: APIRoute = async ({ request, url }) => {
	try {
		const env = await getWorkerEnv();
		const appId = env.FACEBOOK_APP_ID;
		const configId = env.FACEBOOK_CONFIG_ID as string | undefined;
		if (!appId) {
			return new Response("Facebook Login nao configurado: FACEBOOK_APP_ID ausente", {
				status: 500,
			});
		}

		const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
		const stateBytes = generateState();
		const returnToB64 = btoa(returnTo).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
		const state = `${stateBytes}.${returnToB64}`;

		const origin = new URL(request.url).origin;
		const redirectUri = `${origin}/blog/api/auth/facebook/callback`;
		const authUrl = buildAuthorizationUrl(
			{ appId, appSecret: "", redirectUri, configId },
			state,
		);

		// Manual Response em vez de Astro.redirect — mais previsivel pra
		// URLs externas (facebook.com) em ambiente CF Workers.
		return new Response(null, {
			status: 302,
			headers: {
				Location: authUrl,
				"Set-Cookie": stateCookieSetHeader(state),
				"Cache-Control": "no-store",
			},
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[fb-login] crash:", msg, err instanceof Error ? err.stack : "");
		return new Response(`Erro no login Facebook: ${msg}`, { status: 500 });
	}
};
