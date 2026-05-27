/**
 * Debug endpoint pra inspecionar Astro.locals em prod. Remover apos
 * resolver o problema de env vars nao chegando no runtime.
 */

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	try {
		const info: Record<string, unknown> = { stage: "start" };
		const l = locals as unknown as Record<string, unknown>;
		info.stage = "got locals";
		info.localsKeys = Object.keys(l);

		try {
			const runtime = l.runtime as Record<string, unknown> | undefined;
			info.stage = "got runtime";
			if (runtime) {
				info.runtimeKeys = Object.keys(runtime);
				const env = runtime.env as Record<string, unknown> | undefined;
				if (env) {
					info.envKeys = Object.keys(env).sort();
					info.fbAppIdPresent = typeof env.FACEBOOK_APP_ID === "string";
				} else {
					info.envKeys = "runtime.env is undefined";
				}
			} else {
				info.runtimeKeys = "runtime is undefined";
			}
		} catch (err) {
			info.runtimeErr = err instanceof Error ? err.message : String(err);
		}

		return new Response(JSON.stringify(info, null, 2), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	} catch (err) {
		return new Response(
			"crash: " + (err instanceof Error ? err.message + "\n" + (err.stack || "") : String(err)),
			{ status: 500, headers: { "Content-Type": "text/plain" } },
		);
	}
};
