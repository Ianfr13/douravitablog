/**
 * POST /api/comments/submit
 *
 * Endpoint proxy de submissao de comentarios. Faz:
 *   1. Le cookie reader_session — se logado via Facebook, sobrescreve
 *      authorName/authorEmail com dados do cookie (anti-tampering).
 *   2. Se anonimo, exige token Turnstile e valida via siteverify.
 *   3. Repassa o body modificado pro endpoint EmDash interno
 *      (/_emdash/api/comments/:collection/:contentId).
 *
 * Body esperado:
 *   {
 *     collection: "posts",
 *     contentId: "<ULID>",
 *     body: string,
 *     parentId?: string | null,
 *     authorName?: string,        // ignorado se logado
 *     authorEmail?: string,       // ignorado se logado
 *     website_url?: string,       // honeypot — passa adiante intacto
 *     turnstileToken?: string,    // obrigatorio pra anonimos
 *   }
 */

import type { APIRoute } from "astro";

import { decodeReaderSession, getReaderSessionCookie } from "../../../lib/reader-session";
import { verifyTurnstile } from "../../../lib/turnstile";
import { getWorkerEnv } from "../../../lib/worker-env";

export const prerender = false;

interface SubmitBody {
	collection?: unknown;
	contentId?: unknown;
	body?: unknown;
	parentId?: unknown;
	authorName?: unknown;
	authorEmail?: unknown;
	website_url?: unknown;
	turnstileToken?: unknown;
	readerToken?: unknown;
}


