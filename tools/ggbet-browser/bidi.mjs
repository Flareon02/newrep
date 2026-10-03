// Minimal WebDriver BiDi client for the Firefox Remote Agent (Node 22 global WebSocket, no dependencies).
export class Bidi {
  constructor(url) { this.url = url; this.seq = 0; this.pending = new Map(); this.handlers = new Map(); this.closed = false; }
  async connect(timeoutMs = 15000) {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => { const t = setTimeout(() => reject(Error('BiDi connect timeout')), timeoutMs); this.ws.onopen = () => { clearTimeout(t); resolve(); }; this.ws.onerror = (e) => { clearTimeout(t); reject(Error('BiDi connect failed')); }; });
    this.ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id != null && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); m.type === 'error' ? reject(Object.assign(Error(`${m.error}: ${m.message}`), { bidi: m })) : resolve(m.result); return; }
      if (m.type === 'event') for (const fn of this.handlers.get(m.method) || []) { try { fn(m.params); } catch {} }
    };
    this.ws.onclose = () => { this.closed = true; for (const { reject } of this.pending.values()) reject(Error('BiDi closed')); this.pending.clear(); for (const fn of this.handlers.get('__close') || []) fn(); };
    return this;
  }
  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(Error('BiDi closed'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => { const t = setTimeout(() => { this.pending.delete(id); reject(Error(`BiDi timeout: ${method}`)); }, timeoutMs); this.pending.set(id, { resolve: (r) => { clearTimeout(t); resolve(r); }, reject: (e) => { clearTimeout(t); reject(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  close() { try { this.ws.close(); } catch {} }
}
