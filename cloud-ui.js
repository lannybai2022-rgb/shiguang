/* Account UI; DOM uses textContent for all account and record-derived values. */
(async function() {
  const $ = id => document.getElementById(id);
  window.cloudReady = false;
  let state = { owner: 'guest', guests: 0 }, backedUp = false, busy = false, signup = false;
  const config = window.SHIGUANG_CLOUD || {};
  window.showAccount = () => { show('screen-account'); };
  const message = text => { $('cloud-message').textContent = text; };
  const migrationButton = () => { $('cloud-migrate').disabled = busy || !backedUp || !$('cloud-consent').checked; };
  $('cloud-consent').onchange = migrationButton;
  function render(s) {
    state = s;
    $('cloud-status').textContent = s.owner === 'guest' && config.loginReady === false ? '这个版本暂未开放登录，记录仍保存在本机。' : s.message;
    $('cloud-login').hidden = s.owner !== 'guest' || config.loginReady === false;
    $('cloud-signed-in').hidden = s.owner === 'guest';
    $('cloud-email-display').textContent = s.email;
    $('cloud-count').textContent = `${cloudAccount ? cloudAccount.cache.length : 0} 片光 · ${s.pending} 片待同步`;
    $('cloud-migration').hidden = s.owner === 'guest' || !s.guests;
    $('cloud-guest-count').textContent = `这台设备还有 ${s.guests} 片未关联账号的光。先存一份备份，再确认归属。`;
    $('cloud-short-status').textContent = s.owner === 'guest' ? '仅保存在本机' : s.pending ? `${s.pending} 片待同步` : '已开启云同步';
  }
  async function action(work, fallback) {
    if (busy) return;
    busy = true; message('');
    document.querySelectorAll('#screen-account button:not(.back-btn)').forEach(b => { b.disabled = true; });
    try { await work(); }
    catch (error) { message(typeof fallback === 'function' ? fallback(error) : fallback || '操作未完成，请检查网络后重试。'); console.info('[shiguang-cloud] action.failed', { status: Number(error.status) || 0, reason: error.name }); }
    finally {
      busy = false;
      document.querySelectorAll('#screen-account button:not(.back-btn)').forEach(b => { b.disabled = false; });
      migrationButton();
    }
  }
  function authMode(next) {
    signup = next;
    $('cloud-auth-title').textContent = signup ? '创建账号' : '登录账号';
    $('cloud-auth-submit').textContent = signup ? '创建账号并同步' : '登录并同步';
    $('cloud-auth-toggle').textContent = signup ? '已有账号，去登录' : '创建新账号';
    $('cloud-confirm-field').hidden = !signup;
    $('cloud-password-confirm').required = signup;
    $('cloud-password').autocomplete = signup ? 'new-password' : 'current-password';
    $('cloud-password').minLength = signup ? 8 : 1;
    $('cloud-password').placeholder = signup ? '至少 8 位，建议使用独立密码' : '输入账号密码';
    $('cloud-password').value = ''; $('cloud-password-confirm').value = '';
  }
  $('cloud-auth-toggle').onclick = () => { if (!busy) { authMode(!signup); message(''); } };
  function authError(error) {
    if (error.code === 'invalid_credentials') return '邮箱或密码不正确，请检查后重试。';
    if (['user_already_exists','email_exists'].includes(error.code)) return '这个邮箱已有账号，请切换到登录。';
    if (error.code === 'weak_password') return '密码强度不足，请使用至少 8 位的独立密码。';
    if (['email_confirmation_required','email_not_confirmed'].includes(error.code)) return '账号服务配置尚未完成，请稍后再试。本机记录仍保留。';
    if (Number(error.status) === 429) return '尝试次数较多，请稍后再试。';
    return '操作未完成，请检查网络和填写内容后重试。';
  }
  $('cloud-login').onsubmit = event => {
    event.preventDefault();
    if (config.loginReady === false || !$('cloud-login').reportValidity()) return;
    return action(async () => {
      const email = $('cloud-email').value.trim(), password = $('cloud-password').value;
      if (signup && password.length < 8) { message('请设置至少 8 位密码。'); return; }
      if (signup && password !== $('cloud-password-confirm').value) { message('两次密码不一致，请重新确认。'); return; }
      await cloudAccount.authenticate(email, password, signup);
      authMode(false);
      message('已登录。在另一台设备使用同一套账号密码，就能接回已同步的光。');
    }, authError);
  };
  $('cloud-sync').onclick = () => action(() => cloudAccount.sync());
  $('cloud-logout').onclick = () => action(async () => {
    if (state.pending) { message('还有内容未同步，请先点“立即同步”。也可以去备份页下载一份保留。'); return; }
    await cloudAccount.logout(); $('cloud-email').value = ''; authMode(false); message('已退出当前账号。');
  }, '退出未完成。请先同步待上传的记录，并检查网络后重试。');
  function download(data, filename) {
    const blob = new Blob([JSON.stringify({ app: 'shiguang', v: 2, exported: localDate(), data: { [LS_KEY]: JSON.stringify(data) } })], {type:'application/json'});
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 2000);
  }
  $('cloud-backup-guest').onclick = () => action(async () => {
    download(await cloudAccount.guestBackup(), 'shiguang-before-cloud-' + localDate() + '.json');
    backedUp = true; message('备份已开始下载。请确认文件已保存，再勾选记录归属。');
  });
  $('cloud-migrate').onclick = () => action(async () => {
    if (!backedUp || !$('cloud-consent').checked) return;
    await cloudAccount.migrate(); backedUp = false; $('cloud-consent').checked = false;
  });
  $('cloud-open-backup').onclick = showBackup;
  if (!config.url || !config.publishableKey) {
    $('cloud-login').hidden = true;
    $('cloud-status').textContent = '这个版本尚未开启云同步，记录仍保存在这台设备。';
    window.cloudReady = true; return;
  }
  // While the account cache initializes, prevent writing into the wrong storage scope.
  document.getElementById('app').inert = true;
  const oldPreferences = {};
  for (const key of [LS_MOODLOG,LS_CARE,LS_DEED,LS_LENS]) { try { oldPreferences[key] = localStorage.getItem(key); } catch (_) {} }
  try {
    cloudAccount = await ShiguangCloud.connect({ config, legacy: load(),
      onAccount(owner) {
        cloudEpoch++; cloudOwner = owner; futureView = false; savedEntries = null; lastEntry = null; curStar = null;
        cur = { mood: null, lens: null, text: '' };
        for (const id of ['qw-input','free-input','deed-input','backup-input','cloud-password','cloud-password-confirm']) $(id).value = '';
        $('star-detail').replaceChildren(); $('sky').replaceChildren(); $('save-card').textContent = ''; $('save-response').textContent = '';
        backedUp = false; $('cloud-consent').checked = false; migrationButton();
        if (!$('screen-account').classList.contains('active')) show('screen-home');
      },
      onChange(data) {
        const changed = JSON.stringify(futureView ? savedEntries : entries) !== JSON.stringify(data);
        if (futureView) savedEntries = data; else entries = data;
        renderHome();
        if (changed && !futureView && $('screen-album').classList.contains('active')) showAlbum(curStar);
      },
      onStatus: render
    });
    cloudOwner = cloudAccount.owner;
    try {
      if (!localStorage.getItem('shiguang_guest_preferences_v2')) {
        for (const [key,value] of Object.entries(oldPreferences)) if (value !== null) localStorage.setItem('shiguang_guest:' + key, value);
        localStorage.setItem('shiguang_guest_preferences_v2','done');
      }
    } catch (_) { console.info('[shiguang-cloud] preferences.copy.failed'); }
    entries = cloudAccount.cache; renderHome(); render(state);
  } catch (error) {
    cloudBootFailed = true; cloudOwner = 'guest'; cloudAccount = null; entries = load(); renderHome();
    $('cloud-login').hidden = true; $('cloud-signed-in').hidden = true; $('cloud-migration').hidden = true;
    $('cloud-status').textContent = '云同步暂未能启动。原本机记录仍保留，请先备份已有内容，再刷新重试。';
    console.info('[shiguang-cloud] init.failed', { reason: error.name });
  } finally {
    document.getElementById('app').inert = false;
    window.cloudReady = true;
  }
})();
