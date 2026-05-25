/**
 * Mapa visual dos 12 pilares (categorias do EmDash).
 *
 * Source-of-truth dos SLUGS: EmDash (Worker Route /blog/category/<slug>). 3 slugs
 * divergem do pilares.py canônico do pipeline Python — aqui usamos os do
 * EmDash, validados via curl 2026-05-23 (todos respondem 200).
 *
 * Visual (emoji + cor) mora aqui no tema pra evitar query extra e dar
 * autonomia ao frontend. Cor é hex puro; o componente PillarGrid combina
 * via color-mix(srgb, cor 18%, transparent) pra funcionar em light/dark mode.
 *
 * `featured`: marca os 6 pilares que aparecem na home. Critério (2026-05-23):
 * volume atual de posts + posicionamento da marca + amplitude de interesse
 * 55+. A intenção é respeitar o limite cognitivo 7±2 (Miller) — mostrar 12
 * cards na home era sobrecarga pro público 55+. Os outros 6 continuam
 * funcionando normalmente em /blog/category/<slug> e ficam acessíveis via página
 * /blog/categorias.
 */

export interface PillarVisual {
	slug: string;
	label: string;
	emoji: string;
	color: string;
	/** Se true, aparece na home. Se false/ausente, só em /blog/categorias. */
	featured?: boolean;
}

export const PILLARS: readonly PillarVisual[] = [
	{ slug: "suplementacao", label: "Suplementos pra 55+", emoji: "💊", color: "#F5A623", featured: true },
	{ slug: "movimento", label: "Movimento e exercício", emoji: "🏃", color: "#4CAF50", featured: true },
	{ slug: "cuidador", label: "Cuidando de pai e mãe", emoji: "🤝", color: "#8D6E63", featured: true },
	{ slug: "saude-mental", label: "Memória e mente", emoji: "🧠", color: "#7E57C2", featured: true },
	{ slug: "doencas-cronicas", label: "Doenças crônicas", emoji: "❤️", color: "#E53935", featured: true },
	{ slug: "vida-plena", label: "Vida plena depois dos 55", emoji: "🌅", color: "#FB8C00", featured: true },
	{ slug: "nutricao", label: "Nutrição e alimentação", emoji: "🥗", color: "#FF7043" },
	{ slug: "mulher-55", label: "Pra mulher 55+", emoji: "🌸", color: "#EC407A" },
	{ slug: "homem-55", label: "Pra homem 55+", emoji: "👨", color: "#3F87E0" },
	{ slug: "pele-e-estetica", label: "Pele, cabelo e dentes", emoji: "✨", color: "#D4A017" },
	{ slug: "ciencia", label: "Ciência da longevidade", emoji: "🔬", color: "#26A69A" },
	{ slug: "noticias", label: "Notícias de saúde", emoji: "📰", color: "#546E7A" },
] as const;

export const FEATURED_PILLARS = PILLARS.filter((p) => p.featured);
