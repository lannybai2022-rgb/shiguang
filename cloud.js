/* The official SDK owns auth; this module queues immutable records and never logs content. */
(function(root) {
  'use strict';
  const fromRow = r => ({ id: r.id, text: r.content, date: r.local_date, lens: r.lens, mood: r.mood, resp: r.response, createdAt: r.client_created_at });
  const toRow = (e, owner) => ({ owner_id: owner, id: e.id, content: e.text, local_date: e.date, lens: e.lens, mood: e.mood, response: e.resp, client_created_at: e.createdAt });
  async function connect({ config, legacy, onChange, onStatus, onAccount, client, indexedDB, name }) {
    const store = await root.ShiguangStore.createStore({ legacy, indexedDB, name });
    client ||= root.ShiguangSupabase.createClient(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      global: { fetch: (input, init) => fetch(input, { ...init, signal: init?.signal || AbortSignal.timeout(20000) }) }
    });
    let owner = 'guest', session = null, generation = 0, running = null, again = false, closed = false, cache = [];
    const diagnostic = (event, counts = {}) => console.info('[shiguang-cloud]', event, counts);
    async function refresh(expected = owner, version = generation) {
      const data = await store.list(expected);
      if (expected === owner && version === generation && !closed) { cache = data; onChange(data); }
      return data;
    }
    async function status(message) {
      const version = generation, who = owner;
      const pending = (await store.pending(who)).length;
      const guests = (await store.list('guest')).length;
      if (version === generation && !closed) onStatus({ message, pending, guests, owner, email: session?.user.email || '' });
    }
    async function pull(who) {
      const all = [];
      for (let start = 0; ; start += 500) {
        const { data, error } = await client.from('shiguang_entries').select('*').eq('owner_id', who).order('id').range(start, start + 499);
        if (error) throw error;
        all.push(...data.map(fromRow));
        if (data.length < 500) return all;
      }
    }
    async function sync() {
      if (closed || owner === 'guest') return;
      if (running) { again = true; return running; }
      const who = owner, version = generation;
      if (root.navigator?.onLine === false) { await status('离线中，内容已保存在这台设备，联网后会继续同步。'); return; }
      running = (async () => {
        try {
          await status('正在同步…');
          // Read first: an ID collision must preserve both versions before attempting an insert.
          await store.mergeRemote(await pull(who), who);
          if (version !== generation) return;
          const pending = await store.pending(who);
          for (let i = 0; i < pending.length; i += 100) {
            if (version !== generation) return;
            const { error } = await client.from('shiguang_entries').upsert(pending.slice(i, i + 100).map(e => toRow(e, who)), { onConflict: 'owner_id,id', ignoreDuplicates: true });
            if (error) throw error;
          }
          await store.mergeRemote(await pull(who), who);
          if (version !== generation) return;
          await refresh(who, version);
          const left = (await store.pending(who)).length;
          await status(left ? '有新内容待同步，可点“立即同步”继续。' : '所有记录已同步。');
          diagnostic('sync.complete', { uploaded: pending.length, pending: left });
        } catch (error) {
          if (version === generation) await status('暂时连不上云端，内容仍在本机。请联网后重试，或重新登录。');
          diagnostic('sync.failed', { status: Number(error.status) || 0 });
        }
      })();
      await running;
      running = null;
      if (again) { again = false; return sync(); }
    }
    async function activate(nextSession) {
      if (closed) return;
      const nextOwner = nextSession?.user.id || 'guest';
      session = nextSession;
      if (nextOwner !== owner) {
        generation++; owner = nextOwner; cache = [];
        onAccount(owner); onChange([]);
      }
      await refresh();
      await status(owner === 'guest' ? '未登录，记录保存在这台设备。' : '已登录，准备同步。');
      void sync();
    }
    const { data: { subscription } } = client.auth.onAuthStateChange((event, next) => {
      // Defer SDK calls outside its auth lock. Refreshing a token must not reset a writing draft.
      if (event !== 'INITIAL_SESSION' && event !== 'TOKEN_REFRESHED') setTimeout(() => {
        activate(next).catch(() => status('账号加载未完成，请刷新后重试。'));
      }, 0);
    });
    const { data, error } = await client.auth.getSession();
    if (error) { subscription.unsubscribe(); store.close(); throw error; }
    await activate(data.session);
    const resume = () => { refresh().then(sync).catch(() => status('本机数据读取失败，请先保留当前页面。')); };
    const visible = () => { if (root.document?.visibilityState === 'visible') resume(); };
    root.addEventListener?.('online', resume); root.addEventListener?.('focus', resume);
    root.document?.addEventListener('visibilitychange', visible);
    return {
      get owner() { return owner; }, get cache() { return cache; },
      async save(data) {
        const who = owner, version = generation;
        await store.importEntries(data, who);
        const records = await refresh(who, version);
        if (version !== generation) throw new Error('账号已切换，内容保存在原账号本机队列');
        await status(owner === 'guest' ? '已保存在这台设备。' : '已存到本机，等待同步。');
        void sync(); return records;
      },
      async guestBackup() { return store.list('guest'); },
      async migrate() {
        const who = owner, version = generation;
        await store.claimGuest(who);
        if (version === generation) { await refresh(); await status('本机记录已关联，正在同步。'); void sync(); }
      },
      async authenticate(email, password, signup = false) {
        const { data, error } = await (signup ? client.auth.signUp({ email, password }) : client.auth.signInWithPassword({ email, password }));
        if (error) throw error;
        if (!data.session) throw Object.assign(new Error('Account configuration requires confirmation'), { code: 'email_confirmation_required' });
        await activate(data.session);
      },
      async logout() {
        if ((await store.pending(owner)).length) throw new Error('还有内容未同步。请先同步成功，或下载备份后再退出。');
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw error;
        await activate(null);
      },
      sync,
      close() { closed = true; generation++; subscription.unsubscribe(); store.close(); root.removeEventListener?.('online', resume); root.removeEventListener?.('focus', resume); root.document?.removeEventListener('visibilitychange', visible); }
    };
  }
  root.ShiguangCloud = { connect };
})(typeof globalThis !== 'undefined' ? globalThis : this);
