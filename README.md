# MCP GDrive FileAccess

Why this MCP?

Claude's built-in Google Drive integration only reads **Google Workspace files** (Docs, Sheets, Slides). If your Drive contains Office documents, PDFs, or images, Claude can't access them. This MCP server fills that gap — it lets Claude search, browse, and read **DOCX, XLSX, PPTX, PDF, plain text and images** directly from your Google Drive.

Runs on Cloudflare Workers — configure your Google credentials, create a KV namespace, and `npm run deploy`.

Also: install it in CloudFlare and access it from your mobile and any other platform.

Bonus: you can install using the Cloudflare free tier and avoid going thru third parties!

## Features

- **Read-only by default** — requests `drive.readonly` for browsing and downloading files
- **Search** files across your entire Google Drive
- **Browse** folder contents
- **Download** files preserving their native format:
  - Office documents (DOCX, XLSX, PPTX, DOC, XLS, PPT)
  - PDF, ODT, ODS
  - Plain text (TXT, CSV, HTML, XML) — returned as inline text
  - Images (PNG, JPG, GIF, etc.) — returned as inline images
  - Binary files (Office, PDF, ODT, ODS) — served as a one-time temporary download URL (5-minute expiry)
- **Quick text extraction** — returns a simplified text-only version of DOCX, PPTX, XLSX, and PDF files with `[IMAGE: filename]` placeholders for embedded images
- **Image extraction** — retrieve actual images from DOCX, PPTX, and PDF files, individually or all at once
- **Shared memory** — read, write, list, and delete files in an `AI/Claude` folder on Google Drive (requires `drive.file` scope, granted on first use)
- **Access control** — optionally restrict access by email address and/or domain via `WHITELIST_USERS` and `WHITELIST_DOMAINS`

> **Note:** Google Workspace files (Google Docs, Sheets, Slides) are not handled by this server — use the official Claude Google Drive integration for those.

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_drive(query)` | Full-text search across Google Drive |
| `list_folder(folder_id?)` | List files in a folder (root by default) |
| `download_file(file_id, file_name)` | Download a file in its native format |
| `download_simplified_text_version(file_id, file_name)` | Text extraction from DOCX, PPTX, XLSX, or PDF with `[IMAGE: filename]` placeholders |
| `extract_images(file_id, file_name, image_names?)` | Extract images from DOCX, PPTX, or PDF (all or specific ones by name) |
| `write_memory(path, content)` | Write a text file to the `AI/Claude` folder on Google Drive |
| `read_memory(path)` | Read a text file from the `AI/Claude` folder |
| `list_memory(path?)` | List files and folders inside `AI/Claude` |
| `delete_memory(path)` | Delete a file from `AI/Claude` |

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

2. **Create a `.dev.vars` file** from the provided template:

   ```bash
   cp .dev.vars.example .dev.vars
   ```

   Then fill in your Google OAuth credentials. Optionally uncomment and set `WHITELIST_USERS` / `WHITELIST_DOMAINS` to restrict access (see [Access Control](#access-control) below).

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
   # Optional — restrict access (see Access Control below):
   # npx wrangler secret put WHITELIST_USERS
   # npx wrangler secret put WHITELIST_DOMAINS
   ```

## Access Control

By default, any user who authenticates with Google can use the server. To restrict access, set one or both of these environment variables (in `.dev.vars` for local development, or as worker secrets for production):

| Variable | Description |
|----------|-------------|
| `WHITELIST_USERS` | Comma-separated list of allowed email addresses (e.g. `alice@example.com,bob@example.com`) |
| `WHITELIST_DOMAINS` | Comma-separated list of allowed email domains (e.g. `example.com,company.org`) |

- If **neither** is set, all authenticated users are allowed.
- If **one or both** are set, the user must match at least one entry. Unauthorized users receive a 403 at the OAuth callback and an "Access denied" error on tool calls.

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
    ├── extract_images
    ├── write_memory
    ├── read_memory
    ├── list_memory
    └── delete_memory
