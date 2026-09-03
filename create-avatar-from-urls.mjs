// Create an avatar without building a zip: send the manifest as JSON and let
// Atmee download the image, voice sample and knowledge files from your own
// public https URLs. Same limits and same result as the zip route.
//
// Usage:
//   ATMEE_API_KEY=sk_atmee_... node create-avatar-from-urls.mjs \
//     --image https://cdn.example.com/portrait.jpg \
//     --voice https://cdn.example.com/sample.wav \
//     [--prompt https://cdn.example.com/scenario.txt] \
//     [--knowledge https://cdn.example.com/faq.md --knowledge https://cdn.example.com/pricing.pdf] \
//     [--manifest ./avatar.json]
//
// URLs must be https and publicly reachable (private/loopback hosts are
// refused with `invalid_url`); a URL that cannot be downloaded answers
// `fetch_failed`.

import { readFile } from 'node:fs/promises';

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
if (!args.image || !args.voice) {
  console.error('Pass --image <https url> and --voice <https url>.');
  process.exit(1);
}

const here = new URL('.', import.meta.url).pathname;
const manifest = JSON.parse(await readFile(args.manifest ?? `${here}avatar.example.json`, 'utf8'));
manifest.assets = {
  image: { url: args.image },
  voice: { url: args.voice },
  ...(args.prompt ? { prompt: { url: args.prompt } } : {}),
  ...(args.knowledge.length ? { knowledge: args.knowledge.map((url) => ({ url })) } : {}),
};
// assets.prompt and persona.scenario are mutually exclusive.
if (args.prompt && manifest.persona?.scenario) delete manifest.persona.scenario;

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
  headers: { 'X-Api-Key': API_KEY, 'Content-Type': 'application/json' },
  body: JSON.stringify(manifest),
});
const created = await readJson(createRes);
if (!createRes.ok) {
  console.error(`Create failed (${createRes.status}):`, created);
  process.exit(1);
}
console.log(`Created ${created.avatarId} - status: ${created.status}`);

const statusUrl = `${API_BASE_URL}${created.statusUrl}`;
let transientFailures = 0;
for (;;) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const res = await fetch(statusUrl, { headers: { 'X-Api-Key': API_KEY } });
  const status = await readJson(res);
  if (!res.ok) {
    if (res.status >= 500 && ++transientFailures <= 5) continue;
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
    if (status.previewUrls) console.log('Preview clips:', status.previewUrls);
    break;
  }
  if (status.status === 'failed' || status.status === 'moderation_hold') {
    console.error(`\nBuild ended in "${status.status}":`, status);
    process.exit(1);
  }
}
