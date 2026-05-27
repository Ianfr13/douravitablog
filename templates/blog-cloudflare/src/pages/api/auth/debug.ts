/**
 * Debug endpoint pra inspecionar Astro.locals em prod. Remover apos
 * resolver o problema de env vars nao chegando no runtime.
 */

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const l = locals as unknown as Record<string, unknown>;
	const info: Record<string, unknown> = {
		localsKeys: Object.keys(l),
	};

	const runtime = l.runtime as Record<string, unknown> | undefined;
	if (runtime) {
		info.runtimeKeys = Object.keys(runtime);
		const env = runtime.env as Record<string, unknown> | undefined;
		if (env) {
			// So lista nomes — nao expoe values dos secrets
			info.envKeys = Object.keys(env);
			info.envFacebookAppIdType = typeof env.FACEBOOK_APP_ID;
			info.envFacebookAppIdValue = typeof env.FACEBOOK_APP_ID === "string"
				? (env.FACEBOOK_APP_ID as string).slice(0, 6) + "..."
				: null;
		} else {
			info.envKeys = "runtime.env is undefined";
		}
	} else {
		info.runtimeKeys = "runtime is undefined";
	}

	const emdash = l.emdash as Record<string, unknown> | undefined;
	if (emdash) {
		info.emdashKeys = Object.keys(emdash);
	}

	return new Response(JSON.stringify(info, null, 2), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