```

- **KV (`OAUTH_KV`)** stores OAuth state with a 10-minute TTL
- **Durable Object (`OfficeMCP`)** hosts the MCP server instance
- Google Drive scopes: `drive.readonly` (browse & download) + `drive.file` (memory tools — create/edit files the app created)

## Google Cloud Configuration

1. Go to the [Google Cloud Console](https://console.cloud.google.com/)
2. Create a project (or select an existing one)
3. Enable the **Google Drive API** (here: https://console.cloud.google.com/apis/api/drive.googleapis.com)
4. Under **APIs & Services > Credentials**, create an **OAuth 2.0 Client ID** (Web application)
5. Add your worker URL + `/callback` as an authorized redirect URI (e.g. `https://your-worker.workers.dev/callback`)
6. Copy the Client ID and Client Secret into your `.dev.vars` / worker secrets

> **Note:** This server requests `drive.readonly` (search, list, download) and `drive.file` (memory tools — lets the app create and manage its own files in an `AI/Claude` folder). The `drive.file` scope **cannot** access files you created outside the app. When setting up the OAuth consent screen, add both `https://www.googleapis.com/auth/drive.readonly` and `https://www.googleapis.com/auth/drive.file`.

## Connecting to Claude

Once the worker is deployed you can connect it to Claude in two ways: via **claude.ai** (web/mobile) or via **Claude Code** (CLI). Both use the same worker URL — the only difference is where you configure it.

Your MCP endpoint URL is:

```
https://<your-worker-name>.<your-account>.workers.dev/mcp
```

For example, if your worker is named `mcp-gdrive-fileaccess` and your Cloudflare account subdomain is `johndoe`, the URL would be `https://mcp-gdrive-fileaccess.johndoe.workers.dev/mcp`.

> **Important:** the URL must end with `/mcp`. Using `/sse` or the bare domain will not work.

---

### Claude.ai (web & mobile)

This connects the MCP server to your Claude.ai account so it's available in every conversation on the web and in the Claude mobile apps.

1. Open [claude.ai](https://claude.ai) and sign in
2. Click your **profile icon** (bottom-left) → **Settings** → **Integrations**
3. Click **Add more** → **Add custom integration**
4. Fill in:
   - **Name**: any label you like (e.g. `Google Drive Files`)
   - **URL**: your MCP endpoint URL (see above)
5. Leave the **Advanced** section empty (OAuth client ID / secret) — the server supports dynamic client registration, no pre-shared credentials needed
6. Click **Connect**
7. You'll be redirected to Google — sign in and authorize access to your Drive
8. Once authorized, go back to the Integrations page and verify the status shows **Connected**

You're done. In any chat you can now ask Claude to search, browse, or download files from your Google Drive.

---

### Claude Code (CLI)

Claude Code connects to remote MCP servers over HTTP with OAuth. No API keys or manual tokens needed — Claude Code handles the OAuth flow in your browser automatically.

#### Option A — Project-level config (recommended for shared projects)

Create or edit `.mcp.json` in the root of your project:

```json
{
  "mcpServers": {
    "gdrive-fileaccess": {
      "type": "url",
      "url": "https://<your-worker-name>.<your-account>.workers.dev/mcp"
    }
  }
}
```

This file can be committed to version control so that everyone on the team gets the integration automatically.

#### Option B — User-level config (available in all projects)

Edit `~/.claude/settings.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "gdrive-fileaccess": {
      "type": "url",
      "url": "https://<your-worker-name>.<your-account>.workers.dev/mcp"
    }
  }
}
```

#### First connection

1. Start Claude Code (`claude` in your terminal)
2. Claude Code will detect the new MCP server and open your browser for OAuth
3. Sign in with Google and authorize access to your Drive
4. Return to the terminal — the MCP tools are now available

You can verify the connection with `/mcp` in Claude Code to see the list of active MCP servers and their tools.

#### Updating permissions

If you were connected before the memory tools were added, your existing session only has `drive.readonly` permissions. The memory tools require `drive.file` scope to create files. To upgrade:

1. In Claude Code, run `/mcp` and disconnect the `gdrive-fileaccess` server
2. Reconnect — Claude Code will open the browser again
3. Google will show an incremental consent screen asking for the additional `drive.file` permission
4. Approve, and the memory tools will work

On claude.ai: go to **Settings → Integrations**, disconnect the integration, then re-add it.

---

### Troubleshooting

- **"McpEndpointNotFound"** after successful Google auth — make sure the URL ends with `/mcp`
- **403 "Insufficient permissions"** on memory tools — you need to disconnect and reconnect to grant the `drive.file` scope (see [Updating permissions](#updating-permissions) above)
- **View live logs** from the deployed worker:
  ```bash
  npx wrangler tail
  ```

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