function jsonError(message: string, status: number, code = "VALIDATION_ERROR"): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export const POST: APIRoute = async ({ request, url }) => {
	const env = await getWorkerEnv();
	const readerSecret = env.READER_SESSION_SECRET;
	const turnstileSecret = env.TURNSTILE_SECRET_KEY;
	if (!readerSecret || !turnstileSecret) {
		return jsonError("Backend de comentarios nao configurado", 500, "CONFIG_ERROR");
	}

	let raw: SubmitBody;
	try {
		raw = (await request.json()) as SubmitBody;
	} catch {
		return jsonError("Corpo invalido", 400);
	}

	const collection = typeof raw.collection === "string" ? raw.collection : "";
	const contentId = typeof raw.contentId === "string" ? raw.contentId : "";
	const bodyText = typeof raw.body === "string" ? raw.body : "";
	const parentId = typeof raw.parentId === "string" ? raw.parentId : null;
	const websiteUrl = typeof raw.website_url === "string" ? raw.website_url : "";
	const turnstileToken = typeof raw.turnstileToken === "string" ? raw.turnstileToken : null;

	if (!collection || !contentId) {
		return jsonError("Faltam dados do artigo", 400);
	}
	if (!bodyText.trim()) {
		return jsonError("O comentario nao pode ficar vazio", 400);
	}

	// Le reader session: tenta cookie primeiro, body.readerToken como fallback.
	// Fallback existe porque alguns browsers (Chrome em certas condicoes) nao
	// enviam o cookie reader_session em fetch POST mesmo com credentials=
	// "include" + SameSite=Lax + same-origin. O form embeda o token via input
	// hidden quando o SSR detecta sessao valida.
	const cookieHeader = request.headers.get("cookie");
	const sessionCookie = getReaderSessionCookie(cookieHeader);
	const tokenFromBody = typeof raw.readerToken === "string" ? raw.readerToken : null;
	const tokenToTry = sessionCookie || tokenFromBody || undefined;
	const session = await decodeReaderSession(tokenToTry, readerSecret);

	let authorName: string;
	let authorEmail: string;

	if (session) {
		// Logado: dados do cookie (anti-tampering: ignora o que veio no form).
		// Email nao esta no cookie (privacidade + tamanho); usa placeholder
		// estavel por fbId — EmDash usa o email so pra moderation first_time.
		authorName = session.name;
		authorEmail = `fb-${session.fbId}@facebook.douravita.local`;
	} else {
		// Anonimo: exige Turnstile + valida campos manuais
		authorName = typeof raw.authorName === "string" ? raw.authorName.trim() : "";
		authorEmail = typeof raw.authorEmail === "string" ? raw.authorEmail.trim() : "";

		if (!authorName) return jsonError("Informe seu nome", 400);
		if (!authorEmail || !authorEmail.includes("@")) return jsonError("E-mail invalido", 400);

		// Skip Turnstile so quando o request veio pelo honeypot do bot
		// (o EmDash trata silenciosamente la na frente).
		if (!websiteUrl) {
			const ip = request.headers.get("cf-connecting-ip");
			const tsRes = await verifyTurnstile(turnstileToken, turnstileSecret, ip);
			if (!tsRes.success) {
				return jsonError(
					"Falha na verificacao anti-spam. Atualize a pagina e tente novamente.",
					400,
					"TURNSTILE_FAILED",
				);
			}
		}
	}

	// Monta o body pro EmDash. Mantemos honeypot intacto (se vier preenchido,
	// EmDash silently accepts — comportamento anti-bot esperado).
	const emdashBody = {
		collection,
		contentId,
		body: bodyText,
		parentId,
		authorName,
		authorEmail,
		website_url: websiteUrl,
	};

	// Subrequest interna pro endpoint EmDash. Cloudflare Workers serve do mesmo
	// isolate, com latencia sub-ms. Propagamos headers relevantes pra rate
	// limit / IP hash continuarem funcionando.
	const origin = url.origin;
	const target = `${origin}/_emdash/api/comments/${encodeURIComponent(collection)}/${encodeURIComponent(contentId)}`;

	const forwardHeaders = new Headers();
	forwardHeaders.set("Content-Type", "application/json");
	forwardHeaders.set("X-EmDash-Request", "1");
	for (const h of [
		"cf-connecting-ip",
		"x-forwarded-for",
		"x-real-ip",
		"user-agent",
		"accept-language",
	]) {
		const v = request.headers.get(h);
		if (v) forwardHeaders.set(h, v);
	}

	let upstream: Response;
	try {
		upstream = await fetch(target, {
			method: "POST",
			headers: forwardHeaders,
			body: JSON.stringify(emdashBody),
		});
	} catch {
		return jsonError("Erro de conexao com o backend", 502, "UPSTREAM_ERROR");
	}

	// Repassa o status e body do EmDash, traduzindo as mensagens que ficam em
	// EN ou ficam genericas demais.
	const upstreamText = await upstream.text();
	let upstreamJson: { data?: { status?: string; message?: string; id?: string }; error?: { code?: string; message?: string }; success?: boolean } | null = null;
	try {
		upstreamJson = upstreamText ? JSON.parse(upstreamText) : null;
	} catch {
		upstreamJson = null;
	}

	if (upstream.ok && upstreamJson?.data) {
		const status = upstreamJson.data.status;
		const message =
			status === "approved"
				? "Comentario publicado!"
				: "Comentario enviado! Apos aprovacao ele aparecera aqui.";
		return new Response(JSON.stringify({ success: true, status, message }), {
			status: upstream.status,
			headers: { "Content-Type": "application/json" },
		});
	}

	// Erros do EmDash (rate limit, comments_closed, validation, etc) — repassa
	// o codigo + mensagem original do EmDash, com fallback em PT.
	const emdashErrCode = upstreamJson?.error?.code ?? "UPSTREAM_ERROR";
	const emdashErrMsg = upstreamJson?.error?.message;
	const ptMessage =
		emdashErrCode === "RATE_LIMITED"
			? "Muitos comentarios em sequencia. Aguarde alguns minutos e tente novamente."
			: emdashErrCode === "COMMENTS_CLOSED"
				? "Os comentarios deste artigo foram encerrados."
				: emdashErrCode === "COMMENTS_DISABLED"
					? "Comentarios desativados pra esta secao."
					: emdashErrMsg || "Nao foi possivel enviar o comentario.";

	return new Response(JSON.stringify({ error: { code: emdashErrCode, message: ptMessage } }), {
		status: upstream.status || 500,
		headers: { "Content-Type": "application/json" },
	});
};
