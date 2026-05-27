/**
 * Helper centralizado pra ler variaveis de ambiente do Worker.
 *
 * Astro v6 removeu `Astro.locals.runtime.env`. O caminho oficial agora e
 * importar de `cloudflare:workers`. Mas esse modulo nao existe em build
 * Vite (dev/SSG), entao envolvemos num try/catch dinamico.
 *
 * Uso em endpoints (.ts) e components (.astro):
 *   import { getWorkerEnv } from "../../lib/worker-env";
 *   const env = await getWorkerEnv();
 *   const fbId = env.FACEBOOK_APP_ID; // string | undefined
 */

export interface WorkerEnv {
	FACEBOOK_APP_ID?: string;
	FACEBOOK_APP_SECRET?: string;
	READER_SESSION_SECRET?: string;
	TURNSTILE_SITE_KEY?: string;
	TURNSTILE_SECRET_KEY?: string;
	[key: string]: unknown;
}

let cached: WorkerEnv | null = null;

export async function getWorkerEnv(): Promise<WorkerEnv> {
	if (cached) return cached;
	try {
		// @ts-expect-error - cloudflare:workers e virtual module do CF runtime
		const mod = await import("cloudflare:workers");
		const env = (mod.env ?? {}) as WorkerEnv;
		cached = env;
		return env;
	} catch {
		// Build/dev fallback: nada disponivel
		cached = {};
		return cached;
	}
}
