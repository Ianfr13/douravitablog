/**
 * Mapa visual dos 12 pilares (categorias do EmDash).
 *
 * Source-of-truth dos SLUGS: EmDash (Worker Route /category/<slug>). 3 slugs
 * divergem do pilares.py canônico do pipeline Python — aqui usamos os do
 * EmDash, validados via curl 2026-05-23 (todos respondem 200).
 *
 * Visual (emoji + cor) mora aqui no tema pra evitar query extra e dar
 * autonomia ao frontend. Cor é hex puro; o componente PillarGrid combina
 * via color-mix(srgb, cor 18%, transparent) pra funcionar em light/dark mode.
 */

export interface PillarVisual {
	slug: string;
	label: string;
	emoji: string;
	color: string;
}

export const PILLARS: readonly PillarVisual[] = [
	{ slug: "suplementacao", label: "Suplementação", emoji: "💊", color: "#F5A623" },
	{ slug: "movimento", label: "Movimento", emoji: "🏃", color: "#4CAF50" },
	{ slug: "nutricao", label: "Nutrição", emoji: "🥗", color: "#FF7043" },
	{ slug: "saude-mental", label: "Saúde Mental", emoji: "🧠", color: "#7E57C2" },
	{ slug: "mulher-55", label: "Mulher 55+", emoji: "🌸", color: "#EC407A" },
	{ slug: "homem-55", label: "Homem 55+", emoji: "👨", color: "#3F87E0" },
	{ slug: "doencas-cronicas", label: "Doenças Crônicas", emoji: "❤️", color: "#E53935" },
	{ slug: "pele-e-estetica", label: "Pele, Cabelo e Dentes", emoji: "✨", color: "#D4A017" },
	{ slug: "vida-plena", label: "Vida Plena", emoji: "🌅", color: "#FB8C00" },
	{ slug: "ciencia", label: "Ciência", emoji: "🔬", color: "#26A69A" },
	{ slug: "cuidador", label: "Cuidador", emoji: "🤝", color: "#8D6E63" },
	{ slug: "noticias", label: "Notícias", emoji: "📰", color: "#546E7A" },
] as const;
