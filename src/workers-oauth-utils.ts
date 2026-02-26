/**
 * OAuth utility functions for Cloudflare Workers.
 * Based on the Cloudflare AI demos template.
 * Handles CSRF protection, state management, session binding, and approval dialog.
 */

import type { AuthRequest } from "@cloudflare/workers-oauth-provider";

// --- Error Handling ---

export class OAuthError extends Error {
	status: number;
	constructor(message: string, status = 400) {
		super(message);
		this.status = status;
	}
	toResponse() {
		return new Response(this.message, { status: this.status });
	}
}

// --- CSRF Protection ---

export function generateCSRFProtection(): { token: string; setCookie: string } {
	const token = crypto.randomUUID();
	const cookieName = "__Host-CSRF_TOKEN";
	const setCookie = `${cookieName}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict`;
	return { token, setCookie };
}

export function validateCSRFToken(formData: FormData, request: Request): void {
	const cookieName = "__Host-CSRF_TOKEN";
	const formToken = formData.get("csrf_token");
	if (!formToken || typeof formToken !== "string") {
		throw new OAuthError("Missing CSRF token in form", 403);
	}
	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) {
		throw new OAuthError("Missing CSRF cookie", 403);
	}
	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const csrfCookie = cookies.find((c) => c.startsWith(`${cookieName}=`));
	if (!csrfCookie) {
		throw new OAuthError("Missing CSRF cookie", 403);
	}
	const cookieToken = csrfCookie.substring(cookieName.length + 1);
	if (formToken !== cookieToken) {
		throw new OAuthError("CSRF token mismatch", 403);
	}
}

// --- OAuth State Management ---

export async function createOAuthState(
	oauthReqInfo: AuthRequest,
	kv: KVNamespace,
	scopeMode: "readonly" | "memory" | "full" = "full",
): Promise<{ stateToken: string }> {
	const stateToken = crypto.randomUUID();
	await kv.put(
		`oauth_state:${stateToken}`,
		JSON.stringify({ oauthReqInfo, scopeMode }),
		{ expirationTtl: 600 }, // 10 minutes
	);
	return { stateToken };
}

export async function validateOAuthState(
	request: Request,
	kv: KVNamespace,
): Promise<{ oauthReqInfo: AuthRequest; scopeMode: "readonly" | "memory" | "full"; clearCookie: string }> {
	const url = new URL(request.url);
	const stateToken = url.searchParams.get("state");

	if (!stateToken) {
		throw new OAuthError("Missing state parameter");
	}

	// Validate session binding cookie
	const cookieName = "__Host-CONSENTED_STATE";
	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) {
		throw new OAuthError("Missing session cookie", 403);
	}
	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const sessionCookie = cookies.find((c) => c.startsWith(`${cookieName}=`));
	if (!sessionCookie) {
		throw new OAuthError("Missing session binding cookie", 403);
	}
	const cookieState = sessionCookie.substring(cookieName.length + 1);
	if (cookieState !== stateToken) {
		throw new OAuthError("State mismatch: session binding failed", 403);
	}

	// Validate KV state
	const stored = await kv.get(`oauth_state:${stateToken}`);
	if (!stored) {
		throw new OAuthError("Invalid or expired state token");
	}
	await kv.delete(`oauth_state:${stateToken}`);

	// Backward compat: old format stored just the AuthRequest directly
	const parsed = JSON.parse(stored);
	let oauthReqInfo: AuthRequest;
	let scopeMode: "readonly" | "memory" | "full" = "full";
	if (parsed.oauthReqInfo) {
		oauthReqInfo = parsed.oauthReqInfo;
		scopeMode = parsed.scopeMode || "full";
	} else {
		oauthReqInfo = parsed as AuthRequest;
	}

	// Clear session cookie
	const clearCookie = `${cookieName}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

	return { oauthReqInfo, scopeMode, clearCookie };
}

// --- Session Binding ---

export async function bindStateToSession(
	stateToken: string,
): Promise<{ setCookie: string }> {
	const cookieName = "__Host-CONSENTED_STATE";
	const setCookie = `${cookieName}=${stateToken}; Path=/; HttpOnly; Secure; SameSite=Lax`;
	return { setCookie };
}

// --- Client Approval Tracking ---

export async function isClientApproved(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<boolean> {
	const approved = await getApprovedClientsFromCookie(request, cookieSecret);
	return approved !== null && approved.includes(clientId);
}

export async function addApprovedClient(
	request: Request,
	clientId: string,
	cookieSecret: string,
): Promise<string> {
	const existing = (await getApprovedClientsFromCookie(request, cookieSecret)) || [];
	if (!existing.includes(clientId)) {
		existing.push(clientId);
	}

	const payload = JSON.stringify(existing);
	const signature = await signData(payload, cookieSecret);
	const cookieValue = `${signature}.${btoa(payload)}`;
	const cookieName = "__Host-APPROVED_CLIENTS";
	return `${cookieName}=${cookieValue}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
}

