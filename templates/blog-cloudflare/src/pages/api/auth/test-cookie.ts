/**
 * GET /blog/api/auth/test-cookie
 *
 * Endpoint debug: seta um cookie reader_session=probe123 minimo com mesmos
 * atributos do real. Se o cookie nao persiste no browser apos isso, o problema
 * eh middleware/proxy stripando Set-Cookie. Se persiste, problema eh com o
 * value real do cookie do callback.
 *
 * Remover apos diagnostico.
 */

import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = () => {
	return new Response(
		JSON.stringify({
			message: "Cookie 'reader_session' setado pra 'probe123'. Vai em Application > Cookies e confirma se aparece.",
		}),
		{
			status: 200,
			headers: {
				"Content-Type": "application/json",
				"Set-Cookie": "reader_session=probe123; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax",
				"Cache-Control": "no-store",
			},
		},
	);
};
