/**
 * GET /api/auth/facebook/callback
 *
 * Recebe o callback OAuth do Facebook:
 *   1. Valida CSRF state contra o cookie
 *   2. Troca code por access_token
 *   3. Busca profile (id, name, email, picture)
 *   4. Cria reader_session cookie HMAC-assinado
 *   5. Redireciona pro returnTo embutido no state
 */

import type { APIRoute } from "astro";
import {
	exchangeCodeForToken,
	fetchProfile,
	getStateCookie,
	stateCookieClearHeader,
} from "../../../../lib/facebook-oauth";
import {
	encodeReaderSession,
	readerSessionSetCookieHeader,
} from "../../../../lib/reader-session";
import { getWorkerEnv } from "../../../../lib/worker-env";

export const prerender = false;

function decodeReturnTo(state: string): string {
	const dotIdx = state.indexOf(".");
	if (dotIdx < 0) return "/blog";
	const b64 = state.slice(dotIdx + 1);
	const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
	try {
		const decoded = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + pad);
		if (decoded.startsWith("/") && !decoded.startsWith("//")) return decoded;
	} catch {
		// fall through
	}
	return "/blog";
}

function escapeHtmlAttr(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/**
 * Retorna HTML 200 com redirect via meta refresh + JS, em vez de 302.
 *
 * Por que nao 302: alguns browsers descartam cookies setados em response
 * 302 quando o request original vem de cross-site (ex: facebook.com →
 * douravita.com.br). Com 200 + meta refresh, o cookie eh sempre persistido
 * antes do navigate.
 */
function htmlRedirect(target: string, setCookies: string[]): Response {
	const safe = escapeHtmlAttr(target);
	const safeJs = JSON.stringify(target);
	const body = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><title>Entrando...</title><meta http-equiv="refresh" content="0;url=${safe}"><script>location.replace(${safeJs});</script></head><body style="font-family:system-ui;padding:2rem;text-align:center;color:#555">Entrando... <a href="${safe}">clique aqui se nao for redirecionado</a></body></html>`;
	const headers = new Headers({
		"Content-Type": "text/html; charset=UTF-8",
		"Cache-Control": "no-store",
	});
	for (const c of setCookies) headers.append("Set-Cookie", c);
	return new Response(body, { status: 200, headers });
}

function errorRedirect(returnTo: string, code: string): Response {
	const u = new URL(returnTo, "https://placeholder.local");
	u.searchParams.set("login_error", code);
	const target = u.pathname + u.search;
	return htmlRedirect(target, [stateCookieClearHeader()]);
}

export const GET: APIRoute = async ({ request, url }) => {
	try {
		const env = await getWorkerEnv();
		const appId = env.FACEBOOK_APP_ID;
		const appSecret = env.FACEBOOK_APP_SECRET;
		const readerSecret = env.READER_SESSION_SECRET;
		if (!appId || !appSecret || !readerSecret) {
			return new Response("Login do Facebook nao configurado (env vars ausentes)", {
				status: 500,
			});
		}

		const code = url.searchParams.get("code");
		const state = url.searchParams.get("state");
		const fbError = url.searchParams.get("error");
		const cookieHeader = request.headers.get("cookie");
		const savedState = getStateCookie(cookieHeader);
		const returnTo = state ? decodeReturnTo(state) : "/blog";

		if (fbError) {
			return errorRedirect(returnTo, "oauth_denied");
		}
		if (!code || !state) {
			return errorRedirect(returnTo, "missing_params");
		}
		if (!savedState || savedState !== state) {
			return errorRedirect(returnTo, "invalid_state");
		}

		const origin = new URL(request.url).origin;
		const redirectUri = `${origin}/blog/api/auth/facebook/callback`;

		let accessToken: string;
		try {
			accessToken = await exchangeCodeForToken({ appId, appSecret, redirectUri }, code);
		} catch (err) {
			console.error("[fb-callback] token_exchange_failed:", err);
			return errorRedirect(returnTo, "token_exchange_failed");
		}

		let profile: Awaited<ReturnType<typeof fetchProfile>>;
		try {
			profile = await fetchProfile(accessToken);
		} catch (err) {
			console.error("[fb-callback] profile_fetch_failed:", err);
			return errorRedirect(returnTo, "profile_fetch_failed");
		}

		const { cookieValue } = await encodeReaderSession(
			{
				fbId: profile.id,
				name: profile.name,
			},
			readerSecret,
		);

		return htmlRedirect(returnTo, [
			readerSessionSetCookieHeader(cookieValue),
			stateCookieClearHeader(),
		]);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[fb-callback] crash:", msg, err instanceof Error ? err.stack : "");
		return new Response(`Erro no callback Facebook: ${msg}`, { status: 500 });
	}
};
