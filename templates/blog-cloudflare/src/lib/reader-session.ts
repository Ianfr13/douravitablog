/**
 * Reader session — cookie HMAC-assinado pra autenticacao de leitor via
 * Facebook Login. Separado do sistema OAuth do EmDash (que e pra admin/CMS).
 *
 * Formato do cookie `reader_session`:
 *   base64url(JSON payload).base64url(HMAC-SHA256(payload, secret))
 *
 * Payload:
 *   {
 *     fb: string,    // Facebook user ID
 *     n:  string,    // nome publico
 *     e:  string,    // email
 *     p:  string,    // URL da foto de perfil
 *     iat: number,   // issued at (unix seconds)
 *     exp: number    // expira em (unix seconds)
 *   }
 *
 * Validade: 30 dias. Renova a cada visita via middleware se a sessao tiver
 * <7 dias pra expirar.
 */

export interface ReaderSession {
	fbId: string;
	name: string;
	email: string;
	picture: string;
	issuedAt: number;
	expiresAt: number;
}

const COOKIE_NAME = "reader_session";
const TTL_SECONDS = 30 * 24 * 60 * 60; // 30 dias

function b64urlEncode(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
	const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
	const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

async function importKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

/** Encode + sign a session. Returns the cookie value. */
export async function encodeReaderSession(
	payload: Omit<ReaderSession, "issuedAt" | "expiresAt"> & { ttlSeconds?: number },
	secret: string,
): Promise<{ cookieValue: string; expiresAt: number }> {
	const now = Math.floor(Date.now() / 1000);
	const ttl = payload.ttlSeconds ?? TTL_SECONDS;
	const expiresAt = now + ttl;
	const compact = {
		fb: payload.fbId,
		n: payload.name,
		e: payload.email,
		p: payload.picture,
		iat: now,
		exp: expiresAt,
	};
	const payloadBytes = new TextEncoder().encode(JSON.stringify(compact));
	const key = await importKey(secret);
	const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, payloadBytes));
	return {
		cookieValue: `${b64urlEncode(payloadBytes)}.${b64urlEncode(sig)}`,
		expiresAt,
	};
}

/** Verify + decode a cookie value. Returns null if invalid/expired. */
export async function decodeReaderSession(
	cookieValue: string | undefined,
	secret: string,
): Promise<ReaderSession | null> {
	if (!cookieValue) return null;
	const [payloadEnc, sigEnc] = cookieValue.split(".");
	if (!payloadEnc || !sigEnc) return null;

	let payloadBytes: Uint8Array;
	let sigBytes: Uint8Array;
	try {
		payloadBytes = b64urlDecode(payloadEnc);
		sigBytes = b64urlDecode(sigEnc);
	} catch {
		return null;
	}

	const key = await importKey(secret);
	const valid = await crypto.subtle.verify("HMAC", key, sigBytes, payloadBytes);
	if (!valid) return null;

	let payload: { fb: string; n: string; e: string; p: string; iat: number; exp: number };
	try {
		payload = JSON.parse(new TextDecoder().decode(payloadBytes));
	} catch {
		return null;
	}

	const now = Math.floor(Date.now() / 1000);
	if (payload.exp < now) return null;

	return {
		fbId: payload.fb,
		name: payload.n,
		email: payload.e,
		picture: payload.p,
		issuedAt: payload.iat,
		expiresAt: payload.exp,
	};
}

/** Serializa o Set-Cookie pra setar reader_session. */
export function readerSessionSetCookieHeader(cookieValue: string, maxAgeSeconds = TTL_SECONDS): string {
	return [
		`${COOKIE_NAME}=${cookieValue}`,
		"Path=/",
		`Max-Age=${maxAgeSeconds}`,
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
	].join("; ");
}

/** Set-Cookie pra deslogar (apaga o cookie). */
export function readerSessionClearCookieHeader(): string {
	return [
		`${COOKIE_NAME}=`,
		"Path=/",
		"Max-Age=0",
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
	].join("; ");
}

/** Le o cookie `reader_session` do Cookie header. */
export function getReaderSessionCookie(cookieHeader: string | null | undefined): string | undefined {
	if (!cookieHeader) return undefined;
	for (const part of cookieHeader.split(";")) {
		const [k, ...rest] = part.trim().split("=");
		if (k === COOKIE_NAME) return rest.join("=");
	}
	return undefined;
}

export const READER_SESSION_COOKIE_NAME = COOKIE_NAME;
export const READER_SESSION_TTL_SECONDS = TTL_SECONDS;
