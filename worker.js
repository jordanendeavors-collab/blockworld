// Green Mask Blockworld: one Cloudflare Worker that serves the game AND runs Play Together.
// The game connects back to the same address it was loaded from, so nothing needs editing.
// Deployed automatically by Cloudflare when this GitHub repo changes.

const MAX_PEERS = 16, MAX_MSG = 8192, RATE = 60;
const TOPICS = new Set(['blk', 'sync']);
const HIDDEN = /^\/(worker\.js|wrangler\.toml|README\.(txt|md)|package(-lock)?\.json|\.assetsignore|\.git(\/|$)|node_modules(\/|$))/i;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/room/')) {
      const origin = req.headers.get('Origin') || '';
      const extra = (env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
      let sameHost = false; try { sameHost = new URL(origin).host === url.host; } catch (e) {}
      if (!sameHost && !extra.includes(origin)) return new Response('Not allowed', { status: 403 });
      const name = decodeURIComponent(url.pathname.slice(6)).toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 48);
      if (!name) return new Response('Missing room', { status: 400 });
      if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(name)).fetch(req);
    }
    if (url.pathname === '/health') return new Response('Green Mask Blockworld is running.', { headers: { 'content-type': 'text/plain' } });
    if (HIDDEN.test(url.pathname)) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(req);
  }
};

export class Room {
  constructor(state, env) { this.state = state; this.peers = new Map(); }
  broadcast(obj, except) {
    const s = JSON.stringify(obj);
    for (const [id, p] of this.peers) if (id !== except) { try { p.ws.send(s); } catch (e) {} }
  }
  async fetch(req) {
    if (this.peers.size >= MAX_PEERS) return new Response('World is full', { status: 429 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const id = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    const peer = { ws: server, p: {}, tokens: RATE * 2, last: Date.now() };
    server.send(JSON.stringify({ t: 'hello', you: id, peers: [...this.peers].map(([pid, q]) => ({ peer: pid, p: q.p })) }));
    this.peers.set(id, peer);
    this.broadcast({ t: 'joined', peer: id }, id);
    server.addEventListener('message', ev => {
      const now = Date.now();
      peer.tokens = Math.min(RATE * 2, peer.tokens + (now - peer.last) / 1000 * RATE); peer.last = now;
      if (peer.tokens < 1) return; peer.tokens -= 1;
      if (typeof ev.data !== 'string' || ev.data.length > MAX_MSG) return;
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'pres' && m.p && typeof m.p === 'object') { peer.p = m.p; this.broadcast({ t: 'pres', peer: id, p: m.p }, id); }
      else if (m.t === 'emit' && TOPICS.has(m.topic)) this.broadcast({ t: 'msg', from: id, topic: m.topic, data: m.data }, id);
    });
    const bye = () => { if (this.peers.delete(id)) this.broadcast({ t: 'left', peer: id }); };
    server.addEventListener('close', bye);
    server.addEventListener('error', bye);
    return new Response(null, { status: 101, webSocket: client });
  }
}
