# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP GDrive FileAccess is a Cloudflare Workers-based MCP (Model Context Protocol) server that gives Claude access to Google Drive documents. It searches, lists, and downloads office files (DOCX, XLSX, PPTX, PDFs, plain text, and images) in their native format.

## Commands

- `npm run dev` — Start local Wrangler dev server
- `npm run deploy` — Deploy to Cloudflare Workers
- `npm run cf-typegen` — Regenerate Cloudflare environment types (`worker-configuration.d.ts`)

No test framework is configured.

## Environment Setup

Copy `.dev.vars` and fill in:
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth credentials
- `WHITELIST_USERS` / `WHITELIST_DOMAINS` — Optional access control (comma-separated)

## Architecture

### Runtime & Bindings

Runs on Cloudflare Workers with `nodejs_compat`. Uses:
- **KV (`OAUTH_KV`)** — OAuth state storage (10-min TTL) and temporary binary blob storage (5-min TTL)
- **Durable Object (`OfficeMCP`)** — MCP server instance with SQLite

### Entry Point (`src/index.ts`)

`OfficeMCP` extends `McpAgent` and registers 5 MCP tools. All download tools accept either `file_id` or `file_name` (at least one required):

1. **`search_drive(query)`** — Full-text search in Google Drive
2. **`list_folder(folder_id?)`** — List files in a folder (root by default)
3. **`download_file(file_id?, file_name?)`** — Download a file in its native format:
   - Text files (TXT, CSV, HTML, XML) → returned as inline text
   - Images → returned as inline MCP image content (base64)
   - Binary files (Office, PDF, ODT, ODS) → stored in KV and returned as a one-time download URL (`/blob/:id`, expires in 5 minutes, deleted after first download)
   - Google Workspace files → error (use built-in Claude Google Drive integration)
4. **`download_simplified_text_version(file_id?, file_name?)`** — Download a DOCX, PPTX, XLSX, or PDF file and return a simplified text-only version with `[IMAGE: filename]` placeholders for embedded images
5. **`extract_images(file_id?, file_name?, image_names?)`** — Extract images from a DOCX, PPTX, or PDF file, all or specific ones by name. For PPTX, automatically filters out theme/background images when no specific names are requested. PDF images are extracted as PNG

Google Workspace files (Google Docs, Sheets, Slides) are NOT handled — use the official Claude Google Drive integration instead.

The default export wires the OAuth provider to serve MCP at `/mcp`.

**Token refresh:** All tool calls use `withTokenRefresh()`, which automatically retries with a refreshed access token if the first attempt fails with `TokenExpiredError`. The new token is persisted to Durable Object storage.

### OAuth Flow (`src/google-handler.ts`, `src/workers-oauth-utils.ts`, `src/utils.ts`)

Hono-based HTTP handler implementing OAuth 2.0 with Google:
- `GET /authorize` — Show approval dialog or redirect to Google
- `POST /authorize` — Handle user approval with CSRF validation
- `GET /callback` — Exchange Google auth code for tokens, whitelist check, complete MCP auth
- `GET /blob/:id` — Serve a one-time binary download stored in KV (used by `download_file`)
- `GET /favicon.ico`, `GET /favicon.svg` — Serve the server icon (inline SVG)

Security: CSRF tokens via HttpOnly cookies, session binding between auth steps, HMAC-signed client approval cookies. Scope is `drive.readonly email profile`.

### Google Drive Client (`src/drive/client.ts`)

`createDriveClient(accessToken)` returns methods: `searchFiles`, `listFolder`, `findByName`, `getFileMetadata`, `downloadFile`, `exportFile`. Throws `TokenExpiredError` on 401.

- `findByName(name)` — exact name match, returns all non-trashed matches across all drives (used by tools when `file_name` is provided instead of `file_id`)

### Parsers (`src/parsers/`)

- **`docx.ts`** — `parseDocxWithImages(buffer)`: extracts text paragraphs from DOCX with `[IMAGE: filename]` placeholders where images appear. Returns `{ text, imageNames }`
- **`pptx.ts`** — `parsePptxWithImages(buffer)`: extracts text per slide from PPTX with `[IMAGE: filename]` placeholders. Returns `{ slides, imageNames }`. Image names are only those referenced via `<a:blip>` in the actual slides (not theme/layout/master)
- **`docx-images.ts`** — `extractOfficeImages(buffer, mediaPrefix, filterNames?)`: extracts image binaries from the media folder of DOCX (`word/media/`) or PPTX (`ppt/media/`), optionally filtered by name
- **`pdf.ts`** — `parsePdfWithImages(buffer)`: extracts text per page from PDF with `[IMAGE: pageN-key]` placeholders. Returns `{ pages, imageNames }`. Uses `unpdf` for parsing and `fast-png` for encoding raw pixel data to PNG. `extractPdfImages(buffer, filterNames?)`: extracts images from PDF as PNG files
- **`spreadsheet.ts`** — `parseSpreadsheetToCSV(buffer)`: converts XLSX sheets to CSV

### Type Definitions (`src/drive/types.ts`)

MIME type maps (`GOOGLE_MIME`, `OFFICE_MIME`, `OTHER_MIME`), `SPREADSHEET_MIMES` (XLSX only), `TEXT_EXTRACTABLE_MIMES` (DOCX, PPTX, XLSX, PDF), and `DriveFile` / `DriveFileList` interfaces.

### Utilities (`src/utils.ts`)

- `getUpstreamAuthorizeUrl(...)` — builds Google OAuth authorization URL
- `fetchUpstreamAuthToken(...)` — exchanges auth code for Google tokens
- `refreshAccessToken(...)` — uses a refresh token to obtain a new access token
- `Props` type — `{ email, name, accessToken, refreshToken }` stored in the MCP token

## Key Patterns

- **Props** passed through MCP contain `email`, `name`, `accessToken`, `refreshToken` from Google OAuth
- Hono handles HTTP routing in `google-handler.ts`; JSX is configured with Hono's JSX runtime (used for the approval dialog)
- TypeScript strict mode, ESNext target, bundler module resolution
- `withTokenRefresh()` wraps all Drive API calls to handle expired tokens transparently
