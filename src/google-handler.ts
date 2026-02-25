import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from "./utils";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	getOrCreateCookieSigningKey,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";
const GOOGLE_SCOPES = "https://www.googleapis.com/auth/drive.readonly email profile";

const app = new Hono<{ Bindings: CloudflareEnv & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// Check if client is already approved
	if (await isClientApproved(c.req.raw, clientId, await getOrCreateCookieSigningKey(c.env.OAUTH_KV))) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		return redirectToGoogle(c.req.raw, c.env.GOOGLE_CLIENT_ID, stateToken, { "Set-Cookie": sessionBindingCookie });
	}

	// Generate CSRF protection for the approval form
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

		// Add client to approved list
		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			await getOrCreateCookieSigningKey(c.env.OAUTH_KV),
		);

		// Create OAuth state and bind it to this user's session
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);

		return redirectToGoogle(c.req.raw, c.env.GOOGLE_CLIENT_ID, stateToken, Object.fromEntries(headers));
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
	headers: Record<string, string> = {},
) {
	return new Response(null, {
		headers: {
			...headers,
			location: getUpstreamAuthorizeUrl({
				client_id: googleClientId,
				redirect_uri: new URL("/callback", request.url).href,
				scope: GOOGLE_SCOPES,
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
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
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
