# MCP GDrive FileAccess

Why this MCP?

Claude's built-in Google Drive integration only reads **Google Workspace files** (Docs, Sheets, Slides). If your Drive contains Office documents, PDFs, or images, Claude can't access them. This MCP server fills that gap — it lets Claude search, browse, and read **DOCX, XLSX, PPTX, PDF, plain text and images** directly from your Google Drive.

Runs on Cloudflare Workers — configure your Google credentials, create a KV namespace, and `npm run deploy`.

Also: install it in CloudFlare and access it from your mobile and any other platform.

Bonus: you can install using the Cloudflare free tier and avoid going thru third parties!

## Features

- **Read-only by design** — requests only the `drive.readonly` scope, so your files are never modified
- **Search** files across your entire Google Drive
- **Browse** folder contents
- **Download** files preserving their native format:
  - Office documents (DOCX, XLSX, PPTX, DOC, XLS, PPT)
  - PDF, ODT, ODS
  - Plain text (TXT, CSV, HTML, XML)
  - Images (PNG, JPG, GIF, etc.)
- **Quick text extraction** — returns a simplified text-only version of DOCX, PPTX, and XLSX files with `[IMAGE: filename]` placeholders for embedded images
- **Image extraction** — retrieve actual images from DOCX and PPTX files, individually or all at once

> **Note:** Google Workspace files (Google Docs, Sheets, Slides) are not handled by this server — use the official Claude Google Drive integration for those.

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_drive(query)` | Full-text search across Google Drive |
| `list_folder(folder_id?)` | List files in a folder (root by default) |
| `download_file(file_id, file_name)` | Download a file in its native format |
| `download_simplified_text_version(file_id, file_name)` | Text extraction from DOCX, PPTX, or XLSX with `[IMAGE: filename]` placeholders |
| `extract_images(file_id, file_name, image_names?)` | Extract images from DOCX or PPTX (all or specific ones by name) |

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A [Cloudflare](https://www.cloudflare.com/) account
- A Google Cloud project with the Drive API enabled and OAuth 2.0 credentials

## Setup

1. **Clone the repo and install dependencies:**

   ```bash
   git clone https://github.com/SimoneAvogadro/mcp-gdrive-fileaccess.git
   cd mcp-gdrive-fileaccess
   npm install
   ```

2. **Create a `.dev.vars` file** with your secrets:

   ```
   GOOGLE_CLIENT_ID=your-google-client-id
   GOOGLE_CLIENT_SECRET=your-google-client-secret
   ```

   > **Note:** `.dev.vars` contains secrets and is listed in `.gitignore`. Never commit it to version control.

3. **Create the KV namespace** and update `wrangler.toml` with the real ID:

   ```bash
   npx wrangler kv namespace create OAUTH_KV
   ```

4. **Run locally:**

   ```bash
   npm run dev
   ```

5. **Deploy to Cloudflare Workers:**

   ```bash
   npm run deploy
   ```

   Remember to set your secrets on the deployed worker:

   ```bash
   npx wrangler secret put GOOGLE_CLIENT_ID
   npx wrangler secret put GOOGLE_CLIENT_SECRET
   ```

## Architecture

```
Cloudflare Worker
├── OAuthProvider          OAuth 2.0 token endpoint + client registration
├── GoogleHandler (Hono)   /authorize, /callback — Google OAuth flow
└── OfficeMCP (McpAgent)   /mcp — MCP server (Durable Object w/ SQLite)
    ├── search_drive
    ├── list_folder
    ├── download_file
    ├── download_simplified_text_version
    └── extract_images
```

- **KV (`OAUTH_KV`)** stores OAuth state with a 10-minute TTL
- **Durable Object (`OfficeMCP`)** hosts the MCP server instance
- Google Drive access is read-only (`drive.readonly` scope)

## Google Cloud Configuration

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select an existing one)
3. Enable the **Google Drive API** (here: https://console.cloud.google.com/apis/api/drive.googleapis.com)
4. Under **APIs & Services > Credentials**, create an **OAuth 2.0 Client ID** (Web application)
5. Add your worker URL + `/callback` as an authorized redirect URI (e.g. `https://your-worker.workers.dev/callback`)
6. Copy the Client ID and Client Secret into your `.dev.vars` / worker secrets

> **Note:** This server only requests the `drive.readonly` OAuth scope. It can search, list, and download files but **cannot** create, modify, or delete anything in your Google Drive. When setting up the OAuth consent screen you can limit the requested scopes to `https://www.googleapis.com/auth/drive.readonly`.

## Adding to Claude.ai

Once deployed, connect the MCP server to your Claude.ai account:

1. Open [claude.ai](https://claude.ai) and sign in
2. Click your profile icon (bottom-left) → **Settings** → **Integrations**
3. Click **Add more** → **Add custom integration**
4. Fill in the fields:
   - **Name**: any label you like (e.g. `Google Drive`)
   - **URL**: `https://your-worker.workers.dev/mcp`
5. Leave the **Advanced** section (OAuth client ID/secret) empty — the server supports dynamic client registration
6. Click **Connect** — you will be redirected to Google to authorize read-only access to your Drive
7. Once authorized, the integration is ready. In any chat you can ask Claude to search, browse, or download files from your Google Drive.

### Troubleshooting

- **"McpEndpointNotFound"** after successful Google auth — make sure the URL ends with `/mcp`, not `/sse`
- **View live logs** from the deployed worker:
  ```bash
  npx wrangler tail
  ```

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
