import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	getOrCreateCookieSigningKey,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

/**
 * The authorization code is delivered to whatever redirect_uri survives
 * validation — the provider builds `new URL(redirectUri)` with the code
 * appended and redirects there. The provider only checks the URI against the
 * requesting client's OWN registered URIs, which an attacker controls, so this
 * allowlist is what actually decides where a code can land.
 *
 * Exact match only. Never startsWith or a host-prefix test: those are defeated
 * by claude.ai.evil.example and by claude.ai@evil.example.
 *
 * Configurable via the ALLOWED_REDIRECT_URIS worker secret/var (comma-separated,
 * exact-match URIs) — see README "Redirect URI allowlist". Unset falls back to
 * the two hardcoded URIs below: an absent setting must never mean "no
 * allowlist" (that would defeat the fix) or "reject everything" (that bricks
 * every existing deployment on upgrade). The security property — an unlisted
 * URI is refused — holds either way; only which URIs start out listed differs.
 */
const DEFAULT_ALLOWED_REDIRECT_URIS = [
	"https://claude.ai/api/mcp/auth_callback",
	"https://claude.com/api/mcp/auth_callback",
];

function getAllowedRedirectUris(env: CloudflareEnv): Set<string> {
	const raw = env.ALLOWED_REDIRECT_URIS;
	if (!raw) return new Set(DEFAULT_ALLOWED_REDIRECT_URIS);
	const uris = raw
		.split(",")
		.map((uri) => uri.trim())
		.filter(Boolean);
	return uris.length > 0 ? new Set(uris) : new Set(DEFAULT_ALLOWED_REDIRECT_URIS);
}

/**
 * Opt-in RFC 8252 loopback support, off by default. CLI clients such as
 * Claude Code build their redirect_uri as `http://localhost:<ephemeral
 * port>/callback` — a different port on every run — which an exact-match
 * allowlist can never express. Enable with ALLOW_LOOPBACK_REDIRECT="true".
 *
 * Parses the URL and checks protocol/hostname/pathname as distinct fields
 * rather than any prefix or substring test on the raw string; port is the
 * only field left unconstrained. This must never be loosened to accept a
 * non-loopback host.
 */
function isAllowedLoopbackRedirect(uri: string, env: CloudflareEnv): boolean {
	if (env.ALLOW_LOOPBACK_REDIRECT !== "true") return false;

	let parsed: URL;
	try {
		parsed = new URL(uri);
	} catch {
		return false;
	}

	if (parsed.protocol !== "http:") return false;
	if (!["127.0.0.1", "[::1]", "localhost"].includes(parsed.hostname)) return false;
	if (parsed.pathname !== "/callback") return false;

	return true;
}

function isAllowedRedirectUri(uri: string, env: CloudflareEnv): boolean {
	return getAllowedRedirectUris(env).has(uri) || isAllowedLoopbackRedirect(uri, env);
}

const REDIRECT_URI_REJECTION_MESSAGE =
	"redirect_uri not allowlisted — add it to the ALLOWED_REDIRECT_URIS setting (exact match, never a prefix).";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_SCOPES_READONLY = "https://www.googleapis.com/auth/drive.readonly email profile";
const GOOGLE_SCOPES_FULL = "https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file email profile";

const app = new Hono<{ Bindings: CloudflareEnv & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// The redirect_uri is the delivery address of the authorization code (see
	// completeAuthorization below); the provider only validates it against the
	// requesting client's own registered URIs, which an attacker controls.
	// Gate here so the owner never even sees a consent dialog for a client
	// whose code could not be delivered legitimately.
	if (!isAllowedRedirectUri(oauthReqInfo.redirectUri, c.env)) {
		console.warn(`Rejected redirect_uri at GET /authorize (not allowlisted): ${oauthReqInfo.redirectUri}`);
		return c.text(REDIRECT_URI_REJECTION_MESSAGE, 400);
	}

	// Always show the dialog so the user can choose the scope level
	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "Search, list, and download Google Drive files in their native format for Claude.",
			name: "MCP GDrive FileAccess",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();

		// Validate CSRF token
		validateCSRFToken(formData, c.req.raw);

		// Extract state from form data
		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		// state came from an attacker-suppliable, unsigned form field (atob +
		// JSON.parse above) — a forged state carrying a non-allowlisted
		// redirectUri would otherwise sail straight into createOAuthState and
		// get written to KV, with only the /callback gate left to catch it.
		// Same allowlist, same rejection, as GET /authorize.
		if (!isAllowedRedirectUri(state.oauthReqInfo.redirectUri, c.env)) {
			console.warn(`Rejected redirect_uri at POST /authorize (not allowlisted): ${state.oauthReqInfo.redirectUri}`);
			return c.text(REDIRECT_URI_REJECTION_MESSAGE, 400);
		}

		// Extract scope mode from form
		const scopeModeRaw = formData.get("scope_mode");
		const scopeMode: "readonly" | "memory" | "full" =
			scopeModeRaw === "readonly" ? "readonly" : scopeModeRaw === "memory" ? "memory" : "full";

		// Add client to approved list
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			await getOrCreateCookieSigningKey(c.env.OAUTH_KV),
		);

		// Create OAuth state and bind it to this user's session
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV, scopeMode);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);

		return redirectToGoogle(c.req.raw, c.env.GOOGLE_CLIENT_ID, stateToken, scopeMode, Object.fromEntries(headers));
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text(`Internal server error: ${error.message}`, 500);
	}
});

