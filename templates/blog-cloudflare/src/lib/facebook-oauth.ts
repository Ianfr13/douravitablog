/**
 * Facebook OAuth 2.0 — wrapper minimo do fluxo de Login do Facebook v18+.
 *
 * Permissoes pedidas: `email` + `public_profile` (default, sem App Review).
 *
 * Fluxo:
 *   1. /api/auth/facebook/login: gera CSRF state, redireciona usuario pra FB
 *   2. /api/auth/facebook/callback: FB redireciona com `code` e `state`;
 *      trocamos `code` por access_token, buscamos profile, setamos cookie
 */

const FB_GRAPH_VERSION = "v18.0";
const AUTH_URL = `https://www.facebook.com/${FB_GRAPH_VERSION}/dialog/oauth`;
const TOKEN_URL = `https://graph.facebook.com/${FB_GRAPH_VERSION}/oauth/access_token`;
const PROFILE_URL = `https://graph.facebook.com/${FB_GRAPH_VERSION}/me`;

export interface FacebookProfile {
	id: string;
	name: string;
	email?: string;
	pictureUrl?: string;
}

export interface FacebookOAuthConfig {
	appId: string;
	appSecret: string;
	redirectUri: string;
}

/** Monta a URL de inicio do flow OAuth.
 *
 * Sem `scope` explicito: o app Douravitawp eh tipo Business e nao tem
 * `public_profile` na lista de "supported permissions" (so tem permissoes
 * tipo pages_*, ads_*). Pedir public_profile dispara "Este app precisa pelo
 * menos de uma supported permission". Sem scope, FB faz auth basico e ainda
 * permite /me?fields=id,name (campos public_profile sao default mesmo sem
 * scope explicito quando o user autoriza).
 */
export function buildAuthorizationUrl(config: FacebookOAuthConfig, state: string): string {
	const url = new URL(AUTH_URL);
	url.searchParams.set("client_id", config.appId);
	url.searchParams.set("redirect_uri", config.redirectUri);
	url.searchParams.set("state", state);
	url.searchParams.set("response_type", "code");
	return url.toString();
}

/** Troca o `code` recebido no callback por um access_token. */
export async function exchangeCodeForToken(
	config: FacebookOAuthConfig,
	code: string,
): Promise<string> {
	const url = new URL(TOKEN_URL);
	url.searchParams.set("client_id", config.appId);
	url.searchParams.set("client_secret", config.appSecret);
	url.searchParams.set("redirect_uri", config.redirectUri);
	url.searchParams.set("code", code);

	const res = await fetch(url.toString(), { method: "GET" });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`token_exchange_failed: ${res.status} ${body.slice(0, 200)}`);
	}
	const data = (await res.json()) as { access_token?: string; error?: { message: string } };
	if (data.error) throw new Error(`token_exchange_failed: ${data.error.message}`);
	if (!data.access_token) throw new Error("token_exchange_failed: no access_token");
	return data.access_token;
}

/** Busca id + name + email + foto de perfil usando o access_token. */
export async function fetchProfile(accessToken: string): Promise<FacebookProfile> {
	const url = new URL(PROFILE_URL);
	url.searchParams.set("fields", "id,name,email,picture.type(large)");
	url.searchParams.set("access_token", accessToken);

	const res = await fetch(url.toString(), { method: "GET" });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`profile_fetch_failed: ${res.status} ${body.slice(0, 200)}`);
	}
	const data = (await res.json()) as {
		id?: string;
		name?: string;
		email?: string;
		picture?: { data?: { url?: string } };
		error?: { message: string };
	};
	if (data.error) throw new Error(`profile_fetch_failed: ${data.error.message}`);
	if (!data.id || !data.name) throw new Error("profile_fetch_failed: missing id/name");

	return {
		id: data.id,
		name: data.name,
		email: data.email,
		pictureUrl: data.picture?.data?.url,
	};
}

/** Gera um state aleatorio pra CSRF. */
export function generateState(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Helpers de cookie pro state CSRF — armazenamos durante o roundtrip OAuth.
 * Cookie temporario (10 min de TTL), HttpOnly, Secure.
 */
const STATE_COOKIE = "_fb_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;

export function stateCookieSetHeader(state: string): string {
	return [
		`${STATE_COOKIE}=${state}`,
		"Path=/",
		`Max-Age=${STATE_TTL_SECONDS}`,
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
	].join("; ");
}

export function stateCookieClearHeader(): string {
	return [`${STATE_COOKIE}=`, "Path=/", "Max-Age=0", "HttpOnly", "Secure", "SameSite=Lax"].join("; ");
}

export function getStateCookie(cookieHeader: string | null | undefined): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === STATE_COOKIE) return rest.join("=");
	}
	return undefined;
}

export const FB_STATE_COOKIE_NAME = STATE_COOKIE;
