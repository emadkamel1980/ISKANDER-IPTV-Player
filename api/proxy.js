/*
 * ISKANDER — IPTV Player on Web · same-site proxy for Vercel (Node.js runtime)
 *
 * Why it exists: Vercel always serves the site over https://. Browsers then block every request from the
 * page to an http:// IPTV server ("mixed content"), so lists, posters and playback fail even though the
 * same file works when opened from the computer. This function relays those requests from the site's own
 * https address. The app uses it only when it has to.
 *
 * What it will relay, and nothing else:
 *  - GET / HEAD requests made by this site's own pages (Sec-Fetch-Site, or Origin/Referer, must match);
 *  - Xtream Codes paths (player_api.php, get.php, xmltv.php, /live/, /movie/, /series/, /timeshift/, /hls/ …)
 *    and media or image files, on public addresses only (never localhost or private networks);
 *  - optional lock: set the environment variable ALLOWED_HOSTS in the Vercel project, for example
 *    "myserver.com:8080,cdn.myserver.com", to allow only your own servers (images from other hosts are then refused).
 *
 * Video goes through in pieces of at most 4 MB per request (HLS segments, byte ranges); the browser asks for
 * the next piece itself, so no single request runs for long.
 */
'use strict';
const { Readable } = require('node:stream');
const dns = require('node:dns').promises;
const net = require('node:net');

const SELF = '/api/proxy';
const CHUNK = 4 * 1024 * 1024;
const ALLOWED = (process.env.ALLOWED_HOSTS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const ALLOW_PRIVATE = process.env.ISKANDER_ALLOW_PRIVATE === '1';   // only for testing on your own computer
const IPTV_PATH = /^\/(?:player_api\.php|get\.php|xmltv\.php|panel_api\.php|(?:live|movie|series|timeshift|hls|hlsr|streaming|images?)\/)/i;
const MEDIA_EXT = /\.(?:m3u8?|ts|m4s|mp4|m4v|mkv|avi|mov|webm|aac|mp3|key|vtt|srt|jpe?g|png|webp|gif|bmp|svg|ico)$/i;
const XC_SHORT = /^\/[^/]+\/[^/]+\/\d+$/;                         // http://host/user/pass/123
const PASS_REQ = ['range', 'if-range', 'user-agent', 'accept', 'accept-language'];
const PASS_RES = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag'];

function json(res, status, obj, extra){
  if (res.headersSent || res.destroyed){ try { res.end(); } catch {} return; }
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(body);
}
const fail = (res, status, code, message) => json(res, status, { error: message, code }, { 'X-Iskander-Proxy': 'error' });

function fromThisSite(req){
  const site = req.headers['sec-fetch-site'];
  if (site) return site === 'same-origin';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').toLowerCase();
  const from = req.headers.origin || req.headers.referer;
  if (!from || !host) return false;
  try { return new URL(from).host.toLowerCase() === host; } catch { return false; }
}

function privateIp(ip){
  if (net.isIPv4(ip)){
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19));
  }
  const v = String(ip).toLowerCase();
  if (v.startsWith('::ffff:')){ const r = v.slice(7); return net.isIPv4(r) ? privateIp(r) : true; }
  return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
}

async function refuse(u){
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only http and https links are relayed.';
  if (u.username || u.password) return 'Links with embedded credentials are not relayed.';
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (ALLOWED.length && !ALLOWED.includes(u.host.toLowerCase()) && !ALLOWED.includes(host)) return 'This server is not listed in ALLOWED_HOSTS.';
  if (!(IPTV_PATH.test(u.pathname) || MEDIA_EXT.test(u.pathname) || XC_SHORT.test(u.pathname))) return 'Only IPTV and media addresses are relayed.';
  if (ALLOW_PRIVATE) return '';
  if (host === 'localhost' || /\.(?:localhost|local|internal|home\.arpa)$/.test(host)) return 'Local network addresses are not relayed.';
  let ips;
  if (net.isIP(host)) ips = [host];
  else { try { ips = (await dns.lookup(host, { all: true })).map(r => r.address); } catch { return ''; } }   // fetch reports unknown hosts
  return ips.some(privateIp) ? 'Local network addresses are not relayed.' : '';
}

