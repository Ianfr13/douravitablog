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

const handler: APIRoute = async ({ url, redirect }) => {
	const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
	// @ts-expect-error Astro redirect typing
	const res = redirect(returnTo, 302) as Response;
	res.headers.append("Set-Cookie", readerSessionClearCookieHeader());
	res.headers.set("Cache-Control", "no-store");
	return res;
};

export const GET = handler;
export const POST = handler;
