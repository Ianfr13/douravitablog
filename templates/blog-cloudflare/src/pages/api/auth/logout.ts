/**
 * POST /api/auth/logout
 *
 * Apaga o cookie `reader_session`. Aceita ?returnTo=/path pra redirecionar
 * apos logout (default: /blog). GET tambem aceito pra UX (link "Sair").
 */

import type { APIRoute } from "astro";
import {
	readerSessionClearCookieHeader,
	readerSessionMarkerClearHeader,
} from "../../../lib/reader-session";

export const prerender = false;

function safeReturnTo(raw: string | null): string {
	if (!raw) return "/blog";
	if (!raw.startsWith("/") || raw.startsWith("//")) return "/blog";
	return raw;
}

const handler: APIRoute = async ({ url }) => {
	const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
	const headers = new Headers({
		Location: returnTo,
		"Cache-Control": "no-store",
	});
	headers.append("Set-Cookie", readerSessionClearCookieHeader());
	headers.append("Set-Cookie", readerSessionMarkerClearHeader());
	return new Response(null, { status: 302, headers });
};

export const GET = handler;
export const POST = handler;
