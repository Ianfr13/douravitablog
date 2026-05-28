/**
 * SSR helper pra ler o agregado de votos do widget "Este conteúdo foi útil?".
 * Usado em posts/[slug].astro pra renderizar "X% acharam útil (N)" no load.
 *
 * Defensivo: se a tabela `post_feedback` ainda não existe (nenhum voto dado
 * no blog inteiro), retorna zeros em vez de quebrar o render. A tabela é
 * criada na primeira chamada de /api/feedback/submit.
 */

import { getWorkerEnv } from "./worker-env";

interface D1Database {
	prepare(query: string): {
		bind(...values: unknown[]): {
			first<T = unknown>(): Promise<T | null>;
		};
	};
}

export interface FeedbackCounts {
	yes: number;
	no: number;
	total: number;
	percent: number;
}

export async function getFeedbackCounts(contentId: string): Promise<FeedbackCounts> {
	const empty: FeedbackCounts = { yes: 0, no: 0, total: 0, percent: 0 };
	if (!contentId) return empty;
	try {
		const env = await getWorkerEnv();
		const DB = env.DB as D1Database | undefined;
		if (!DB) return empty;
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
	} catch {
		// Tabela ainda não existe ou DB indisponível — começa do zero.
		return empty;
	}
}
