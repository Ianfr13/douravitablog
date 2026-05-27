/**
 * POST /api/auth/logout
 *
 * Apaga o cookie `reader_session`. Aceita ?returnTo=/path pra redirecionar
 * apos logout (default: /blog). GET tambem aceito pra UX (link "Sair").
 */

import type { APIRoute } from "astro";
import { readerSessionClearCookieHeader } from "../../../lib/reader-session";

export const prerender = false;

function safeReturnTo(raw: string | null): string {
	if (!raw) return "/blog";
	if (!raw.startsWith("/") || raw.startsWith("//")) return "/blog";
	return raw;
}

const handler: APIRoute = async ({ url }) => {
	const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
	return new Response(null, {
		status: 302,
		headers: {
			Location: returnTo,
			"Set-Cookie": readerSessionClearCookieHeader(),
			"Cache-Control": "no-store",
		},
	});
};

export const GET = handler;
export const POST = handler;
