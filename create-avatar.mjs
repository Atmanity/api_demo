// Build an avatar-import zip (manifest + image + voice + prompt + optional
// knowledge files) in memory and POST it to Atmee's avatar creation API,
// then poll until the build finishes. No dependencies, no build step -- the
// zip writer below only uses node:zlib for CRC32, and multipart upload uses
// the global FormData/Blob/fetch.
//
// Usage:
//   node create-avatar.mjs \
//     --manifest ./avatar.json \
//     --image ./portrait.jpg \
//     --voice ./sample.wav \
//     --prompt ./prompt.txt \
//     [--knowledge ./pricing.pdf --knowledge ./faq.md]
//
// Requires ATMEE_API_KEY (scopes: avatars:write, plus billing:write if
// the manifest has a "sponsor" block) and, optionally, ATMEE_API_BASE_URL
// (defaults to production).

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { crc32 } from 'node:zlib';

const API_KEY = process.env.ATMEE_API_KEY;
const API_BASE_URL = process.env.ATMEE_API_BASE_URL ?? 'https://api.atmanity.us';

if (!API_KEY) {
  console.error('Set ATMEE_API_KEY (see .env.example).');
  process.exit(1);
}

function parseArgs(argv) {
  const args = { knowledge: [] };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!flag.startsWith('--')) continue;
    const key = flag.slice(2);
    const value = argv[++i];
    if (key === 'knowledge') args.knowledge.push(value);
    else args[key] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

// Defaults point at the bundled sample (a generated face + a synthetic voice
// line), so `ATMEE_API_KEY=... node create-avatar.mjs` works with zero files
// of your own. Pass --manifest/--image/--voice to use your own avatar.
const here = new URL('.', import.meta.url).pathname;
args.manifest ??= `${here}avatar.example.json`;
args.image ??= `${here}sample/portrait.jpg`;
args.voice ??= `${here}sample/voice.wav`;

// --- Minimal ZIP writer (stored, i.e. uncompressed entries) -----------------
// avatar zips here are tiny (one image, one short voice sample, some text),
// so skipping DEFLATE keeps this dependency-free without costing much size.

function makeZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const dosTime = 0;
    const dosDate = 0x21; // 1980-01-01, avatar zips don't need real mtimes

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(0, 8); // method: stored
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(0, 10); // method: stored
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralStart = offset;
  const central = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // disk number
  end.writeUInt16LE(0, 6); // disk with central dir
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, central, end]);
}

// --- Build the zip -----------------------------------------------------------

const [manifestRaw, imageData, voiceData] = await Promise.all([
  readFile(args.manifest, 'utf8'),
  readFile(args.image),
  readFile(args.voice),
]);
JSON.parse(manifestRaw); // fail fast on invalid JSON before uploading

const files = [
  { name: 'avatar.json', data: Buffer.from(manifestRaw, 'utf8') },
  { name: `image/${basename(args.image)}`, data: imageData },
  { name: `voice/${basename(args.voice)}`, data: voiceData },
];
if (args.prompt) {
  files.push({ name: 'prompt/prompt.txt', data: await readFile(args.prompt) });
}
for (const path of args.knowledge) {
  files.push({ name: `knowledge/${basename(path)}`, data: await readFile(path) });
}

const zip = makeZip(files);
console.log(`Built zip: ${files.map((f) => f.name).join(', ')} (${zip.length} bytes)`);

// --- Upload --------------------------------------------------------------

const form = new FormData();
form.set('file', new Blob([zip]), 'avatar.zip');

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

const createRes = await fetch(`${API_BASE_URL}/v1/avatars`, {
  method: 'POST',
  headers: { 'X-Api-Key': API_KEY },
  body: form,
});
const created = await readJson(createRes);
if (!createRes.ok) {
  console.error(`Create failed (${createRes.status}):`, created);
  process.exit(1);
}
console.log(`Created ${created.avatarId} - status: ${created.status}`);

// --- Poll until the build finishes -------------------------------------------

const statusUrl = `${API_BASE_URL}${created.statusUrl}`;
let transientFailures = 0;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const res = await fetch(statusUrl, { headers: { 'X-Api-Key': API_KEY } });
  const status = await readJson(res);
  if (!res.ok) {
    // A 5xx from the load balancer (a rollout, a blip) is worth a retry;
    // anything else (401, 404) is a real answer.
    if (res.status >= 500 && ++transientFailures <= 5) {
      console.warn(`Status check got ${res.status}, retrying (${transientFailures}/5)`);
      continue;
    }
    console.error(`Status check failed (${res.status}):`, status);
    process.exit(1);
  }
  transientFailures = 0;
  const stages = Object.entries(status.stages)
    .map(([stage, s]) => `${stage}=${s.status}`)
    .join(' ');
  console.log(`[${status.status}] ${stages}`);

  if (status.status === 'ready') {
    console.log(`\nDone: readyToChat=${status.readyToChat}`);
    console.log(status);
    break;
  }
  if (status.status === 'failed' || status.status === 'moderation_hold') {
    console.error(`\nBuild ended in "${status.status}":`, status);
    process.exit(1);
  }
}
