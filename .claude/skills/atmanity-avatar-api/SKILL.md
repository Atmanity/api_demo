---
name: atmanity-avatar-api
description: "Use when creating, updating, or debugging Atmanity avatars via the /v1/avatars API — building the import zip, polling build status, or updating an existing avatar's appearance, voice, knowledge base, or metadata."
---

# Atmanity avatar API — creating and updating avatars

Base URL: `https://api.atmanity.us`. Every request needs `X-Api-Key: $ATMANITY_API_KEY`
(the key needs the `avatars:write` scope, plus `billing:write` if the manifest includes
a `sponsor` block).

## Zip layout for creation

```
avatar.zip
├── avatar.json              # required, schemaVersion 1, needs at least "name"
├── image/<file>              # one portrait image
├── voice/<file>               # one voice recording
├── prompt/prompt.txt          # optional — mutually exclusive with persona.scenario
└── knowledge/<file...>        # optional, up to 20 files
```

`persona.personality` + `persona.scenario` in `avatar.json` is the standard way to define
the character; `prompt/prompt.txt` is the alternative to `scenario` — never ship both. See
`avatar.example.json` in this repo for a complete manifest to copy from.

**Portrait requirements:** the image must show a clear, forward-facing human face with
enough resolution and detail for the animation pipeline to detect facial landmarks —
that's what drives the talking-head preview and live avatar rendering. Flat illustrations,
cartoons, or heavily stylized artwork are not supported; use a real photographic portrait.
Frame it front-facing, shoulders-up (head-and-shoulders portrait, not a full-body or
profile shot), at high resolution — low-resolution or tightly cropped face-only images
give the pipeline less to work with and produce a lower-quality result. This applies to
both the `image/` file in the creation zip and any image sent to
`PUT /v1/avatars/{id}/appearance`.

## Endpoints

| Verb | Path | Body | Result |
|---|---|---|---|
| `POST` | `/v1/avatars` | multipart `file=@avatar.zip` (full zip above) | `202`, `{avatarId, status, statusUrl}` — creates the avatar and starts the build |
| `GET` | `/v1/avatars/{id}` | — | full status: top-level `status`/`readyToChat`, plus `stages.{appearance,voice,persona,knowledge,previews}`, each with its own `status` |
| `PATCH` | `/v1/avatars/{id}` | JSON body | updates avatar metadata — see schema below |
| `PUT` | `/v1/avatars/{id}/assets` | multipart `file=@some.zip` (any subset of the create-zip folders) | `202`, `{avatarId, status, updatedKeys:[...]}` — replaces whichever top-level folders are included (e.g. a zip containing only `knowledge/` reports `updatedKeys:["knowledge_base_files"]`) and restarts the build for those stages |
| `PUT` | `/v1/avatars/{id}/appearance` | multipart `file=@portrait.png` (single image) | `200 {avatarId, status:"building"}` — replaces the portrait and reruns the `appearance`/`previews` stages |
| `PUT` | `/v1/avatars/{id}/voice` | multipart `file=@sample.wav` (single recording) | `200 {avatarId, status:"building"}` — replaces the voice clone |
| `PUT` | `/v1/avatars/{id}/knowledge` | multipart, repeated `files=@...` parts, plus an optional `descriptions` part (JSON, `type=application/json`) | `200 {avatarId, status:"building"}` — replaces the whole knowledge set with what's sent; omit `files` entirely to clear it |

### `PATCH /v1/avatars/{id}` metadata fields

All fields are optional but at least one is required per request; unknown fields are
rejected.

```
description     string, ≤280 chars, nullable
knownAliases    string[], ≤20 items, each ≤100 chars, nullable
language        enum: en | zh-TW | ja, nullable
name            string, ≤100 chars, nullable
preferredAlias  string, ≤100 chars, nullable
previewMessage  string, ≤500 chars, nullable
spokenName      string, ≤100 chars, nullable
visibility      enum: private | unlisted | public, nullable
```

Image, voice, and knowledge are managed through their own dedicated endpoints above, not
through this one.

### Knowledge `descriptions` part

Pass short human-readable descriptions per filename as a JSON-typed multipart field:

```bash
-F 'descriptions={"faq.md":"Resort FAQ: check-in, amenities, dining, local tips."};type=application/json'
```

## Polling after create or update

Any create or update call above puts the avatar into `status: "building"`. Poll
`GET /v1/avatars/{id}` every few seconds until `readyToChat` is `true`. Note that
`readyToChat` can flip to `true` while `stages.knowledge.status` is still
`pending`/`processing` — knowledge indexing finishes asynchronously, so don't gate on
`readyToChat` alone if the knowledge base specifically needs to be searchable yet.

## Handy one-liners

```bash
# Create
curl -X POST "https://api.atmanity.us/v1/avatars" \
  -H "X-Api-Key: $ATMANITY_API_KEY" -F "file=@avatar.zip"

# Poll
curl "https://api.atmanity.us/v1/avatars/$AID" -H "X-Api-Key: $ATMANITY_API_KEY"

# Replace portrait only
curl -X PUT "https://api.atmanity.us/v1/avatars/$AID/appearance" \
  -H "X-Api-Key: $ATMANITY_API_KEY" -F "file=@portrait.png"

# Replace voice only
curl -X PUT "https://api.atmanity.us/v1/avatars/$AID/voice" \
  -H "X-Api-Key: $ATMANITY_API_KEY" -F "file=@sample.wav"

# Replace the whole knowledge set (repeat -F files= per file)
curl -X PUT "https://api.atmanity.us/v1/avatars/$AID/knowledge" \
  -H "X-Api-Key: $ATMANITY_API_KEY" \
  -F "files=@faq.md" \
  -F 'descriptions={"faq.md":"..."};type=application/json'

# Update metadata only
curl -X PATCH "https://api.atmanity.us/v1/avatars/$AID" \
  -H "X-Api-Key: $ATMANITY_API_KEY" -H "Content-Type: application/json" \
  -d '{"visibility":"unlisted"}'
```
