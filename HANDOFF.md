# Live Meeting Notes - Handoff

## Production

- App: Live Meeting Notes
- Production URL: https://live-meeting-notes.namcoj1234-repm5.workers.dev
- Cloudflare Worker name: `live-meeting-notes`
- Current deployed version checked during handoff: `223e8f09-00ec-444b-a0cb-856a05193c88`
- Storage: Cloudflare D1 text-only notes
- D1 database name: `live-meeting-notes-db`
- D1 database id: `062da3d7-248e-4497-923f-57fd766414c4`
- AI: Cloudflare Workers AI binding `AI`

## What This App Does

- Records microphone audio.
- Captures online meeting/tab audio through the browser share picker.
- Plays local audio/video files and captures their playback for transcription.
- Uses Cloudflare Whisper for transcription.
- Uses a Llama interpreter pass to clean ASR and translate by meaning with recent context.
- Saves text notes only. Audio is not saved to D1, KV, or R2.

## New Machine Setup

Install these first:

- Node.js 20+
- Git
- Cloudflare Wrangler access through `npx wrangler`

Clone the GitHub repo after it is pushed:

```powershell
git clone <GITHUB_REPO_URL>
cd <REPO_FOLDER>
npm install
npm run dev
```

Open:

```txt
http://localhost:3000
```

If port 3000 is busy:

```powershell
npm run dev -- -p 3010
```

## Cloudflare Login On New Machine

```powershell
npx wrangler login
npx wrangler whoami
```

The project is configured in `wrangler.jsonc`. It already points at the production Worker, D1 database, and AI binding.

## Local Environment

For normal local UI work, `.env` is optional. The app can run without cloud AI locally, but Smart Transcribe will only fully work in deployed Cloudflare or with an AI API token.

To test Workers AI locally through REST, copy:

```powershell
Copy-Item .env.example .env.local
```

Then fill:

```txt
CLOUDFLARE_ACCOUNT_ID=<account-id>
CLOUDFLARE_AI_TOKEN=<workers-ai-token>
```

Do not commit `.env.local` or `.dev.vars`.

## Deploy

After logging into Cloudflare:

```powershell
npm run build
npm run deploy:cf
```

`deploy:cf` runs OpenNext Cloudflare build and deploys to:

```txt
https://live-meeting-notes.namcoj1234-repm5.workers.dev
```

## Database Schema

Only run this if creating a new D1 database or repairing schema:

```powershell
npx wrangler d1 execute live-meeting-notes-db --remote --file=./db/schema.sql
```

Do not reuse the old REPM/Supabase database for this app.

## GitHub Push From This Machine

This workspace has been prepared as a local Git repo. If GitHub CLI is installed and logged in:

```powershell
gh repo create live-meeting-notes --private --source . --remote origin --push
```

If using the GitHub website:

1. Create an empty GitHub repo, for example `live-meeting-notes`.
2. Copy its HTTPS URL.
3. Run:

```powershell
git remote add origin https://github.com/<owner>/live-meeting-notes.git
git push -u origin main
```

On the second machine, clone that URL and continue from "New Machine Setup".

## Important Browser Limits

- Browser apps cannot silently capture all system audio.
- Meeting/video web capture uses the browser picker through `getDisplayMedia`.
- For best tab/system audio capture, use Chrome or Edge.
- Local file capture uses the in-app audio/video player and `captureStream`.
- Microphone access requires HTTPS in production; localhost is allowed for dev.

