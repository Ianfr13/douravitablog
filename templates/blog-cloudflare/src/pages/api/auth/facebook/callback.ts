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

function getEnv(locals: App.Locals): {
	appId?: string;
	appSecret?: string;
	readerSecret?: string;
} {
	const runtime = (locals as unknown as { runtime?: { env?: Record<string, unknown> } }).runtime;
	const env = runtime?.env ?? (import.meta.env as unknown as Record<string, unknown>);
	const pick = (k: string): string | undefined => (typeof env[k] === "string" ? (env[k] as string) : undefined);
	return {
		appId: pick("FACEBOOK_APP_ID"),
		appSecret: pick("FACEBOOK_APP_SECRET"),
		readerSecret: pick("READER_SESSION_SECRET"),
	};
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

function errorRedirect(redirect: APIRoute extends (ctx: infer C) => unknown ? (C extends { redirect: infer R } ? R : never) : never, returnTo: string, code: string): Response {
	const url = new URL(returnTo, "https://placeholder.local");
	url.searchParams.set("login_error", code);
	const path = url.pathname + url.search;
	// @ts-expect-error redirect signature
	const res = redirect(path, 302) as Response;
	res.headers.append("Set-Cookie", stateCookieClearHeader());
	res.headers.set("Cache-Control", "no-store");
	return res;
}

export const GET: APIRoute = async ({ request, url, locals, redirect }) => {
	const { appId, appSecret, readerSecret } = getEnv(locals);
	if (!appId || !appSecret || !readerSecret) {
		return new Response("Login do Facebook nao configurado (env vars ausentes)", { status: 500 });
	}

	// Lê params do callback
	const code = url.searchParams.get("code");
	const state = url.searchParams.get("state");
	const fbError = url.searchParams.get("error");
	const cookieHeader = request.headers.get("cookie");
	const savedState = getStateCookie(cookieHeader);
	const returnTo = state ? decodeReturnTo(state) : "/blog";

	// Erros vindos do proprio Facebook (user cancelou, etc)
	if (fbError) {
		return errorRedirect(redirect, returnTo, "oauth_denied");
	}

	if (!code || !state) {
		return errorRedirect(redirect, returnTo, "missing_params");
	}

	// CSRF: state recebido tem que bater com cookie salvo
	if (!savedState || savedState !== state) {
		return errorRedirect(redirect, returnTo, "invalid_state");
	}

	const origin = new URL(request.url).origin;
	const redirectUri = `${origin}/blog/api/auth/facebook/callback`;

	let accessToken: string;
	try {
		accessToken = await exchangeCodeForToken({ appId, appSecret, redirectUri }, code);
	} catch {
		return errorRedirect(redirect, returnTo, "token_exchange_failed");
	}

	let profile: Awaited<ReturnType<typeof fetchProfile>>;
	try {
		profile = await fetchProfile(accessToken);
	} catch {
		return errorRedirect(redirect, returnTo, "profile_fetch_failed");
	}

	// Email pode estar ausente se o user nao concedeu permissao.
	// Sem email, geramos um placeholder estavel (so pra moderacao first_time
	// funcionar — nao mandamos email pra esse endereco).
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

	// @ts-expect-error Astro redirect typing
	const res = redirect(returnTo, 302) as Response;
	res.headers.append("Set-Cookie", readerSessionSetCookieHeader(cookieValue));
	res.headers.append("Set-Cookie", stateCookieClearHeader());
	res.headers.set("Cache-Control", "no-store");
	return res;
};
