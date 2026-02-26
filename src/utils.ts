/**
 * Constructs an authorization URL for Google OAuth.
 */
export function getUpstreamAuthorizeUrl({
	upstream_url,
	client_id,
	scope,
	redirect_uri,
	state,
}: {
	upstream_url: string;
	client_id: string;
	scope: string;
	redirect_uri: string;
	state?: string;
}) {
	const upstream = new URL(upstream_url);
	upstream.searchParams.set("client_id", client_id);
	upstream.searchParams.set("redirect_uri", redirect_uri);
	upstream.searchParams.set("scope", scope);
	upstream.searchParams.set("response_type", "code");
	upstream.searchParams.set("access_type", "offline");
	upstream.searchParams.set("prompt", "consent");
	upstream.searchParams.set("include_granted_scopes", "true");
	if (state) upstream.searchParams.set("state", state);
	return upstream.href;
}

/**
 * Exchanges authorization code for Google tokens.
 * Google returns JSON (not form data like GitHub).
 */
export async function fetchUpstreamAuthToken({
	client_id,
	client_secret,
	code,
	redirect_uri,
	upstream_url,
}: {
	code: string | undefined;
	upstream_url: string;
	client_secret: string;
	redirect_uri: string;
	client_id: string;
}): Promise<[{ access_token: string; refresh_token?: string }, null] | [null, Response]> {
	if (!code) {
		return [null, new Response("Missing code", { status: 400 })];
	}

	const resp = await fetch(upstream_url, {
		body: new URLSearchParams({
			client_id,
			client_secret,
			code,
			redirect_uri,
			grant_type: "authorization_code",
		}).toString(),
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
		},
		method: "POST",
	});

	if (!resp.ok) {
		console.error("Token exchange failed:", await resp.text());
		return [null, new Response("Failed to fetch access token", { status: 500 })];
	}

	const body = (await resp.json()) as {
		access_token?: string;
		refresh_token?: string;
	};

	if (!body.access_token) {
		return [null, new Response("Missing access token in response", { status: 400 })];
	}

	return [{ access_token: body.access_token, refresh_token: body.refresh_token }, null];
}

/**
 * Uses a refresh token to obtain a new Google access token.
 */
export async function refreshAccessToken({
	client_id,
	client_secret,
	refresh_token,
}: {
	client_id: string;
	client_secret: string;
	refresh_token: string;
}): Promise<string> {
	const resp = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id,
			client_secret,
			refresh_token,
			grant_type: "refresh_token",
		}).toString(),
	});

	if (!resp.ok) {
		const text = await resp.text();
		throw new Error(`Token refresh failed (${resp.status}): ${text}`);
	}

	const body = (await resp.json()) as { access_token?: string };
	if (!body.access_token) {
		throw new Error("No access_token in refresh response");
	}

	return body.access_token;
}

export type Props = {
	email: string;
	name: string;
	accessToken: string;
	refreshToken: string;
};
