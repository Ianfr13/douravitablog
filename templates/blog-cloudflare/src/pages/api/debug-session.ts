/**
 * GET /api/debug-session
 *
 * Endpoint TEMPORARIO de diagnostico. Le o cookie reader_session, mostra:
 *   - se o cookie existe
 *   - decode bruto do payload (sem checar HMAC) pra ver estrutura
 *   - resultado do decodeReaderSession (com check HMAC) — se valido ou nao
 *
 * REMOVER apos diagnostico.
 */
import type { APIRoute } from "astro";
import { decodeReaderSession, getReaderSessionCookie } from "../../lib/reader-session";
import { getWorkerEnv } from "../../lib/worker-env";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
	const env = await getWorkerEnv();
	const readerSecret = env.READER_SESSION_SECRET as string | undefined;
	const cookieHeader = request.headers.get("cookie");
	const cookieValue = getReaderSessionCookie(cookieHeader);

	const out: Record<string, unknown> = {
		hasSecret: Boolean(readerSecret),
		secretLength: readerSecret?.length ?? 0,
		hasCookie: Boolean(cookieValue),
		cookieLength: cookieValue?.length ?? 0,
		cookiePreview: cookieValue ? cookieValue.slice(0, 40) + "..." : null,
	};

	if (cookieValue) {
		const [payloadEnc, sigEnc] = cookieValue.split(".");
		out.hasPayload = Boolean(payloadEnc);
		out.hasSignature = Boolean(sigEnc);
		out.payloadEncLength = payloadEnc?.length ?? 0;
		out.sigEncLength = sigEnc?.length ?? 0;

		if (payloadEnc) {
			try {
				const pad = payloadEnc.length % 4 === 0 ? "" : "=".repeat(4 - (payloadEnc.length % 4));
				const bin = atob(payloadEnc.replace(/-/g, "+").replace(/_/g, "/") + pad);
				const bytes = new Uint8Array(bin.length);
				for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
				const json = new TextDecoder().decode(bytes);
				out.payloadDecoded = json;
				try {
					out.payloadParsed = JSON.parse(json);
				} catch (e) {
					out.payloadParseError = String(e);
				}
			} catch (e) {
				out.payloadDecodeError = String(e);
			}
		}
	}

	if (readerSecret) {
		const session = await decodeReaderSession(cookieValue, readerSecret);
		out.decodeResult = session;
		out.decodeReturnedNull = session === null;
	}

	return new Response(JSON.stringify(out, null, 2), {
		status: 200,
		headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
	});
};
