/**
 * POST /api/feedback/submit
 *
 * Voto do widget "Este conteúdo foi útil?" (Sim/Não) — grava direto na D1.
 * Mesmo padrão do /api/comments/submit (INSERT direto via binding, sem
 * subrequest pro EmDash).
 *
 * Tabela `post_feedback` é auto-criada na primeira chamada (CREATE TABLE IF
 * NOT EXISTS) — não depende de migração do EmDash. 1 voto por IP por artigo
 * (UNIQUE content_id+ip_hash; revotar atualiza o valor).
 *
 * Retorna o agregado atualizado { yes, no, total, percent } pra o cliente
 * mostrar "X% acharam útil (N avaliações)".
 */

import type { APIRoute } from "astro";

import { getWorkerEnv } from "../../../lib/worker-env";

export const prerender = false;

interface D1Database {
	prepare(query: string): {
		bind(...values: unknown[]): {
			run(): Promise<unknown>;
			first<T = unknown>(): Promise<T | null>;
		};
		run(): Promise<unknown>;
		first<T = unknown>(): Promise<T | null>;
	};
}

interface SubmitBody {
	contentId?: unknown;
	helpful?: unknown;
}

function json(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function jsonError(message: string, status: number, code = "VALIDATION_ERROR"): Response {
	return json({ error: { code, message } }, status);
}

/** SHA-256(ip + salt) -> hex 16 chars (irreversível, anti-spam bucket). */
async function hashIp(ip: string, salt: string): Promise<string> {
	const data = new TextEncoder().encode(ip + salt);
	const digest = await crypto.subtle.digest("SHA-256", data);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (let i = 0; i < 8; i++) hex += bytes[i]!.toString(16).padStart(2, "0");
	return hex;
}

async function ensureTable(DB: D1Database): Promise<void> {
	await DB.prepare(
		`CREATE TABLE IF NOT EXISTS post_feedback (
			id TEXT PRIMARY KEY,
			content_id TEXT NOT NULL,
			helpful INTEGER NOT NULL,
			ip_hash TEXT NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE(content_id, ip_hash)
		)`,
	).run();
}

async function aggregate(
	DB: D1Database,
	contentId: string,
): Promise<{ yes: number; no: number; total: number; percent: number }> {
	const row = await DB.prepare(
		`SELECT
			SUM(CASE WHEN helpful = 1 THEN 1 ELSE 0 END) AS yes,
			SUM(CASE WHEN helpful = 0 THEN 1 ELSE 0 END) AS no
		 FROM post_feedback WHERE content_id = ?`,
	)
		.bind(contentId)
		.first<{ yes: number | null; no: number | null }>();
	const yes = Number(row?.yes ?? 0);
	const no = Number(row?.no ?? 0);
	const total = yes + no;
	const percent = total > 0 ? Math.round((yes / total) * 100) : 0;
	return { yes, no, total, percent };
}

export const POST: APIRoute = async ({ request }) => {
	const env = await getWorkerEnv();
	const DB = env.DB as D1Database | undefined;
	const salt = (env.READER_SESSION_SECRET as string | undefined) || "douravita-feedback";
	if (!DB) {
		return jsonError("Backend de feedback não configurado", 500, "CONFIG_ERROR");
	}

	let raw: SubmitBody;
	try {
		raw = (await request.json()) as SubmitBody;
	} catch {
		return jsonError("Corpo inválido", 400);
	}

	const contentId = typeof raw.contentId === "string" ? raw.contentId : "";
	const helpful = raw.helpful === true || raw.helpful === 1 || raw.helpful === "1" ? 1 : 0;
	if (!contentId) {
		return jsonError("Falta o id do artigo", 400);
	}

	const ip = request.headers.get("cf-connecting-ip") || "unknown";
	const ipHash = await hashIp(ip, salt);
	const now = new Date().toISOString();
	const id = crypto.randomUUID();

	try {
		await ensureTable(DB);
		// 1 voto por IP por artigo; revotar troca o valor (ON CONFLICT).
		await DB.prepare(
			`INSERT INTO post_feedback (id, content_id, helpful, ip_hash, created_at)
			 VALUES (?, ?, ?, ?, ?)
			 ON CONFLICT(content_id, ip_hash)
			 DO UPDATE SET helpful = excluded.helpful, created_at = excluded.created_at`,
		)
			.bind(id, contentId, helpful, ipHash, now)
			.run();
		const agg = await aggregate(DB, contentId);
		return json({ success: true, ...agg }, 201);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return jsonError("Erro salvando avaliação: " + msg.slice(0, 120), 500, "DB_ERROR");
	}
};
