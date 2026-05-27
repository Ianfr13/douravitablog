/**
 * POST /api/comments/submit
 *
 * Submissao de comentarios pra `_emdash_comments` direto via D1 binding.
 *
 * Por que nao subrequest pro endpoint EmDash:
 *   Fetch interno `${origin}/_emdash/api/comments/<col>/<id>` retornou 405
 *   no Worker em prod (problema de routing recursivo do CF Workers, nao
 *   identificado direito). Bypass + INSERT direto eh mais robusto.
 *
 * Fluxo:
 *   1. Le cookie reader_session ou body.readerToken (fallback do Chrome
 *      que descarta cookie em POST). Se valido -> identifica leitor.
 *   2. Se anonimo -> exige Turnstile.
 *   3. INSERT na _emdash_comments com status='pending' (Ian aprova no
 *      admin EmDash).
 *
 * Trade-off: nao roda hooks `comment:beforeCreate` / `comment:moderate` /
 * `comment:afterCreate` do EmDash. Como nao usamos plugins desses, OK.
 * Rate limit + first_time moderation podem ser re-introduzidos depois
 * via lookup direto na D1.
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

interface D1Database {
	prepare(query: string): {
		bind(...values: unknown[]): {
			run(): Promise<unknown>;
			first<T = unknown>(): Promise<T | null>;
			all<T = unknown>(): Promise<{ results: T[] }>;
		};
		first<T = unknown>(): Promise<T | null>;
	};
}

function jsonError(message: string, status: number, code = "VALIDATION_ERROR"): Response {
	return new Response(JSON.stringify({ error: { code, message } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** Gera um identificador unico curto (UUID v4 do CF runtime). */
function newId(): string {
	return crypto.randomUUID();
}

/** SHA-256(ip + salt) -> hex 16 chars (irreversivel, p anti-spam buckets). */
async function hashIp(ip: string, salt: string): Promise<string> {
	const data = new TextEncoder().encode(ip + salt);
	const digest = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < 8; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
	return hex;
}

export const POST: APIRoute = async ({ request }) => {
	const env = await getWorkerEnv();
	const readerSecret = env.READER_SESSION_SECRET as string | undefined;
	const turnstileSecret = env.TURNSTILE_SECRET_KEY as string | undefined;
	const DB = env.DB as D1Database | undefined;
	if (!readerSecret || !turnstileSecret || !DB) {
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
	const bodyText = typeof raw.body === "string" ? raw.body.trim() : "";
	const parentId = typeof raw.parentId === "string" ? raw.parentId : null;
	const websiteUrl = typeof raw.website_url === "string" ? raw.website_url : "";
	const turnstileToken = typeof raw.turnstileToken === "string" ? raw.turnstileToken : null;

	if (!collection || !contentId) {
		return jsonError("Faltam dados do artigo", 400);
	}
	if (!bodyText) {
		return jsonError("O comentario nao pode ficar vazio", 400);
	}
	if (bodyText.length > 5000) {
		return jsonError("O comentario eh muito longo (limite 5000 caracteres)", 400);
	}

	// Honeypot: se preenchido, eh bot. Aceita silenciosamente sem salvar.
	if (websiteUrl) {
		return new Response(
			JSON.stringify({ success: true, status: "pending", message: "Comentario enviado!" }),
			{ status: 201, headers: { "Content-Type": "application/json" } },
		);
	}

	// Identificacao do autor: cookie -> body.readerToken -> form anonimo
	const cookieHeader = request.headers.get("cookie");
	const sessionCookie = getReaderSessionCookie(cookieHeader);
	const tokenFromBody = typeof raw.readerToken === "string" ? raw.readerToken : null;
	const tokenToTry = sessionCookie || tokenFromBody || undefined;
	const session = await decodeReaderSession(tokenToTry, readerSecret);

	let authorName: string;
	let authorEmail: string;

	if (session) {
		authorName = session.name;
		authorEmail = `fb-${session.fbId}@facebook.douravita.local`;
	} else {
		authorName = typeof raw.authorName === "string" ? raw.authorName.trim() : "";
		authorEmail = typeof raw.authorEmail === "string" ? raw.authorEmail.trim() : "";

		if (!authorName) return jsonError("Informe seu nome", 400);
		if (!authorEmail || !authorEmail.includes("@")) return jsonError("E-mail invalido", 400);
		if (authorName.length > 100) authorName = authorName.slice(0, 100);

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

	// Resolve content_id real: cliente pode mandar o slug ou o ULID.
	// Tabela: ec_posts tem coluna id (ULID) e slug. Aceita qualquer um.
	let resolvedContentId = contentId;
	if (collection === "posts") {
		try {
			const row = await DB.prepare(
				"SELECT id FROM ec_posts WHERE (id = ? OR slug = ?) AND status = 'published' AND deleted_at IS NULL LIMIT 1",
			)
				.bind(contentId, contentId)
				.first<{ id: string }>();
			if (!row) return jsonError("Artigo nao encontrado", 404, "NOT_FOUND");
			resolvedContentId = row.id;
		} catch {
			// Fall through — se DB query falha, segue com contentId como veio
		}
	}

	// Valida parent (se houver)
	let resolvedParentId: string | null = null;
	if (parentId) {
		try {
			const parent = await DB.prepare(
				"SELECT id, parent_id FROM _emdash_comments WHERE id = ? AND collection = ? AND content_id = ? LIMIT 1",
			)
				.bind(parentId, collection, resolvedContentId)
				.first<{ id: string; parent_id: string | null }>();
			if (!parent) return jsonError("Comentario pai nao encontrado", 400);
			// 1 nivel de thread: se parent ja eh reply, attach a raiz
			resolvedParentId = parent.parent_id ?? parent.id;
		} catch {
			// Ignora erro de parent, vira top-level
		}
	}

	const ip = request.headers.get("cf-connecting-ip") || "unknown";
	const userAgent = (request.headers.get("user-agent") || "").slice(0, 500);
	const ipHash = await hashIp(ip, readerSecret);
	const id = newId();
	const now = new Date().toISOString();
	// Logados via Facebook entram como approved direto (trust). Anonimos sempre
	// pending pra moderar — Ian aprova no admin /_emdash.
	const status = session ? "approved" : "pending";

	try {
		await DB.prepare(
			`INSERT INTO _emdash_comments
       (id, collection, content_id, parent_id, author_name, author_email,
        author_user_id, body, status, ip_hash, user_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				id,
				collection,
				resolvedContentId,
				resolvedParentId,
				authorName,
				authorEmail,
				bodyText,
				status,
				ipHash,
				userAgent,
				now,
				now,
			)
			.run();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return new Response(
			JSON.stringify({ error: { code: "DB_ERROR", message: "Erro salvando comentario: " + msg.slice(0, 100) } }),
			{ status: 500, headers: { "Content-Type": "application/json" } },
		);
	}

	const message =
		status === "approved"
			? "Comentario publicado!"
			: "Comentario enviado! Apos aprovacao ele aparecera aqui.";
	return new Response(JSON.stringify({ success: true, status, message, id }), {
		status: 201,
		headers: { "Content-Type": "application/json" },
	});
};