function redirectToGoogle(
	request: Request,
	googleClientId: string,
	stateToken: string,
	scopeMode: "readonly" | "memory" | "full" = "full",
	headers: Record<string, string> = {},
) {
	const scope = scopeMode === "readonly" ? GOOGLE_SCOPES_READONLY : GOOGLE_SCOPES_FULL;
	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				client_id: googleClientId,
				redirect_uri: new URL("/callback", request.url).href,
				scope,
				state: stateToken,
				upstream_url: GOOGLE_AUTH_URL,
			}),
		},
		status: 302,
	});
}

/**
 * OAuth Callback — Google returns with code, we exchange for tokens,
 * fetch user info, and complete the MCP authorization.
 */
app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let scopeMode: "readonly" | "memory" | "full";
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		scopeMode = result.scopeMode;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	// Belt to the /authorize gates' braces (both GET and POST /authorize carry
	// this same check): this guards the step that actually mints and delivers
	// the code (fetchUpstreamAuthToken below leads directly into
	// completeAuthorization's `new URL(oauthReqInfo.redirectUri)` redirect). A
	// bypass of either /authorize check must not be able to reach here.
	if (!isAllowedRedirectUri(oauthReqInfo.redirectUri, c.env)) {
		console.warn(`Rejected redirect_uri at /callback (not allowlisted): ${oauthReqInfo.redirectUri}`);
		return c.text(REDIRECT_URI_REJECTION_MESSAGE, 400);
	}

	// Exchange code for tokens
	const [tokens, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.GOOGLE_CLIENT_ID,
		client_secret: c.env.GOOGLE_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: GOOGLE_TOKEN_URL,
	});
	if (errResponse) return errResponse;

	// Fetch user info from Google
	const userInfoResp = await fetch(GOOGLE_USERINFO_URL, {
		headers: { Authorization: `Bearer ${tokens.access_token}` },
	});
	if (!userInfoResp.ok) {
		return c.text("Failed to fetch user info from Google", 500);
	}
	const userInfo = (await userInfoResp.json()) as {
		email?: string;
		name?: string;
	};

	// Whitelist check
	const whitelistUsers = c.env.WHITELIST_USERS;
	const whitelistDomains = c.env.WHITELIST_DOMAINS;
	if (whitelistUsers || whitelistDomains) {
		const email = (userInfo.email || "").toLowerCase();
		const domain = email.split("@")[1] || "";
		const allowedUsers = whitelistUsers ? whitelistUsers.split(",").map((u) => u.trim().toLowerCase()) : [];
		const allowedDomains = whitelistDomains ? whitelistDomains.split(",").map((d) => d.trim().toLowerCase()) : [];
		if (!allowedUsers.includes(email) && !allowedDomains.includes(domain)) {
			return c.text(`Access denied: ${userInfo.email} is not authorized to use this service.`, 403);
		}
	}

	// Complete authorization — store props in the MCP token
	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: userInfo.name || userInfo.email || "Google User",
		},
		props: {
			accessToken: tokens.access_token,
			email: userInfo.email || "",
			mode: scopeMode,
			name: userInfo.name || "",
			refreshToken: tokens.refresh_token || "",
		} as Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: userInfo.email || "unknown",
	});

	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}

	return new Response(null, { status: 302, headers });
});

// Favicon — helps Claude.ai (and browsers) show an icon for this MCP server
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="24" fill="#1a73e8"/>
  <path d="M40 38h30l22 22v36a6 6 0 0 1-6 6H46a6 6 0 0 1-6-6V38z" fill="#fff"/>
  <path d="M70 38l22 22H76a6 6 0 0 1-6-6V38z" fill="#a0c4ff"/>
  <rect x="50" y="70" width="28" height="4" rx="2" fill="#1a73e8"/>
  <rect x="50" y="80" width="20" height="4" rx="2" fill="#1a73e8"/>
</svg>`;

app.get("/favicon.ico", (c) => {
	return c.body(FAVICON_SVG, 200, {
		"Content-Type": "image/svg+xml",
		"Cache-Control": "public, max-age=604800",
	});
});

app.get("/favicon.svg", (c) => {
	return c.body(FAVICON_SVG, 200, {
		"Content-Type": "image/svg+xml",
		"Cache-Control": "public, max-age=604800",
	});
});

app.get("/blob/:id", async (c) => {
	const blobId = c.req.param("id");
	const { value, metadata } = await c.env.OAUTH_KV.getWithMetadata<{ mimeType: string; fileName: string }>(
		`blob:${blobId}`,
		"arrayBuffer",
	);

	if (!value || !metadata) {
		return c.text("Not found", 404);
	}

	// Delete after first download
	await c.env.OAUTH_KV.delete(`blob:${blobId}`);

	return new Response(value as ArrayBuffer, {
		headers: {
			"Content-Type": metadata.mimeType,
			"Content-Disposition": `attachment; filename="${metadata.fileName}"`,
		},
	});
});

export { app as GoogleHandler };