// HLS playlists: every segment, variant and key link is rewritten to come back through this proxy.
function rewrite(text, base){
  const wrap = u => {
    if (/^(?:data|skd):/i.test(u.trim())) return u;
    try { return SELF + '?u=' + encodeURIComponent(new URL(u.trim(), base).href); } catch { return u; }
  };
  return text.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (line.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => 'URI="' + wrap(u) + '"');
    return wrap(line);
  }).join('\n');
}

module.exports = async function handler(req, res){
  let self;
  try { self = new URL(req.url, 'http://localhost'); } catch { return fail(res, 400, 'url', 'Bad request.'); }
  if (self.searchParams.has('ping')) return json(res, 200, { iskander: 'proxy', v: 1 });
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'method', 'Only GET and HEAD requests are relayed.');
  if (!fromThisSite(req)) return fail(res, 403, 'origin', 'Only this site’s own pages can use the proxy.');
  let url;
  try { url = new URL(self.searchParams.get('u') || ''); } catch { return fail(res, 400, 'url', 'Missing or invalid link in "u".'); }

  const headers = { 'accept-encoding': 'identity' };
  for (const h of PASS_REQ) if (req.headers[h]) headers[h] = req.headers[h];
  // a large video file is relayed in pieces: an open-ended byte range is capped and the browser asks for the next one
  const bigFile = /\.(?:mp4|m4v|mkv|avi|mov|webm)$/i.test(url.pathname) || /^\/(?:movie|series)\//i.test(url.pathname);
  const m = bigFile && /^bytes=(\d+)-(\d*)$/.exec(headers.range || '');
  if (m){
    const a = Number(m[1]), b = m[2] === '' ? Infinity : Number(m[2]);
    if (b - a + 1 > CHUNK) headers.range = `bytes=${a}-${a + CHUNK - 1}`;
  }

  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, 25000);   // waiting for the server to answer
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });

  let r;
  try {
    for (let hop = 0; ; hop++){
      const why = await refuse(url);
      if (why){ clearTimeout(timer); return fail(res, 403, 'blocked', why); }
      // playlists are always fetched whole, they are rewritten below
      const hh = { ...headers };
      if (/\.m3u8$/i.test(url.pathname)){ delete hh.range; delete hh['if-range']; }
      r = await fetch(url, { method: req.method, headers: hh, redirect: 'manual', signal: ctrl.signal });
      const loc = r.status >= 300 && r.status < 400 && r.headers.get('location');
      if (!loc) break;
      if (hop >= 5){ clearTimeout(timer); return fail(res, 508, 'redirects', 'Too many redirects.'); }
      try { await r.body?.cancel(); } catch {}
      url = new URL(loc, url);
    }
  } catch (e){
    clearTimeout(timer);
    if (timedOut) return fail(res, 504, 'timeout', 'The IPTV server did not answer in time.');
    if (ctrl.signal.aborted) return;                                              // the viewer went away
    const why = (e && e.cause && (e.cause.code || e.cause.name)) || (e && e.name) || 'error';
    return fail(res, 502, 'unreachable', `Could not reach the IPTV server (${why}).`);
  }
  clearTimeout(timer);

  const type = r.headers.get('content-type') || '';
  const out = {
    'Cache-Control': r.ok && /^image\//i.test(type) ? 'public, max-age=86400, s-maxage=604800' : 'no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };

  const hls = req.method === 'GET' && r.ok &&
    (/\.m3u8$/i.test(url.pathname) || (/mpegurl/i.test(type) && !/\/get\.php$/i.test(url.pathname)));
  if (hls){
    let text;
    try { text = await r.text(); } catch { return fail(res, 502, 'unreachable', 'The IPTV server closed the connection.'); }
    const isHls = /#EXT-X-/i.test(text);
    const body = Buffer.from(isHls ? rewrite(text, url) : text, 'utf8');
    res.writeHead(r.status === 206 ? 200 : r.status, { ...out, 'Content-Type': isHls ? 'application/vnd.apple.mpegurl' : (type || 'text/plain'), 'Content-Length': body.length });
    return res.end(body);
  }

  const hdr = { ...out };
  for (const h of PASS_RES){ const v = r.headers.get(h); if (v != null) hdr[h] = v; }
  if (r.headers.get('content-encoding')) delete hdr['content-length'];
  res.writeHead(r.status, hdr);
  if (req.method === 'HEAD' || !r.body) return res.end();
  Readable.fromWeb(r.body).on('error', () => res.destroy()).pipe(res);
};
