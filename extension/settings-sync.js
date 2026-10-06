'use strict';
/* Personal settings bound to user + key (server 4.16+: GET/POST /api/me/settings).

   `prefs` in chrome.storage.local stays the ACTIVE profile (the service worker and older code read it unchanged).
   Each identity "<userId>:<keyId>" has its own saved profile (settingsProfiles9) and a server copy:
   - switching key/user saves the current profile and loads that identity's own (never another user's);
   - the first identity seen on a device adopts the pre-9.4 settings once (settingsLegacyOwner9 records who);
   - changes are pushed (debounced) with the version they were based on; a conflict (another device saved first)
     merges per key: the server copy plus the keys changed here;
   - device-only values (window mode, link browser, last tab, migration flags) never leave the device;
   - cached feeds/results of another identity are dropped when the identity changes.
   Pure JavaScript with injected storage/client/clock: unit-tested in Node. */
(function (root) {
  const LOCAL_ONLY = Object.freeze(['linkBrowser', 'openMode', 'lastTab', 'ui900', 'ux930', 'liveOddsProvider', 'liveOddsMode']);
  const PROFILE_LIMIT = 8;
  const IDENTITY_CACHES = ['lastKnown9:live', 'lastKnown9:prematch', 'lastKnown9:results', 'lastKnown9:history'];
  const personal = (prefs = {}) => Object.fromEntries(Object.entries(prefs).filter(([k]) => !LOCAL_ONLY.includes(k)));
  const deviceOnly = (prefs = {}) => Object.fromEntries(Object.entries(prefs).filter(([k]) => LOCAL_ONLY.includes(k)));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const identityOf = (me) => (me && me.principal && !me.principal.anonymous && me.principal.id ? `${me.principal.id}:${me.keyId || ''}` : null);

  function create({ storage, client, getPrefs, applyPrefs, defaults = {}, debounceMs = 1500, setTimer = setTimeout, clearTimer = clearTimeout, log = () => {} }) {
    let id = null, profile = null, timer = 0, pushing = null, available = true;
    const status = { state: 'local', at: 0, error: '' };
    async function loadProfiles() {
      const saved = await storage.get(['settingsProfiles9', 'settingsLegacyOwner9', 'settingsCacheOwner9']);
      return { profiles: saved.settingsProfiles9 || {}, legacyOwner: saved.settingsLegacyOwner9 || '', cacheOwner: saved.settingsCacheOwner9 || '' };
    }
    async function saveProfile() {
      if (!id || !profile) return;
      const { profiles } = await loadProfiles();
      profiles[id] = { prefs: personal(getPrefs()), version: profile.version, dirtyKeys: [...profile.dirtyKeys], savedAt: Date.now() };
      const ids = Object.keys(profiles).sort((a, b) => (profiles[b].savedAt || 0) - (profiles[a].savedAt || 0));
      for (const old of ids.slice(PROFILE_LIMIT)) delete profiles[old];
      await storage.set({ settingsProfiles9: profiles });
    }
    function use(prefsPersonal) {
      applyPrefs({ ...defaults, ...deviceOnly(getPrefs()), ...prefsPersonal });
    }
    // The identity reported by /api/me (or the cached copy at start-up). Calls are serialized: the cached identity at
    // start-up and the fresh /api/me answer must not switch profiles concurrently.
    let chain = Promise.resolve();
    function attach(me) { const run = chain.then(() => attachNow(me)); chain = run.catch(() => {}); return run; }
    async function attachNow(me) {
      const next = identityOf(me);
      if (next === id) return id;
      if (id) await saveProfile();
      clearTimer(timer); timer = 0;
      const state = await loadProfiles();
      if (next && state.cacheOwner && state.cacheOwner !== next) await storage.remove(IDENTITY_CACHES);
      if (next) await storage.set({ settingsCacheOwner9: next });
      id = next;
      if (!id) { profile = null; status.state = 'local'; return id; }
      let local = state.profiles[id];
      if (!local) {
        if (!state.legacyOwner) {
          // One-time import: the settings this device had before per-user profiles belong to the first identity.
          local = { prefs: personal(getPrefs()), version: 0, dirtyKeys: Object.keys(personal(getPrefs())), imported: true };
          await storage.set({ settingsLegacyOwner9: id });
        } else local = { prefs: personal(defaults), version: 0, dirtyKeys: [] };
      }
      profile = { version: Number(local.version) || 0, dirtyKeys: new Set(local.dirtyKeys || []) };
      if (!same(personal(getPrefs()), local.prefs)) use(local.prefs);
      await saveProfile();
      await pull();
      return id;
    }
    async function pull() {
      if (!id || !available) return;
      const mine = id;
      let remote;
      try { remote = await client.get('/api/me/settings?ns=ui'); }
      catch (error) {
        if (error?.status === 403 || error?.status === 404 || error?.status === 405) { available = false; status.state = 'unsupported'; return; }
        status.state = 'error'; status.error = error?.message || String(error); return;
      }
      if (mine !== id) return;
      if (remote?.payload && Number(remote.version) > profile.version) {
        // Newer copy on the server (another device): take it, then re-apply the keys changed here meanwhile.
        const merged = { ...remote.payload, ...pick(personal(getPrefs()), profile.dirtyKeys) };
        profile.version = Number(remote.version);
        use(merged);
        await saveProfile();
        if (profile.dirtyKeys.size) schedule(0); else { status.state = 'synced'; status.at = Date.now(); }
        return;
      }
      if (remote?.payload && remote.inheritedFrom && !profile.version && !profile.dirtyKeys.size) {
        // A rotated key of the same user: start from that user's settings and store them under the new key.
        use(remote.payload);
        for (const k of Object.keys(remote.payload)) profile.dirtyKeys.add(k);
        schedule(0);
        return;
      }
      if (!remote?.payload || profile.dirtyKeys.size) schedule(0);
      else { status.state = 'synced'; status.at = Date.now(); }
    }
    const pick = (obj, keys) => Object.fromEntries([...keys].filter((k) => k in obj).map((k) => [k, obj[k]]));
    function changed(keys = null) {
      if (!id || !profile) return;
      const now = personal(getPrefs());
      for (const k of keys || Object.keys(now)) profile.dirtyKeys.add(k);
      saveProfile().catch(() => {});
      schedule(debounceMs);
    }
    function schedule(ms) {
      if (!available || !id) return;
      clearTimer(timer);
      timer = setTimer(() => { timer = 0; return push().catch((e) => log(e)); }, ms);
    }
    async function push() {
      if (pushing) return pushing;
      pushing = (async () => {
        const mine = id;
        for (let attempt = 0; attempt < 3 && mine === id && profile; attempt++) {
          const payload = personal(getPrefs()), sent = new Set(profile.dirtyKeys);
          try {
            const saved = await client.post('/api/me/settings', { namespace: 'ui', baseVersion: profile.version, payload });
            if (mine !== id) return;
            profile.version = Number(saved.version) || profile.version + 1;
            for (const k of sent) if (same(personal(getPrefs())[k], payload[k])) profile.dirtyKeys.delete(k);
            status.state = 'synced'; status.at = Date.now(); status.error = '';
            await saveProfile();
            return;
          } catch (error) {
            if (error?.status === 409 && error.current) {
              const current = error.current;
              profile.version = Number(current.version) || 0;
              use({ ...(current.payload || {}), ...pick(personal(getPrefs()), profile.dirtyKeys) });
              continue;
            }
            if (error?.status === 403 || error?.status === 404 || error?.status === 405) { available = false; status.state = 'unsupported'; return; }
            status.state = 'error'; status.error = error?.message || String(error);
            return;
          }
        }
      })().finally(() => {
        pushing = null;
        // Keys changed while this push was in flight were not part of it: send them too (a failed push waits for the
        // next change instead of retrying in a loop).
        if (profile && profile.dirtyKeys.size && status.state === 'synced') schedule(debounceMs);
      });
      return pushing;
    }
    async function flush() { if (timer) { clearTimer(timer); timer = 0; await push(); } await saveProfile(); }
    return { attach, changed, pull, push, flush, identity: () => id, status: () => ({ ...status, identity: id, version: profile?.version || 0, pending: profile ? profile.dirtyKeys.size : 0 }) };
  }
  const api = { create, personal, deviceOnly, identityOf, LOCAL_ONLY, IDENTITY_CACHES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SettingsSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