// --- Approval Dialog ---

function sanitizeText(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

function sanitizeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (!["http:", "https:"].includes(parsed.protocol)) return "";
		return parsed.href;
	} catch {
		return "";
	}
}

export function renderApprovalDialog(
	request: Request,
	options: {
		client: any;
		csrfToken: string;
		server: { name: string; description?: string; logo?: string };
		setCookie: string;
		state: { oauthReqInfo: AuthRequest };
	},
): Response {
	const { client, csrfToken, server, setCookie, state } = options;
	const encodedState = btoa(JSON.stringify(state));

	const serverName = sanitizeText(server.name);
	const serverDescription = server.description ? sanitizeText(server.description) : "";
	const clientName = client?.clientName ? sanitizeText(client.clientName) : "Unknown Client";
	const logoUrl = server.logo ? sanitizeText(sanitizeUrl(server.logo)) : "";

	const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${clientName} | Authorization Request</title>
        <style>
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.6;
            color: #333;
            background-color: #f9fafb;
            margin: 0;
            padding: 0;
          }
          .container { max-width: 600px; margin: 2rem auto; padding: 1rem; }
          .precard { padding: 2rem; text-align: center; }
          .card {
            background: #fff;
            border-radius: 8px;
            box-shadow: 0 8px 36px 8px rgba(0,0,0,0.1);
            padding: 2rem;
          }
          .header { display: flex; align-items: center; justify-content: center; margin-bottom: 1.5rem; }
          .logo { width: 48px; height: 48px; margin-right: 1rem; border-radius: 8px; object-fit: contain; }
          .title { margin: 0; font-size: 1.3rem; font-weight: 400; }
          .alert { font-size: 1.5rem; font-weight: 400; margin: 1rem 0; text-align: center; }
          .actions { display: flex; justify-content: flex-end; gap: 1rem; margin-top: 2rem; }
          .button { padding: 0.75rem 1.5rem; border-radius: 6px; font-weight: 500; cursor: pointer; border: none; font-size: 1rem; }
          .button-primary { background-color: #0070f3; color: white; }
          .button-secondary { background-color: transparent; border: 1px solid #e5e7eb; color: #333; }
          .scope-choice { margin: 1.5rem 0; }
          .scope-choice legend { font-weight: 500; margin-bottom: 0.75rem; font-size: 0.95rem; }
          .scope-option { display: flex; align-items: flex-start; gap: 0.5rem; margin-bottom: 0.75rem; padding: 0.75rem; border: 1px solid #e5e7eb; border-radius: 6px; cursor: pointer; }
          .scope-option:has(input:checked) { border-color: #0070f3; background-color: #f0f7ff; }
          .scope-option input { margin-top: 0.2rem; }
          .scope-option-text { flex: 1; }
          .scope-option-label { font-weight: 500; display: block; }
          .scope-option-desc { font-size: 0.85rem; color: #666; margin-top: 0.15rem; display: block; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="precard">
            <div class="header">
              ${logoUrl ? `<img src="${logoUrl}" alt="${serverName} Logo" class="logo">` : ""}
              <h1 class="title"><strong>${serverName}</strong></h1>
            </div>
            ${serverDescription ? `<p>${serverDescription}</p>` : ""}
          </div>
          <div class="card">
            <h2 class="alert"><strong>${clientName}</strong> is requesting access</h2>
            <p>This MCP Client is requesting to be authorized on ${serverName}. If you approve, you will be redirected to sign in with Google.</p>
            <form method="post" action="${new URL(request.url).pathname}">
              <input type="hidden" name="state" value="${encodedState}">
              <input type="hidden" name="csrf_token" value="${csrfToken}">
              <fieldset class="scope-choice">
                <legend>Choose access level:</legend>
                <label class="scope-option">
                  <input type="radio" name="scope_mode" value="readonly" checked>
                  <span class="scope-option-text">
                    <span class="scope-option-label">Read-only</span>
                    <span class="scope-option-desc">Search, list, and download files. No write access to Google Drive.</span>
                  </span>
                </label>
                <label class="scope-option">
                  <input type="radio" name="scope_mode" value="memory">
                  <span class="scope-option-text">
                    <span class="scope-option-label">Read + Memory</span>
                    <span class="scope-option-desc">Read-only plus shared AI memory (read/write files in an AI/Claude folder on your Drive).</span>
                  </span>
                </label>
                <label class="scope-option">
                  <input type="radio" name="scope_mode" value="full">
                  <span class="scope-option-text">
                    <span class="scope-option-label">Read + Memory + Upload</span>
                    <span class="scope-option-desc">All of the above, plus upload new files to any folder. Cannot overwrite existing files.</span>
                  </span>
                </label>
              </fieldset>
              <div class="actions">
                <button type="button" class="button button-secondary" onclick="window.history.back()">Cancel</button>
                <button type="submit" class="button button-primary">Approve</button>
              </div>
            </form>
          </div>
        </div>
      </body>
    </html>
  `;

	return new Response(htmlContent, {
		headers: {
			"Content-Security-Policy": "frame-ancestors 'none'",
			"Content-Type": "text/html; charset=utf-8",
			"Set-Cookie": setCookie,
			"X-Frame-Options": "DENY",
		},
	});
}

// --- Helper Functions ---

async function getApprovedClientsFromCookie(
	request: Request,
	cookieSecret: string,
): Promise<string[] | null> {
	const cookieName = "__Host-APPROVED_CLIENTS";
	const cookieHeader = request.headers.get("Cookie");
	if (!cookieHeader) return null;

	const cookies = cookieHeader.split(";").map((c) => c.trim());
	const targetCookie = cookies.find((c) => c.startsWith(`${cookieName}=`));
	if (!targetCookie) return null;

	const cookieValue = targetCookie.substring(cookieName.length + 1);
	const parts = cookieValue.split(".");
	if (parts.length !== 2) return null;

	const [signatureHex, base64Payload] = parts;
	const payload = atob(base64Payload);
	const isValid = await verifySignature(signatureHex, payload, cookieSecret);
	if (!isValid) return null;

	try {
		const approvedClients = JSON.parse(payload);
		if (!Array.isArray(approvedClients) || !approvedClients.every((item) => typeof item === "string")) {
			return null;
		}
		return approvedClients;
	} catch {
		return null;
	}
}

async function signData(data: string, secret: string): Promise<string> {
	const key = await importKey(secret);
	const enc = new TextEncoder();
	const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(data));
	return Array.from(new Uint8Array(signatureBuffer))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function verifySignature(signatureHex: string, data: string, secret: string): Promise<boolean> {
	const key = await importKey(secret);
	const enc = new TextEncoder();
	try {
		const signatureBytes = new Uint8Array(
			signatureHex.match(/.{1,2}/g)!.map((byte) => Number.parseInt(byte, 16)),
		);
		return await crypto.subtle.verify("HMAC", key, signatureBytes.buffer, enc.encode(data));
	} catch {
		return false;
	}
}

async function importKey(secret: string): Promise<CryptoKey> {
	if (!secret) {
		throw new Error("cookieSecret is required for signing cookies");
	}
	const enc = new TextEncoder();
	return crypto.subtle.importKey(
		"raw",
		enc.encode(secret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign", "verify"],
	);
}

// --- Cookie Signing Key (auto-generated, persisted in KV) ---

export async function getOrCreateCookieSigningKey(kv: KVNamespace): Promise<string> {
	const KEY = "cookie_signing_key";
	const existing = await kv.get(KEY);
	if (existing) return existing;

	const key = Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");

	await kv.put(KEY, key);
	return key;
}
