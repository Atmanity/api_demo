# Atmee embed API demo

A minimal, working example of putting an Atmee avatar on your own website:
your visitor talks to it over video, right there on your page, with usage
billed to your account. Two files, no dependencies, no build step.

## Why is there a server at all?

Your API key (`sk_atmee_…`) is a secret — anyone who has it can start
sessions and spend your account's credits. If you put it directly in your
page's JavaScript, anyone can view-source it and take it. `server.mjs`
exists to hold that key server-side: your page never sees it, it only ever
talks to your own `/api/session` endpoint, which then calls Atmee on
your key's behalf.

## Setup

1. Create a key: in the Atmee dashboard, go to **API Keys** and click
   **Create API Key**. Copy the secret — it's shown exactly once.
2. Grab the id of an avatar your account owns (any avatar you've created).
   A key works with every avatar in your account, so any of them will do.
3. Copy `.env.example` to `.env` and fill in `ATMEE_API_KEY` and
   `ATMEE_AVATAR_ID` (or just export them directly, as shown below).

## Run it

```bash
ATMEE_API_KEY=sk_atmee_… ATMEE_AVATAR_ID=… node server.mjs
```

Then open <http://localhost:3000> and click **Talk to the avatar**.

A second example, <http://localhost:3000/widget>, shows the same session
flow embedded in a mock hotel website as a floating launcher in the
bottom-right corner that opens a "Start video call" popover (`widget.html`).

## What happens when you click the button

1. Your page calls your **own** server (`POST /api/session`) — no
   authentication needed there, it's just your own page talking to your own
   backend.
2. Your server calls Atmee's `POST /v1/session` with your secret key in
   the `X-Api-Key` header. **This takes a few seconds** — we create a
   LiveKit room, start the avatar, and don't answer until it has actually
   joined. If your own server has a short default timeout, raise it (this
   demo already sets a 120s timeout on the upstream call).
3. Atmee hands back `serverUrl` and `userToken`. Your server passes only
   those two through to the page — never the raw response, and never your
   key.
4. The page connects directly to LiveKit with `room.connect(serverUrl,
userToken)`. Because the avatar already joined the room in step 2,
   there's no "waiting for avatar" state to build — its video and audio
   attach immediately.

Two timing details worth knowing if you build on top of this:

- **Connect promptly.** If nobody joins the room within about 60 seconds of
  getting the token, the session is marked failed and the credits are
  returned.
- **The clock starts before your visitor joins.** The billed session begins
  when the room is created (step 2), so the round-trip and your visitor's
  own connect time both count against it.

## Creating an avatar via the API

`create-avatar.mjs` builds an avatar-import zip (manifest + image + voice +
prompt, optionally knowledge files) in memory and uploads it with
`POST /v1/avatars`, then polls until the build finishes. No zip library, no
form-data library -- it writes a minimal (uncompressed) zip itself with
`node:zlib` for CRC32, and uploads with the built-in `FormData`/`Blob`.

Your key needs the `avatars:write` scope (and `billing:write` too if your
manifest includes a `sponsor` block).

```bash
ATMEE_API_KEY=sk_atmee_… node create-avatar.mjs
```

That runs with the bundled sample (`avatar.example.json` + `sample/portrait.jpg`,
an AI-generated face, + `sample/voice.wav`, a synthetic voice line) and gives
you a ready-to-chat avatar in under a minute. For your own avatar:

```bash
ATMEE_API_KEY=sk_atmee_… node create-avatar.mjs \
  --manifest ./avatar.json \
  --image ./portrait.jpg \
  --voice ./sample.wav
```

`avatar.json` needs at least a `name`; the character lives in the `persona`
block -- `personality` (who the avatar is) and `scenario` (what it is doing
with the visitor; alternatively ship the scenario as `prompt/prompt.txt`,
but not both). `avatar.example.json` in this repo is a complete, working
manifest to start from (copy it, change the name and persona). Add
`--knowledge ./file.pdf` (repeatable) for knowledge-base files; the optional
`knowledge.descriptions` block in the manifest maps those filenames to short
descriptions.

### Or from URLs, without a zip

If the files already sit on a public https host, `create-avatar-from-urls.mjs`
sends the manifest as JSON with an `assets` block and Atmee downloads them:

```bash
ATMEE_API_KEY=sk_atmee_… node create-avatar-from-urls.mjs \
  --image https://cdn.example.com/portrait.jpg \
  --voice https://cdn.example.com/sample.wav \
  --knowledge https://cdn.example.com/faq.md
```

Private or non-https hosts are refused (`invalid_url`); a URL that cannot be
downloaded fails the create with `fetch_failed`. Add `"previews": true` to the
manifest if you want the idle/talking preview clips rendered too — the API
returns them as one-hour `previewUrls` on the status response once done.
Sessions started with `POST /v1/session` can pass `"language": "ja"` (or `en`,
`zh-TW`) to run in the visitor's language.

### Or by hand, with zip and curl

The script is just a convenience — the API takes an ordinary zip. Lay the
files out like this (`avatar.json` at the root, one file per media folder,
`knowledge/` optional):

```
avatar.zip
├── avatar.json
├── image/portrait.png
├── voice/sample.wav
├── prompt/prompt.txt
└── knowledge/faq.md        # optional, up to 20 files
```

```bash
zip -r avatar.zip avatar.json image voice prompt

curl -X POST "https://api.atmanity.us/v1/avatars" \
  -H "X-Api-Key: $ATMEE_API_KEY" \
  -F "file=@avatar.zip"
```

The `202` response carries an `avatarId` and a `statusUrl`; poll that (same
`X-Api-Key` header) every few seconds until `readyToChat` is `true`:

```bash
curl "https://api.atmanity.us/v1/avatars/<avatarId>" -H "X-Api-Key: $ATMEE_API_KEY"
```

**Note:** creating avatars through the API needs a key with the
`avatars:write` scope on a plan with API access.
