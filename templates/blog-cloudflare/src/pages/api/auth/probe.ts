/**
 * Debug: mostra como o backend interpreta o cookie reader_session.
 */

import type { APIRoute } from "astro";
import { decodeReaderSession, getReaderSessionCookie } from "../../../lib/reader-session";
import { getWorkerEnv } from "../../../lib/worker-env";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
	const out: Record<string, unknown> = {};
	try {
		const cookieHeader = request.headers.get("cookie") || "";
		out.hasReaderSubstring = cookieHeader.includes("reader_session=");
		out.cookieHeaderLength = cookieHeader.length;

		const cookieValue = getReaderSessionCookie(cookieHeader);
		out.cookieValueExtracted = cookieValue ? "yes" : "no";
		out.cookieValueLength = cookieValue ? cookieValue.length : 0;
		if (cookieValue) {
			out.cookiePreview = cookieValue.slice(0, 30) + "..." + cookieValue.slice(-10);
			out.dotCount = (cookieValue.match(/\./g) || []).length;
		}

		const env = await getWorkerEnv();
		const secret = env.READER_SESSION_SECRET;
		out.secretPresent = !!secret;
		out.secretLength = secret ? secret.length : 0;

		if (cookieValue && secret) {
			try {
				const session = await decodeReaderSession(cookieValue, secret);
				out.decodeResult = session ? "success" : "null (invalid HMAC or expired)";
				if (session) {
					out.fbId = session.fbId.slice(0, 4) + "***";
					out.name = session.name;
					out.expiresIn = session.expiresAt - Math.floor(Date.now() / 1000);
				}
			} catch (e) {
				out.decodeError = e instanceof Error ? e.message : String(e);
			}
		}
	} catch (e) {
		out.crash = e instanceof Error ? e.message + "\n" + (e.stack || "") : String(e);
	}
	return new Response(JSON.stringify(out, null, 2), {
		status: 200,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
};
