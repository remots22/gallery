/**
 * Cloudflare Worker — GitHub Gallery Upload Proxy
 *
 * Env vars (set via `wrangler secret put`):
 *   GITHUB_TOKEN   — fine-grained token, Contents: Read+Write on this repo
 *   GITHUB_OWNER   — GitHub username / org
 *   GITHUB_REPO    — repo name
 *   GITHUB_BRANCH  — branch (default: main)
 *   ALLOWED_ORIGIN — gallery URL for CORS
 *
 * POST /upload  — multipart fields: file, category (pildid|videod|muu), year (e.g. 2023)
 * GET  /health  — liveness check
 */

const MAX_BYTES = 25 * 1024 * 1024;

const ALLOWED_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/avif','image/svg+xml','image/bmp',
  'video/mp4','video/webm','video/quicktime',
  'application/pdf','application/zip','text/plain','text/markdown',
  'application/octet-stream','application/json', // chunks + manifests
]);

const VALID_CATEGORIES = new Set(['pildid','videod','muu']);

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    if (request.method === 'OPTIONS')
      return new Response(null, { status:204, headers: cors(origin) });

    const url = new URL(request.url);
    if (url.pathname === '/health' && request.method === 'GET') return json({ ok:true }, 200, origin);
    if (url.pathname === '/upload' && request.method === 'POST') return handleUpload(request, env, origin);
    return json({ error:'not found' }, 404, origin);
  },
};

async function handleUpload(request, env, origin) {
  const { GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main' } = env;
  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO)
    return json({ error:'worker not configured' }, 500, origin);

  let fd;
  try { fd = await request.formData(); }
  catch { return json({ error:'expected multipart/form-data' }, 400, origin); }

  const file = fd.get('file');
  if (!file || typeof file === 'string') return json({ error:'missing file field' }, 400, origin);

  // Validate MIME
  if (!ALLOWED_TYPES.has(file.type)) return json({ error:`type "${file.type}" not allowed` }, 415, origin);

  // Validate size
  const buffer = await file.arrayBuffer();
  if (buffer.byteLength > MAX_BYTES) return json({ error:`too large (max 25 MB)` }, 413, origin);

  // Category and year (sent by client, validated here)
  const rawCat  = (fd.get('category') || '').toLowerCase();
  const rawYear = (fd.get('year')     || '').replace(/\D/g, '').slice(0,4);
  const category = VALID_CATEGORIES.has(rawCat) ? rawCat : 'muu';
  const year     = /^\d{4}$/.test(rawYear) ? rawYear : String(new Date().getFullYear());

  // Sanitize filename (client already prefixed with timestamp, so no extra prefix needed)
  const storedName = file.name
    .replace(/[/\\]/g, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-zA-Z0-9._\-]/g, '')
    .slice(0, 200) || `upload_${Date.now()}`;

  const filePath = `${category}/${year}/${storedName}`;
  const apiUrl   = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${filePath}`;

  const ghHeaders = {
    'Authorization': `token ${GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'github-gallery-worker/1.0',
    'Content-Type': 'application/json',
  };

  // Check if file already exists (needed for its SHA to overwrite)
  let sha;
  const existing = await fetch(apiUrl, { method:'GET', headers: ghHeaders });
  if (existing.ok) {
    const data = await existing.json();
    sha = data.sha;
  }

  const body = JSON.stringify({
    message: `upload ${storedName}`,
    content: toBase64(buffer),
    branch:  GITHUB_BRANCH,
    ...(sha ? { sha } : {}),
  });

  const ghRes = await fetch(apiUrl, { method:'PUT', headers: ghHeaders, body });
  if (!ghRes.ok) {
    const e = await ghRes.text();
    console.error('github api error:', ghRes.status, e);
    return json({ error:'failed to commit to github' }, 502, origin);
  }

  const ghData = await ghRes.json();
  return json({
    ok: true,
    path: filePath,
    url:  ghData.content?.html_url,
  }, 201, origin);
}

// ── helpers ────────────────────────────────────────────────────────────────
function cors(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type':'application/json', ...cors(origin) },
  });
}
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let s = '';
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
