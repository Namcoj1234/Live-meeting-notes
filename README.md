# Live Meeting Notes

Personal recording, bilingual transcription, translation, and meeting memory.

This app is a focused rewrite of the original study manager. It keeps the recording and note workflow, removes the project-heavy UI, and uses Cloudflare-native storage:

- D1 stores notes and activity logs.
- Cloud storage is text-only by default, so recordings do not bloat D1/KV/R2.
- Workers AI powers Smart Transcribe when AI credentials are configured.
- Smart Transcribe uses Whisper for ASR, then a Llama interpreter pass to clean ASR noise and translate by meaning.
- Browser speech recognition remains the zero-cost fallback.
- Audio sources include microphone, online meeting/tab audio through the browser share picker, and local audio/video playback inside the app.

Production:

```txt
https://live-meeting-notes.namcoj1234-repm5.workers.dev
```

## Run locally

```bash
npm install
npm run dev
```

Open:

```bash
http://localhost:3000
```

## Cloudflare storage setup

Create the D1 resource:

```bash
npx wrangler d1 create live-meeting-notes-db
```

Add the returned id to `wrangler.jsonc`, then run the schema:

```bash
npx wrangler d1 execute live-meeting-notes-db --remote --file=./db/schema.sql
```

The worker expects this binding for text storage:

```jsonc
"d1_databases": [
  {
    "binding": "LMN_DB",
    "database_name": "live-meeting-notes-db",
    "database_id": "YOUR-D1-DATABASE-ID"
  }
]
```

The old `/api/audio` route is left disabled unless an audio binding is added intentionally. The normal LMN flow saves only transcript text.

If R2 is enabled later and you intentionally want audio storage, add this binding:

```jsonc
"r2_buckets": [
  {
    "binding": "LMN_AUDIO",
    "bucket_name": "live-meeting-notes-audio"
  }
]
```

## Smart Transcribe

Create a Cloudflare API token with Workers AI permission, then set secrets:

```bash
npx wrangler secret put CLOUDFLARE_ACCOUNT_ID
npx wrangler secret put CLOUDFLARE_AI_TOKEN
```

Model names live in `wrangler.jsonc`:

```jsonc
"CLOUDFLARE_WHISPER_MODEL": "@cf/openai/whisper-large-v3-turbo",
"CLOUDFLARE_TRANSLATE_MODEL": "@cf/meta/m2m100-1.2b",
"CLOUDFLARE_INTERPRETER_MODEL": "@cf/meta/llama-3.1-8b-instruct-fast"
```

On Cloudflare Workers, the preferred setup is the `AI` binding in `wrangler.jsonc`; no REST token is required for deployed Smart Transcribe. Without an AI binding or AI token, microphone browser capture can still create local text drafts. Meeting/tab audio and local media playback require Smart AI because browser speech recognition cannot consume arbitrary audio streams.

## Deploy

```bash
npm run deploy:cf
```

## Notes

- Microphone access requires HTTPS in production. `localhost` is allowed for local development.
- Smart mode records complete 8-second cloud clips instead of raw MediaRecorder fragments, so Whisper receives decodable audio files.
- These clips are transient processing input; the app saves text notes, not audio files.
- D1 is separate from the old REPM database, so this app no longer depends on Supabase.
- Cloudflare free quotas are still quotas, but text-only D1 storage avoids the Supabase egress/storage issue that triggered this migration.
- Browser apps cannot silently capture all system audio. Meeting/video capture uses the browser's `getDisplayMedia` picker, and local media capture uses the in-app player.
- See `HANDOFF.md` for the full new-machine transfer checklist.
