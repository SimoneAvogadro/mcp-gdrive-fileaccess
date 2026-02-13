# MCP GDrive FileAccess

A [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) server that gives Claude access to your Google Drive files. It runs on Cloudflare Workers and lets Claude search, browse, and download documents in their native format.

Deploy-ready on Cloudflare Workers — just configure your Google credentials, create a KV namespace, and `npm run deploy`.

## Features

- **Read-only by design** — requests only the `drive.readonly` scope, so your files are never modified
- **Search** files across your entire Google Drive
- **Browse** folder contents
- **Download** files preserving their native format:
  - Office documents (DOCX, XLSX, PPTX, DOC, XLS, PPT)
  - Google Workspace files (Docs, Sheets, Slides) &mdash; exported as Office format
  - PDF, ODT, ODS
  - Plain text (TXT, CSV, HTML, XML)
  - Images (PNG, JPG, GIF, etc.)

## MCP Tools

| Tool | Description |
|------|-------------|
| `search_drive(query)` | Full-text search across Google Drive |
| `list_folder(folder_id?)` | List files in a folder (root by default) |
| `download_file(file_id)` | Download a file in its native format |

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
    └── download_file
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

## License

This project is licensed under the [GNU Affero General Public License v3.0](LICENSE).
