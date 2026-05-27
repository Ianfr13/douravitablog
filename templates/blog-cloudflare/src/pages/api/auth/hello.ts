import type { APIRoute } from "astro";

export const prerender = false;

export const GET: APIRoute = () => {
	return new Response("hello", { status: 200, headers: { "Content-Type": "text/plain" } });
};
