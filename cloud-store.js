(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShiguangStore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const fields = ['text', 'date', 'lens', 'mood', 'resp'];
  const canonical = e => JSON.stringify(fields.map(k => e[k] || ''));
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('zh', { granularity: 'grapheme' }) : null;
  async function stableId(value) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
    bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
    const h = Array.from(bytes.slice(0, 16), x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
  }
  async function normalize(input) {
    if (!Array.isArray(input)) throw new Error('备份记录格式不正确');
    const occurrences = new Map(), result = [];
    for (const raw of input) {
      if (raw?.sample) continue;
      if (!raw || typeof raw.text !== 'string' || !raw.text.trim() || raw.text.includes('\0')) throw new Error('记录正文无效');
      const count = Array.from(segmenter ? segmenter.segment(raw.text) : raw.text).length;
      if (count > 1000) throw new Error('每条内容最多 1000 字');
      if (new TextEncoder().encode(raw.text).length > 80000) throw new Error('这条内容包含过多组合符号');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.date) || !Number.isFinite(Date.parse(raw.date)) || new Date(raw.date).toISOString().slice(0,10) !== raw.date) throw new Error('记录日期无效');
      const e = { text: raw.text, date: raw.date };
      for (const k of ['lens', 'mood', 'resp']) {
        e[k] = raw[k] == null ? '' : String(raw[k]);
        if (e[k].includes('\0') || e[k].length > (k === 'resp' ? 2000 : 64)) throw new Error('记录字段过长');
      }
      const key = canonical(e), n = occurrences.get(key) || 0;
      occurrences.set(key, n + 1);
      e.id = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.id || '') ? raw.id.toLowerCase() : await stableId(key + ':' + n);
      e.createdAt = raw.createdAt && Number.isFinite(Date.parse(raw.createdAt)) ? new Date(raw.createdAt).toISOString() : raw.date + 'T12:00:00.000Z';
      e.conflictId = await stableId('conflict:' + e.id + canonical(e));
      result.push(e);
    }
    return result;
  }
  async function createStore({ indexedDB = globalThis.indexedDB, name = 'shiguang-v2', legacy = [] } = {}) {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('entries', { keyPath: ['owner', 'id'] }).createIndex('owner', 'owner');
        request.result.createObjectStore('meta');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('请关闭其他拾光标签页后重试'));
    });
    db.onversionchange = () => db.close();
    function transaction(mode, work) {
      return new Promise((resolve, reject) => {
        const tx = db.transaction(['entries', 'meta'], mode);
        let value;
        tx.oncomplete = () => resolve(value);
        tx.onabort = tx.onerror = () => reject(tx.error || new Error('本机保存未完成'));
        try { work(tx.objectStore('entries'), tx.objectStore('meta'), v => { value = v; }); }
        catch (error) { tx.abort(); reject(error); }
      });
    }
    const all = owner => transaction('readonly', (s, m, done) => { const r = s.index('owner').getAll(owner); r.onsuccess = () => done(r.result); });
    const clean = r => { const { owner, pending, conflictId, ...e } = r; return e; };
    // All read/merge/write operations share one transaction: another tab cannot overwrite an insertion.
    function put(s, e, owner, remote) {
      const request = s.get([owner, e.id]);
      request.onsuccess = () => {
        const old = request.result;
        if (old && canonical(old) !== canonical(e)) {
          const variant = remote ? old : e;
          const forkId = variant.conflictId;
          const check = s.get([owner, forkId]);
          check.onsuccess = () => {
            if (!check.result) s.put({ ...variant, id: forkId, owner, pending: owner !== 'guest' });
          };
          if (!remote) return;
        }
        s.put({ ...e, owner, pending: remote ? false : old?.pending ?? owner !== 'guest' });
      };
    }
    const api = {
      async list(owner) { return (await all(owner)).map(clean).sort((a,b) => a.date.localeCompare(b.date) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)); },
      async pending(owner) { return (await all(owner)).filter(r => r.pending).map(clean); },
      async importEntries(input, owner) {
        const data = await normalize(input);
        await transaction('readwrite', s => data.forEach(e => put(s, e, owner, false)));
        return api.list(owner);
      },
      async mergeRemote(input, owner) {
        const data = await normalize(input);
        await transaction('readwrite', s => data.forEach(e => put(s, e, owner, true)));
        return api.list(owner);
      },
      async claimGuest(owner) {
        if (!owner || owner === 'guest') throw new Error('请先登录');
        await transaction('readwrite', s => {
          const request = s.index('owner').getAll('guest');
          request.onsuccess = () => request.result.forEach(r => { put(s, { ...clean(r), conflictId: r.conflictId }, owner, false); s.delete(['guest', r.id]); });
        });
        return api.list(owner);
      },
      close() { db.close(); }
    };
    try {
      const initial = await normalize(legacy);
      await transaction('readwrite', (s, m) => {
        const r = m.get('legacyImported');
        r.onsuccess = () => { if (!r.result) { initial.forEach(e => put(s, e, 'guest', false)); m.put(true, 'legacyImported'); } };
      });
    } catch (error) { db.close(); throw error; }
    return api;
  }
  return { createStore, normalize };
});
