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

export const prerender = false;

function readEnv(locals: unknown): Record<string, unknown> {
	try {
		const l = locals as { runtime?: { env?: unknown } } | null | undefined;
		const env = l?.runtime?.env;
		if (env && typeof env === "object") return env as Record<string, unknown>;
	} catch {
		// fall through
	}
	return {};
}

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

function errorRedirect(returnTo: string, code: string, extraSetCookie?: string): Response {
	const u = new URL(returnTo, "https://placeholder.local");
	u.searchParams.set("login_error", code);
	const headers = new Headers({
		Location: u.pathname + u.search,
		"Cache-Control": "no-store",
	});
	headers.append("Set-Cookie", stateCookieClearHeader());
	if (extraSetCookie) headers.append("Set-Cookie", extraSetCookie);
	return new Response(null, { status: 302, headers });
}

export const GET: APIRoute = async ({ request, url, locals }) => {
	try {
		const env = readEnv(locals);
		const appId = typeof env.FACEBOOK_APP_ID === "string" ? env.FACEBOOK_APP_ID : undefined;
		const appSecret =
			typeof env.FACEBOOK_APP_SECRET === "string" ? env.FACEBOOK_APP_SECRET : undefined;
		const readerSecret =
			typeof env.READER_SESSION_SECRET === "string" ? env.READER_SESSION_SECRET : undefined;
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

		const email = profile.email ?? `${profile.id}@facebook.douravita.local`;

		const { cookieValue } = await encodeReaderSession(
			{
				fbId: profile.id,
				name: profile.name,
				email,
				picture: profile.pictureUrl ?? "",
			},
			readerSecret,
		);

		const headers = new Headers({
			Location: returnTo,
			"Cache-Control": "no-store",
		});
		headers.append("Set-Cookie", readerSessionSetCookieHeader(cookieValue));
		headers.append("Set-Cookie", stateCookieClearHeader());
		return new Response(null, { status: 302, headers });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.error("[fb-callback] crash:", msg, err instanceof Error ? err.stack : "");
		return new Response(`Erro no callback Facebook: ${msg}`, { status: 500 });
	}
};
