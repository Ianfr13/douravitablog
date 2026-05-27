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

export const prerender = false;

function getEnv(locals: App.Locals): { appId?: string } {
	const runtime = (locals as unknown as { runtime?: { env?: Record<string, unknown> } }).runtime;
	const env = runtime?.env ?? (import.meta.env as unknown as Record<string, unknown>);
	return { appId: typeof env.FACEBOOK_APP_ID === "string" ? env.FACEBOOK_APP_ID : undefined };
}

function safeReturnTo(raw: string | null): string {
	if (!raw) return "/blog";
	// So aceita paths relativos do proprio site. Bloqueia open redirect.
	if (!raw.startsWith("/") || raw.startsWith("//")) return "/blog";
	return raw;
}

export const GET: APIRoute = async ({ request, url, locals, redirect }) => {
	const { appId } = getEnv(locals);
	if (!appId) {
		return new Response("Facebook Login nao configurado", { status: 500 });
	}

	const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
	const stateBytes = generateState();
	// State carrega o returnTo embutido — assinado pelo HMAC do proprio state.
	// Formato: <random>:<base64url(returnTo)>
	const returnToB64 = btoa(returnTo).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
	const state = `${stateBytes}.${returnToB64}`;

	const origin = new URL(request.url).origin;
	const redirectUri = `${origin}/blog/api/auth/facebook/callback`;

	const authUrl = buildAuthorizationUrl({ appId, appSecret: "", redirectUri }, state);

	const res = redirect(authUrl, 302);
	res.headers.append("Set-Cookie", stateCookieSetHeader(state));
	// Anti-cache pra nao reaproveitar state entre sessoes
	res.headers.set("Cache-Control", "no-store");
	return res;
};
