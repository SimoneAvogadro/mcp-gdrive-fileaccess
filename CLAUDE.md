# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP GDrive FileAccess is a Cloudflare Workers-based MCP (Model Context Protocol) server that gives Claude access to Google Drive documents. It searches, lists, and downloads office files (DOCX, XLSX, PPTX, Google Docs/Sheets/Slides), plain text, and images in their native format.

## Commands

- `npm run dev` — Start local Wrangler dev server
- `npm run deploy` — Deploy to Cloudflare Workers
- `npm run cf-typegen` — Regenerate Cloudflare environment types (`worker-configuration.d.ts`)

No test framework is configured.

## Environment Setup

Copy `.dev.vars` and fill in:
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — Google OAuth credentials

## Architecture

### Runtime & Bindings

Runs on Cloudflare Workers with `nodejs_compat`. Uses:
- **KV (`OAUTH_KV`)** — OAuth state storage (10-min TTL)
- **Durable Object (`OfficeMCP`)** — MCP server instance with SQLite

### Entry Point (`src/index.ts`)

`OfficeMCP` extends `McpAgent` and registers 5 MCP tools:
1. **`search_drive(query)`** — Full-text search in Google Drive
2. **`list_folder(folder_id?)`** — List files in a folder (root by default)
3. **`download_file(file_id)`** — Download a file in its native format
4. **`download_simplified_text_version(file_id)`** — Download a DOCX, PPTX, XLSX, or PDF file and return a simplified text-only version with `[IMAGE: filename]` placeholders for embedded images
5. **`extract_images(file_id, image_names?)`** — Extract images from a DOCX, PPTX, or PDF file, all or specific ones by name. For PPTX, automatically filters out theme/background images when no specific names are requested. PDF images are extracted as PNG

Files are returned as base64 resource blobs with their native MIME type. Plain text is returned as text content. Unsupported file types return an error. Google Workspace files (Google Docs, Sheets, Slides) are NOT handled by this MCP server — they are accessed via the official Claude Google Drive plugin.

The default export wires the OAuth provider to serve MCP at `/mcp`.

### OAuth Flow (`src/google-handler.ts`, `src/workers-oauth-utils.ts`, `src/utils.ts`)

Hono-based HTTP handler implementing OAuth 2.0 with Google:
- `GET /authorize` — Show approval dialog or redirect to Google
- `POST /authorize` — Handle user approval with CSRF validation
- `GET /callback` — Exchange Google auth code for tokens, complete MCP auth

Security: CSRF tokens via HttpOnly cookies, session binding between auth steps, HMAC-signed client approval cookies. Scope is `drive.readonly`.

### Google Drive Client (`src/drive/client.ts`)

`createDriveClient(accessToken)` returns methods: `searchFiles`, `listFolder`, `findByName`, `getFileMetadata`, `downloadFile`, `exportFile`. Throws `TokenExpiredError` on 401.

### Parsers (`src/parsers/`)

- **`docx.ts`** — `parseDocxWithImages(buffer)`: extracts text paragraphs from DOCX with `[IMAGE: filename]` placeholders where images appear. Returns `{ text, imageNames }`
- **`pptx.ts`** — `parsePptxWithImages(buffer)`: extracts text per slide from PPTX with `[IMAGE: filename]` placeholders. Returns `{ slides, imageNames }`. Image names are only those referenced via `<a:blip>` in the actual slides (not theme/layout/master)
- **`docx-images.ts`** — `extractOfficeImages(buffer, mediaPrefix, filterNames?)`: extracts image binaries from the media folder of DOCX (`word/media/`) or PPTX (`ppt/media/`), optionally filtered by name
- **`pdf.ts`** — `parsePdfWithImages(buffer)`: extracts text per page from PDF with `[IMAGE: pageN-key]` placeholders. Returns `{ pages, imageNames }`. Uses `unpdf` for parsing and `fast-png` for encoding raw pixel data to PNG. `extractPdfImages(buffer, filterNames?)`: extracts images from PDF as PNG files
- **`spreadsheet.ts`** — `parseSpreadsheetToCSV(buffer)`: converts XLSX sheets to CSV

### Type Definitions (`src/drive/types.ts`)

MIME type maps (`GOOGLE_MIME`, `OFFICE_MIME`, `OTHER_MIME`), `GOOGLE_EXPORT_MAP` for Workspace→Office conversion, and `DriveFile` interface. `isGoogleWorkspace()` type guard used by the download router.

## Key Patterns

- **Props** passed through MCP contain `email`, `name`, `accessToken`, `refreshToken` from Google OAuth
- Hono handles HTTP routing; JSX is configured with Hono's JSX runtime (used for the approval dialog)
- TypeScript strict mode, ESNext target, bundler module resolution
