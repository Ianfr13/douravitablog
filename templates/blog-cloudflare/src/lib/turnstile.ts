/**
 * Cloudflare Turnstile — wrapper do endpoint siteverify.
 *
 * Usado pra validar comentarios ANONIMOS (leitor nao logado com Facebook).
 * Leitores autenticados pulam o CAPTCHA (cookie HMAC ja prova que eh humano).
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface TurnstileVerifyResult {
	success: boolean;
	errorCodes: string[];
	hostname?: string;
	action?: string;
	cdata?: string;
}

/**
 * Valida um token Turnstile.
 *
 * @param token  Valor de `cf-turnstile-response` que o widget colocou no form
 * @param secret Secret key (encrypted secret do Worker)
 * @param ip     IP do request (opcional, fortalece a verificacao)
 */
export async function verifyTurnstile(
	token: string | null | undefined,
	secret: string,
	ip?: string | null,
): Promise<TurnstileVerifyResult> {
	if (!token) {
		return { success: false, errorCodes: ["missing-input-response"] };
	}

	const formData = new FormData();
	formData.append("secret", secret);
	formData.append("response", token);
	if (ip) formData.append("remoteip", ip);

	let res: Response;
	try {
		res = await fetch(SITEVERIFY_URL, { method: "POST", body: formData });
	} catch {
		return { success: false, errorCodes: ["network-error"] };
	}

	if (!res.ok) {
		return { success: false, errorCodes: [`http-${res.status}`] };
	}

	const data = (await res.json().catch(() => ({}))) as {
		success?: boolean;
		"error-codes"?: string[];
		hostname?: string;
		action?: string;
		cdata?: string;
	};

	return {
		success: data.success === true,
		errorCodes: data["error-codes"] ?? [],
		hostname: data.hostname,
		action: data.action,
		cdata: data.cdata,
	};
}
