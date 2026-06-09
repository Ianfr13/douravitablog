import type { APIRoute } from "astro";
import { getEmDashCollection, getSiteSettings } from "emdash";
import { resolveBlogSiteIdentity } from "../utils/site-identity";
import { PILLARS } from "../data/pilares-visual";

/**
 * llms.txt do blog Douravita.
 *
 * Padrão llmstxt.org: um índice em Markdown, na raiz do domínio, que dá a
 * assistentes de IA um mapa curado do conteúdo (quem somos, artigos, categorias,
 * ferramentas, páginas institucionais). Servido em /llms.txt (Worker Route) e
 * também em /blog/llms.txt (coberto pela route /blog* + BLOG_PREFIX_PATHS).
 *
 * Dinâmico (mesmo padrão do sitemap.xml.ts): puxa posts e pages do EmDash a cada
 * request, então artigo novo entra sozinho sem redeploy. Cache de edge curto é
 * aplicado pelo worker.ts (DEFAULT_CACHE_CONTROL).
 */

// Ferramentas são páginas estáticas (não vivem no EmDash). Espelha
// templates/.../pages/ferramentas/index.astro — manter em sync se mudar lá.
const FERRAMENTAS = [
	{
		slug: "sarcopenia",
		title: "Você está em risco de sarcopenia?",
		desc: "Quiz de triagem baseado no SARC-F (validado); resultado em 3 faixas de risco.",
	},
	{
		slug: "imc-55",
		title: "IMC ajustado para 55+",
		desc: "Calcula o IMC usando a faixa saudável adaptada para idosos (22–27, não a clássica 18.5–24.9).",
	},
	{
		slug: "proteina-diaria",
		title: "Proteína diária para 55+",
		desc: "Meta em gramas/dia + equivalente em ovos, frango, whey e outros alimentos.",
	},
	{
		slug: "idade-biologica",
		title: "Idade biológica vs cronológica",
		desc: "Estima a idade biológica a partir de 10 hábitos de estilo de vida (sono, dieta, exercício...).",
	},
] as const;

export const GET: APIRoute = async ({ site, url }) => {
	const origin = (site?.toString() || url.origin).replace(/\/$/, "");
	const blog = `${origin}/blog`;

	const [{ entries: posts }, { entries: pages }, settings] = await Promise.all([
		getEmDashCollection("posts", {
			orderBy: { published_at: "desc" },
			limit: 500,
		}),
		getEmDashCollection("pages", { limit: 100 }),
		getSiteSettings(),
	]);

	const { siteTitle, siteTagline } = resolveBlogSiteIdentity(settings);

	const lines: string[] = [];

	lines.push(`# ${oneLine(siteTitle)}`);
	lines.push("");
	if (siteTagline) {
		lines.push(`> ${oneLine(siteTagline)}`);
		lines.push("");
	}
	lines.push(
		"Blog de saúde, longevidade e bem-estar baseado em ciência, voltado para adultos 55+. " +
			"Os artigos passam por curadoria editorial (Curadoria Douravita) e citam fontes. " +
			"A DouraVita é uma marca brasileira de suplementos — a creatina monohidratada é o produto principal. " +
			"Todo o conteúdo é em português do Brasil e tem caráter educativo: não substitui avaliação médica.",
	);
	lines.push("");

	lines.push("## Páginas principais");
	lines.push("");
	lines.push(`- [Início do blog](${blog}): home com os artigos em destaque`);
	lines.push(`- [Todos os artigos](${blog}/posts): índice completo de artigos`);
	lines.push(`- [Categorias](${blog}/categorias): as ${PILLARS.length} áreas de cuidado do blog`);
	lines.push(`- [Ferramentas](${blog}/ferramentas): quiz e calculadoras gratuitas pra 55+`);
	lines.push(`- [Feed RSS](${blog}/rss.xml): feed de novos artigos`);
	lines.push("");

	lines.push("## Categorias");
	lines.push("");
	for (const pillar of PILLARS) {
		lines.push(`- [${oneLine(pillar.label)}](${blog}/category/${pillar.slug})`);
	}
	lines.push("");

	lines.push("## Artigos");
	lines.push("");
	for (const post of posts) {
		const slug = post.slug ?? post.data.slug ?? post.id;
		if (!slug) continue;
		const title = oneLine(post.data.title ?? "Sem título");
		const desc = oneLine(post.data.excerpt ?? post.data.description ?? "");
		const href = `${blog}/posts/${slug}`;
		lines.push(desc ? `- [${title}](${href}): ${desc}` : `- [${title}](${href})`);
	}
	lines.push("");

	lines.push("## Ferramentas");
	lines.push("");
	for (const tool of FERRAMENTAS) {
		lines.push(`- [${tool.title}](${blog}/ferramentas/${tool.slug}): ${tool.desc}`);
	}
	lines.push("");

	if (pages.length > 0) {
		lines.push("## Institucional");
		lines.push("");
		for (const page of pages) {
			const slug = page.data.slug ?? page.id;
			if (!slug) continue;
			const title = oneLine(page.data.title ?? String(slug));
			lines.push(`- [${title}](${blog}/pages/${slug})`);
		}
		lines.push("");
	}

	const body = `${lines.join("\n").trimEnd()}\n`;

	return new Response(body, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "public, max-age=3600",
		},
	});
};

/**
 * Colapsa whitespace/quebras de linha e corta o tamanho — cada item do llms.txt
 * tem que caber numa linha só. Remove colchetes pra não quebrar o link Markdown.
 */
function oneLine(value: unknown, max = 200): string {
	let s = String(value ?? "")
		.replace(/\s+/g, " ")
		.replace(/[[\]]/g, "")
		.trim();
	if (s.length > max) s = `${s.slice(0, max - 1).trimEnd()}…`;
	return s;
}
