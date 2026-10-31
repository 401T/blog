/* パスワード付きブログ（ビルド不要版）
 * 記事・画像・一覧はすべて，パスワードから導いた鍵で暗号化したファイル（data/*.bin）として
 * リポジトリに置く．閲覧時にブラウザの中で復号し，Markdown を変換して jlreq.js で組む．
 * 投稿画面（editor.js）は GitHub API で暗号文を直接コミットする．
 */
(function () {
  'use strict';
  const app = document.getElementById('app');
  const logoutBtn = document.querySelector('.logout');
  const writeLink = document.querySelector('.write-link');
  const V = (document.currentScript.src.split('v=')[1] || '1');
  const subtle = crypto.subtle;
  const te = new TextEncoder(), td = new TextDecoder();
  const API = 'https://api.github.com';
  const ED_KEY = 'blog-editor';
  let meta = null, key = null, index = null;
  const postCache = new Map(), imgCache = new Map();
  let freshUntil = 0;   // 自分で保存した直後は Pages の反映を待たずに GitHub から直接読む

  // ---------------------------------------------------------------- 基本版面（JIS X 4051 7.4.1）
  let hanmen = { fs: 0, cpl: 0 };
  function setHanmen() {
    const vw = document.documentElement.clientWidth;
    const fs = vw >= 720 ? 17 : 16;
    const avail = vw - 2 * 16 - 4;   // 左右の余白と箱の枠線
    let cpl = Math.min(36, Math.floor(avail / fs));
    let size = fs;
    if (cpl < 15) { cpl = 15; size = Math.floor(avail / 15); }
    const gap = cpl > 30 ? 0.8 : 0.7;
    const r = document.documentElement.style;
    r.setProperty('--fs', size + 'px');
    r.setProperty('--gap', gap + 'em');
    r.setProperty('--lf', (size * (1 + gap)) + 'px');
    r.setProperty('--colw', (cpl * size) + 'px');
    const changed = hanmen.fs !== size || hanmen.cpl !== cpl;
    const fsChanged = hanmen.fs !== size;
    hanmen = { fs: size, cpl, gap, lf: size * (1 + gap) };
    return { changed, fsChanged };
  }
  setHanmen();

  // ---------------------------------------------------------------- バイト列・暗号
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s.replace(/\s/g, '')), c => c.charCodeAt(0));
  const randId = (n = 12) => b64(crypto.getRandomValues(new Uint8Array(n))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const pipe = async (u8, t) => new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(t)).arrayBuffer());
  async function seal(u8, k = key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, k, await pipe(u8, new CompressionStream('gzip'))));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    return out;
  }
  async function unseal(u8, k = key) {
    const p = await subtle.decrypt({ name: 'AES-GCM', iv: u8.slice(0, 12) }, k, u8.slice(12));
    return pipe(new Uint8Array(p), new DecompressionStream('gzip'));
  }
  async function deriveKey(password, kdf) {
    const base = await subtle.importKey('raw', te.encode(password.normalize(kdf.norm || 'NFC')), 'PBKDF2', false, ['deriveBits']);
    const raw = new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: kdf.hash, iterations: kdf.iterations, salt: unb64(kdf.salt) }, base, 256));
    return { raw, key: await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']) };
  }
  const newKdf = () => ({ name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: b64(crypto.getRandomValues(new Uint8Array(16))), norm: 'NFKC' });
  const importRaw = (s) => subtle.importKey('raw', unb64(s), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const sealJSON = (o, k) => seal(te.encode(JSON.stringify(o)), k);
  const unsealJSON = async (u8, k) => JSON.parse(td.decode(await unseal(u8, k)));

  // ---------------------------------------------------------------- 端末に保存する設定
  function edSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(ED_KEY) || '{}'); } catch (e) { /* */ }
    return { token: s.token || '', repo: s.repo || guessRepo(), branch: s.branch || 'main' };
  }
  function saveEdSettings(s) { try { localStorage.setItem(ED_KEY, JSON.stringify(s)); } catch (e) { /* */ } }
  function guessRepo() {
    const h = location.hostname;
    if (!h.endsWith('.github.io')) return '';
    const owner = h.split('.')[0];
    const seg = location.pathname.split('/').filter(Boolean)[0];
    return owner + '/' + (seg && !seg.includes('.') ? seg : h);
  }
  const storeName = () => 'blogkey:' + (meta ? meta.site : '');
  function saveKey(raw, remember) {
    try {
      sessionStorage.setItem(storeName(), b64(raw));
      if (remember) localStorage.setItem(storeName(), b64(raw));
    } catch (e) { /* */ }
  }
  function loadKey() { try { return sessionStorage.getItem(storeName()) || localStorage.getItem(storeName()); } catch (e) { return null; } }
  function forgetKey() { try { sessionStorage.removeItem(storeName()); localStorage.removeItem(storeName()); } catch (e) { /* */ } }

  // ---------------------------------------------------------------- GitHub API
  async function gh(method, path, body, accept) {
    const S = edSettings();
    const res = await fetch(`${API}/repos/${S.repo}${path}`, {
      method, cache: 'no-store',
      headers: {
        Authorization: `Bearer ${S.token}`,
        Accept: accept || 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let msg = '';
      try { msg = (await res.json()).message || ''; } catch (e) { /* */ }
      const err = new Error(`${res.status} ${msg}`);
      err.status = res.status;
      throw err;
    }
    if (accept && accept.includes('raw')) return new Uint8Array(await res.arrayBuffer());
    return res.status === 204 ? null : res.json();
  }
  const ghRaw = (path) => gh('GET', `/contents/${path}?ref=${encodeURIComponent(edSettings().branch)}`, null, 'application/vnd.github.raw+json');
  const canUseApi = () => { const s = edSettings(); return !!(s.token && s.repo); };

  // 複数ファイルの追加・変更・削除を1コミットにまとめる
  async function commit(message, changes) {
    const S = edSettings();
    const ref = await gh('GET', `/git/ref/heads/${encodeURIComponent(S.branch)}`);
    const base = await gh('GET', `/git/commits/${ref.object.sha}`);
    const tree = [];
    for (const c of changes) {
      if (c.delete) { tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null }); continue; }
      const content = typeof c.data === 'string' ? te.encode(c.data) : c.data;
      const b = await gh('POST', '/git/blobs', { content: b64(content), encoding: 'base64' });
      tree.push({ path: c.path, mode: '100644', type: 'blob', sha: b.sha });
    }
    const t = await gh('POST', '/git/trees', { base_tree: base.tree.sha, tree });
    const cm = await gh('POST', '/git/commits', { message, tree: t.sha, parents: [ref.object.sha] });
    await gh('PATCH', `/git/refs/heads/${encodeURIComponent(S.branch)}`, { sha: cm.sha });
    freshUntil = Date.now() + 10 * 60 * 1000;
    try { sessionStorage.setItem('blog-fresh', String(freshUntil)); } catch (e) { /* */ }
    return cm.sha;
  }
  try { freshUntil = +sessionStorage.getItem('blog-fresh') || 0; } catch (e) { /* */ }

  // data/ 以下のファイルを読む（保存直後は GitHub から，それ以外はこのサイトから）
  async function readData(name, json) {
    const viaApi = async () => ghRaw('data/' + name);
    if (canUseApi() && Date.now() < freshUntil) {
      try { const u8 = await viaApi(); return json ? JSON.parse(td.decode(u8)) : u8; } catch (e) { if (e.status !== 404) throw e; }
    }
    const res = await fetch('data/' + name + '?t=' + Math.floor(Date.now() / 60000), { cache: 'no-cache' });
    if (res.ok) return json ? res.json() : new Uint8Array(await res.arrayBuffer());
    if (res.status === 404 && canUseApi()) {
      try { const u8 = await viaApi(); return json ? JSON.parse(td.decode(u8)) : u8; } catch (e) { /* */ }
    }
    const err = new Error('not found: ' + name);
    err.status = res.status;
    throw err;
  }
  async function loadIndex(k = key) { return unsealJSON(await readData('index.bin'), k); }
  async function loadPost(file) {
    if (postCache.has(file)) return postCache.get(file);
    const p = await unsealJSON(await readData('p-' + file + '.bin'));
    postCache.set(file, p);
    return p;
  }
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };
  async function imageUrl(id) {
    if (imgCache.has(id)) return imgCache.get(id);
    const bytes = await unseal(await readData('i-' + id + '.bin'));
    const url = URL.createObjectURL(new Blob([bytes], { type: MIME[id.split('.').pop()] || '' }));
    imgCache.set(id, url);
    return url;
  }

  // ---------------------------------------------------------------- Markdown → 記事
  let mdLib = null;
  function markdownLib() {
    if (!mdLib) mdLib = import('./markdown.js?v=' + V);
    return mdLib;
  }
  const imageIds = (md) => Array.from(new Set(Array.from(md.matchAll(/\]\(\s*img:([\w-]+\.[a-z]+)/g)).map(m => m[1])));
  async function renderArticleInto(target, post, pending) {
    const lib = await markdownLib();
    const urls = new Map();
    await Promise.all(imageIds(post.md).map(async id => {
      if (pending && pending.has(id)) { urls.set(id, pending.get(id).url); return; }
      try { urls.set(id, await imageUrl(id)); } catch (e) { /* */ }
    }));
    const md = lib.createMarkdown({
      MarkdownIt: window.markdownit, katex: window.katex, macros: (meta && meta.macros) || {},
      resolveAsset: (src) => {
        const m = /^img:(.+)$/.exec(src);
        return m && urls.get(m[1]) ? { url: urls.get(m[1]) } : null;
      },
    });
    const env = { file: '' };
    const html = md.render(post.md, env) + lib.renderFootnotes(md, env);
    const art = document.createElement('article');
    const meta2 = [post.date ? `<time datetime="${esc(post.date)}">${esc(fmtDate(post.date))}</time>` : '', ...(post.tags || []).map(esc), post.draft ? '下書き' : ''].filter(Boolean).join('　');
    art.innerHTML = `<div class="post-box"><header class="post-head"><h1 class="post-title">${esc(post.title || '（無題）')}</h1>${meta2 ? `<p class="post-meta no-jl">${meta2}</p>` : ''}</header><div class="post-body">${html}</div></div>`;
    art.querySelectorAll('.post-body ol[start]').forEach(ol => { ol.style.counterReset = 'item ' + (parseInt(ol.getAttribute('start'), 10) - 1); });
    target.replaceChildren(art);
    await Promise.all(Array.from(art.querySelectorAll('img')).map(img => img.decode().catch(() => {})));
    await typeset(art);
    return art;
  }

  // ---------------------------------------------------------------- 表示
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmtDate(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || '');
    return m ? `${+m[1]}年${+m[2]}月${+m[3]}日` : (d || '');
  }

  async function typeset(root) {
    root.classList.add('pending');
    const text = root.textContent;
    const fams = ['400 1em "Noto Serif JP"', '700 1em "Noto Serif JP"'];
    try {
      await Promise.race([
        Promise.all(fams.map(f => document.fonts.load(f, text))).then(() => document.fonts.ready),
        new Promise(r => setTimeout(r, 4000)),
      ]);
    } catch (e) { /* */ }
    JLReq.composeAll(root);
    applyGyodori(root);
    root.classList.remove('pending');
  }
  // 見出しの行取り（JIS X 4051 8.3.3 d）
  function applyGyodori(root) {
    const lf = hanmen.lf;
    root.querySelectorAll('.post-title, .post-body h1, .post-body h2, .post-body h3, .post-body h4, .post-body h5, .post-body h6').forEach(h => {
      h.style.minHeight = '';
      const min = h.classList.contains('post-title') ? 2 : /^H[12]$/.test(h.tagName) ? 3 : 2;
      const n = Math.max(min, Math.ceil(h.getBoundingClientRect().height / lf - 0.01));
      h.style.minHeight = (n * lf) + 'px';
    });
  }

  // 入力のゆれ（スマホでの先頭の自動大文字化，日本語入力による全角英数字，
  // スマート句読点，前後の空白）があっても，決めたときと同じパスワードとして扱う
  function passwordCandidates(pw) {
    const toFull = (t) => t.replace(/[!-~]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0)).replace(/ /g, '\u3000');
    const smart = (t) => t.replace(/'/g, '\u2019').replace(/"/g, '\u201D').replace(/--/g, '\u2014').replace(/\.\.\./g, '\u2026');
    const capFirst = (t) => t.charAt(0).toUpperCase() + t.slice(1);
    const lowFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
    const base = [pw, pw.trim(), pw.normalize('NFKC'), pw.normalize('NFKC').trim()];
    const out = [];
    for (const b of base) for (const f of [t => t, capFirst, lowFirst]) {
      const x = f(b);
      out.push(x, smart(x), toFull(x), x + ' ');
    }
    return Array.from(new Set(out)).filter(Boolean);
  }

  function showLogin(message) {
    logoutBtn.hidden = true; writeLink.hidden = true;
    app.replaceChildren(document.getElementById('login').content.cloneNode(true));
    const form = app.querySelector('form');
    const msg = form.querySelector('.login-msg');
    if (message) msg.textContent = message;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button');
      btn.disabled = true;
      msg.textContent = '確認しています…';
      try {
        const u8 = await readData('index.bin');
        let found = null;
        for (const cand of passwordCandidates(form.password.value)) {
          const d = await deriveKey(cand, meta.kdf);
          try { index = await unsealJSON(u8, d.key); found = d; break; } catch (e) { /* 次の候補 */ }
        }
        if (!found) throw new Error('wrong password');
        key = found.key;
        saveKey(found.raw, form.remember.checked);
        form.password.value = '';
        route();
      } catch (err) {
        msg.textContent = err.status === 404 ? 'サイトの更新が反映されていません。1〜2分待って再読み込みしてください。' : err.status ? '読み込みに失敗しました。' : 'パスワードが違います。';
        btn.disabled = false;
        form.password.select();
      }
    });
  }

  // 初期設定：パスワードを決め，暗号化した空の一覧を作る（GitHub のトークンが必要）
  function showSetup(message) {
    logoutBtn.hidden = true; writeLink.hidden = true;
    const S = edSettings();
    const el = document.createElement('section');
    el.className = 'ed';
    el.innerHTML = `
      <h2 class="ed-h">初期設定</h2>
      <p class="ed-note">このブログはまだ設定されていません。閲覧用のパスワードを決めてください。パスワードはどこにも送信されず，この画面の中で暗号の鍵に変換されます。</p>
      <label class="ed-field"><span>閲覧用パスワード（12文字以上を推奨）</span><input name="pw1" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="ed-field"><span>もう一度</span><input name="pw2" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
      <label class="ed-check"><input type="checkbox" name="show"><span>パスワードを表示する</span></label>
      <label class="ed-field"><span>リポジトリ</span><input name="repo" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="401T/blog"></label>
      <label class="ed-field"><span>GitHub のアクセストークン</span><input name="token" type="password" autocomplete="off" placeholder="github_pat_…"></label>
      ${TOKEN_HELP}
      <div class="ed-actions"><button class="ed-primary" type="button">設定する</button></div>
      <p class="ed-status" role="status">${message || ''}</p>`;
    el.querySelector('[name=repo]').value = S.repo;
    el.querySelector('[name=token]').value = S.token;
    el.querySelector('[name=show]').addEventListener('change', (e) => {
      el.querySelectorAll('[name=pw1],[name=pw2]').forEach(i => { i.type = e.target.checked ? 'text' : 'password'; });
    });
    const status = el.querySelector('.ed-status');
    el.querySelector('button.ed-primary').addEventListener('click', async (ev) => {
      const pw1 = el.querySelector('[name=pw1]').value, pw2 = el.querySelector('[name=pw2]').value;
      if (pw1.length < 8) { status.textContent = 'パスワードは8文字以上にしてください。'; return; }
      if (pw1 !== pw2) { status.textContent = '2つのパスワードが一致しません。'; return; }
      const s = { ...S, repo: normRepo(el.querySelector('[name=repo]').value), token: el.querySelector('[name=token]').value.trim() };
      saveEdSettings(s);
      ev.currentTarget.disabled = true;
      status.textContent = '確認しています…';
      try {
        try { await ghRaw('data/meta.json'); status.textContent = 'すでに設定済みです。再読み込みしてください。'; return; } catch (e) { if (e.status !== 404) throw e; }
        status.textContent = '鍵を作っています…';
        const kdf = newKdf();
        const { raw, key: k } = await deriveKey(pw1, kdf);
        const site = randId(9);
        const m = { v: 2, site, kdf, macros: { '\\R': '\\mathbb{R}', '\\dd': '\\mathrm{d}' } };
        const idx = { posts: [] };
        status.textContent = '保存しています…';
        await commit('ブログを初期設定', [
          { path: 'data/meta.json', data: JSON.stringify(m) },
          { path: 'data/index.bin', data: await sealJSON(idx, k) },
        ]);
        meta = m; key = k; index = idx;
        saveKey(raw, true);
        location.hash = '#/write';
        route();
      } catch (e) {
        status.textContent = apiErrorText(e);
        ev.currentTarget.disabled = false;
      }
    });
    app.replaceChildren(el);
  }

  async function renderList() {
    document.title = 'ブログ';
    const editing = canUseApi();
    const posts = index.posts.filter(p => editing || !p.draft).sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.ts || 0) - (a.ts || 0));
    const ul = document.createElement('ul');
    ul.className = 'posts';
    if (!posts.length) ul.innerHTML = `<li class="empty">まだ記事がありません。</li>`;
    for (const p of posts) {
      const li = document.createElement('li');
      li.innerHTML = `<time class="posts-date" datetime="${esc(p.date || '')}">${esc((p.date || '').replace(/-/g, '/'))}</time><a href="#/p/${encodeURIComponent(p.id)}"><p class="title">${esc(p.title || '（無題）')}${p.draft ? '<small>（下書き）</small>' : ''}</p></a>`;
      ul.appendChild(li);
    }
    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.appendChild(ul);
    app.replaceChildren(wrap);
    await typeset(wrap);
  }

  async function renderPost(id) {
    const p = index.posts.find(x => x.id === id);
    if (!p) { app.innerHTML = '<p class="error">記事が見つかりません。</p><p class="article-nav"><a href="#/">一覧へ</a></p>'; return; }
    const post = await loadPost(p.id);
    document.title = (post.title || '') + '｜ブログ';
    const holder = document.createElement('div');
    app.replaceChildren(holder);
    holder.classList.add('pending');
    const art = await renderArticleInto(holder, post);
    const nav = document.createElement('nav');
    nav.className = 'article-nav';
    nav.innerHTML = `<a href="#/">一覧へ</a>${canUseApi() ? `　<a href="#/write/${encodeURIComponent(p.id)}">編集する</a>` : ''}`;
    art.appendChild(nav);
    holder.classList.remove('pending');
    window.scrollTo(0, 0);
  }

  async function route() {
    if (!meta) return showSetup();
    if (!key) return showLogin();
    logoutBtn.hidden = false;
    writeLink.hidden = !canUseApi();   // 「書く」は投稿用トークンを設定した端末にだけ表示する
    const h = location.hash.replace(/^#/, '');
    const m = /^\/p\/([^#]+)/.exec(h);
    try {
      if (h.startsWith('/write')) {
        const ed = await import('./editor.js?v=' + V);
        await ed.render(app, CTX, decodeURIComponent(h.slice('/write'.length).replace(/^\//, '')));
      } else if (m) await renderPost(decodeURIComponent(m[1]));
      else await renderList();
    } catch (e) {
      console.error(e);
      app.innerHTML = '<p class="error">読み込みに失敗しました。少し待ってから再読み込みしてください。</p>';
    }
  }

  const normRepo = (s) => s.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
  const apiErrorText = (e) => e.status === 401 ? 'トークンが無効か期限切れです。'
    : e.status === 403 ? '権限が足りません。トークンの Contents が「Read and write」になっているか確認してください。'
      : e.status === 404 ? 'リポジトリが見つかりません。リポジトリ名と，トークンの対象リポジトリを確認してください。'
        : e.status === 409 || e.status === 422 ? '別の端末での更新と重なりました。もう一度保存してください。'
          : '通信に失敗しました（' + e.message + '）。';
  const TOKEN_HELP = `<details class="ed-help"><summary>トークンの作り方</summary><ol>
      <li><a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">トークン作成画面</a>を開く（Fine-grained token）。</li>
      <li>Token name は何でもよい。Expiration は好みで（切れたら作り直す）。</li>
      <li>Repository access で「Only select repositories」→ このブログのリポジトリだけを選ぶ。</li>
      <li>Permissions → Repository permissions の <b>Contents</b> を「Read and write」にする。</li>
      <li>「Generate token」を押し，表示された github_pat_… をここに貼る。</li></ol></details>`;

  async function changePassword(newPw, progress) {
    const kdf = newKdf();
    const { raw, key: nk } = await deriveKey(newPw, kdf);
    const idx = await unsealJSON(await ghRaw('data/index.bin'), key);
    const changes = [];
    let n = 0;
    for (const p of idx.posts) {
      progress(`記事を暗号化し直しています（${++n}/${idx.posts.length}）…`);
      const u8 = await unseal(await ghRaw(`data/p-${p.id}.bin`), key);
      changes.push({ path: `data/p-${p.id}.bin`, data: await seal(u8, nk) });
      const post = JSON.parse(td.decode(u8));
      for (const id of imageIds(post.md)) {
        try { changes.push({ path: `data/i-${id}.bin`, data: await seal(await unseal(await ghRaw(`data/i-${id}.bin`), key), nk) }); } catch (e) { if (e.status !== 404) throw e; }
      }
    }
    const m = { ...meta, kdf };
    changes.push({ path: 'data/index.bin', data: await sealJSON(idx, nk) });
    changes.push({ path: 'data/meta.json', data: JSON.stringify(m) });
    progress('保存しています…');
    await commit('閲覧用パスワードを変更', changes);
    meta = m; key = nk; index = idx;
    postCache.clear();
    forgetKey();
    saveKey(raw, true);
  }

  const CTX = {
    get meta() { return meta; }, get key() { return key; }, get index() { return index; }, set index(v) { index = v; },
    postCache, imgCache, gh, ghRaw, commit, seal, sealJSON, unsealJSON, loadIndex, loadPost, randId,
    edSettings, saveEdSettings, normRepo, changePassword, apiErrorText, TOKEN_HELP, renderArticleInto, imageIds, esc, fmtDate,
  };

  logoutBtn.addEventListener('click', () => { forgetKey(); key = null; index = null; postCache.clear(); location.hash = '#/'; showLogin(); });
  window.addEventListener('hashchange', route);
  let rt = 0;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      const { changed, fsChanged } = setHanmen();
      if (!changed) return;
      app.querySelectorAll('.jl-ready').forEach(root => { JLReq.recomposeAll(root, fsChanged); applyGyodori(root); });
    }, 150);
  });
  let ft = 0;
  document.fonts && document.fonts.addEventListener('loadingdone', () => {
    clearTimeout(ft);
    ft = setTimeout(() => app.querySelectorAll('.jl-ready').forEach(root => { JLReq.recomposeAll(root, true); applyGyodori(root); }), 100);
  });
  JLReq.installCopyHandler(document);

  (async function init() {
    try { meta = await readData('meta.json', true); } catch (e) {
      if (e.status === 404) { meta = null; return route(); }
      app.innerHTML = '<p class="error">サイトを読み込めませんでした。</p>';
      return;
    }
    const saved = loadKey();
    if (saved) {
      try { const k = await importRaw(saved); index = await loadIndex(k); key = k; } catch (e) { forgetKey(); }
    }
    route();
  })();
})();
