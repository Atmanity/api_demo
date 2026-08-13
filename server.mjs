import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const API_KEY   = process.env.ATMEE_API_KEY;     // sk_atmee_… stays here
const AVATAR_ID = process.env.ATMEE_AVATAR_ID;
// Override for local/staging testing. Real integrations should leave this
// unset and use the default production endpoint.
const API_BASE_URL = process.env.ATMEE_API_BASE_URL ?? 'https://api.atmanity.us';

createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/session') {
    const upstream = await fetch(`${API_BASE_URL}/v1/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
      body: JSON.stringify({ avatarId: AVATAR_ID }),
      signal: AbortSignal.timeout(120_000),          // starting an avatar takes a while
    });
    if (!upstream.ok) {
      console.error('atmee:', upstream.status, await upstream.text());
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'could not start session' }));
      return;
    }
    // Hand the page only what it needs to join the room.
    const { serverUrl, userToken } = await upstream.json();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ serverUrl, userToken }));
    return;
  }
  // Two example pages: the bare player at / and a fake hotel site with a
  // floating bottom-right avatar widget at /widget.
  const page = req.url.startsWith('/widget') ? './widget.html' : './index.html';
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(await readFile(new URL(page, import.meta.url)));
}).listen(3000);

console.log('Listening on http://localhost:3000');
