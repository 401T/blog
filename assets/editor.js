// 投稿画面：スマホのブラウザで記事を書き，暗号化してから GitHub に直接コミットする
const DRAFT_PREFIX = 'blog-draft:';
let C = null;                         // app.js から渡される共通機能
const pending = new Map();            // 画像ID -> { bytes, url }（未保存の画像）
let dirty = false;

window.addEventListener('beforeunload', (e) => { if (dirty || pending.size) { e.preventDefault(); e.returnValue = ''; } });

const h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
const todayJST = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);

// ---------------------------------------------------------------- 画像（縮小・メタデータ除去）
async function prepareImage(file) {
  if (file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return { bytes: new Uint8Array(await file.arrayBuffer()), ext: file.type === 'image/gif' ? 'gif' : 'svg' };
  }
  const MAX = 1600;
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const s = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * s), hh = Math.round(bmp.height * s);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = hh;
  const g = cv.getContext('2d');
  const png = file.type === 'image/png';
  if (!png) { g.fillStyle = '#fff'; g.fillRect(0, 0, w, hh); }
  g.drawImage(bmp, 0, 0, w, hh);
  const blob = await new Promise(r => cv.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.85));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), ext: png ? 'png' : 'jpg' };
}

// ---------------------------------------------------------------- 確認つきボタン（ブラウザのダイアログは使わない）
function twoStep(btn, confirmLabel, action) {
  const label = btn.textContent;
  let armed = false, timer = 0;
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    if (!armed) {
      armed = true;
      btn.textContent = confirmLabel;
      btn.classList.add('armed');
      timer = setTimeout(() => { armed = false; btn.textContent = label; btn.classList.remove('armed'); }, 4000);
      return;
    }
    clearTimeout(timer);
    armed = false; btn.textContent = label; btn.classList.remove('armed');
    btn.disabled = true;
    try { await action(); } finally { btn.disabled = false; }
  });
}

// ---------------------------------------------------------------- 設定（持ち主だけが開ける）
async function renderSettings(app, message) {
  const S = C.edSettings();
  const hasOwner = await C.hasEditorFile().catch(() => false);
  const pwInput = (name, label) => `<label class="ed-field"><span>${label}</span><input name="${name}" type="password" autocomplete="new-password" autocapitalize="off" autocorrect="off" spellcheck="false"></label>`;
  const el = h(`<section class="ed ed-settings">
    <h2 class="ed-h">編集用パスワード</h2>
    <p class="ed-note">${hasOwner ? '設定済みです。' : 'まだ設定されていません。'}ログイン画面でこのパスワードを入れると，どのブラウザ・端末からでも記事を書いたり消したりできます。閲覧用とは別の，あなただけのパスワードにしてください（12文字以上を推奨）。</p>
    ${pwInput('op1', hasOwner ? '新しい編集用パスワード' : '編集用パスワード')}
    ${pwInput('op2', 'もう一度')}
    <div class="ed-actions"><button class="ed-primary" type="button" data-act="setowner">${hasOwner ? '変更する' : '設定する'}</button></div>
    <p class="ed-status ed-ownerstatus" role="status"></p>

    <h2 class="ed-h ed-h2">閲覧用パスワードの変更</h2>
    <p class="ed-note">記事と画像をすべて新しいパスワードで暗号化し直します。読者には新しいパスワードを伝え直してください。</p>
    ${pwInput('np1', '新しい閲覧用パスワード')}
    ${pwInput('np2', 'もう一度')}
    <div class="ed-actions"><button class="ed-primary" type="button" data-act="chpw">変更する</button></div>
    <p class="ed-status ed-pwstatus" role="status"></p>

    <h2 class="ed-h ed-h2">GitHub のトークン</h2>
    <p class="ed-note">トークンの期限が切れたときだけ貼り替えてください。${hasOwner ? '編集用パスワードで入るすべての端末に反映されます。' : ''}</p>
    <label class="ed-field"><span>リポジトリ</span><input name="repo" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="401T/blog"></label>
    <label class="ed-field"><span>アクセストークン</span><input name="token" type="password" autocomplete="off" placeholder="github_pat_…"></label>
    ${C.TOKEN_HELP}
    <div class="ed-actions"><button class="ed-primary" type="button" data-act="save">保存</button></div>
    <p class="ed-status ed-tokenstatus" role="status">${message || ''}</p>

    <div class="ed-ownerpw" hidden>
      <h2 class="ed-h ed-h2">確認</h2>
      <p class="ed-note">この端末では編集用パスワードの確認が必要です。入力してから，もう一度ボタンを押してください。</p>
      ${pwInput('ownerpw', '今の編集用パスワード')}
    </div>
  </section>`);
  const $ = (q) => el.querySelector(q);
  $('[name=repo]').value = S.repo;
  $('[name=token]').value = S.token;
  const ownerPw = () => $('[name=ownerpw]').value || null;
  const needOwner = (st) => { $('.ed-ownerpw').hidden = false; st.textContent = '下の欄に今の編集用パスワードを入れて，もう一度押してください。'; $('[name=ownerpw]').focus(); };

  twoStep($('[data-act=setowner]'), 'もう一度押すと設定', async () => {
    const st = $('.ed-ownerstatus');
    const a = $('[name=op1]').value, b = $('[name=op2]').value;
    if (a.length < 8) { st.textContent = '8文字以上にしてください。'; return; }
    if (a !== b) { st.textContent = '2つのパスワードが一致しません。'; return; }
    st.textContent = '設定しています…';
    try {
      await C.setOwnerPassword(a);
      $('[name=op1]').value = ''; $('[name=op2]').value = '';
      st.textContent = '設定しました。ほかの端末ではログイン画面でこのパスワードを入れてください（反映まで1〜2分）。';
    } catch (e) { st.textContent = e.same ? '閲覧用パスワードと同じものは使えません。' : C.apiErrorText(e); }
  });

  twoStep($('[data-act=chpw]'), 'もう一度押すと変更', async () => {
    const st = $('.ed-pwstatus');
    const a = $('[name=np1]').value, b = $('[name=np2]').value;
    if (a.length < 8) { st.textContent = '8文字以上にしてください。'; return; }
    if (a !== b) { st.textContent = '2つのパスワードが一致しません。'; return; }
    try {
      await C.changePassword(a, (t) => { st.textContent = t; }, ownerPw());
      $('[name=np1]').value = ''; $('[name=np2]').value = '';
      st.textContent = '変更しました。ほかの端末への反映には1〜2分かかります。';
    } catch (e) { console.error(e); if (e.needOwner) needOwner(st); else st.textContent = C.apiErrorText(e); }
  });

  $('[data-act=save]').addEventListener('click', async () => {
    const st = $('.ed-tokenstatus');
    const s = { ...S, repo: C.normRepo($('[name=repo]').value), token: $('[name=token]').value.trim() };
    C.saveEdSettings(s, !!sessionStorage.getItem('blog-editor'));
    st.textContent = '確認しています…';
    try {
      await C.gh('GET', `/git/ref/heads/${encodeURIComponent(s.branch)}`);
      const shared = await C.updateOwnerToken(ownerPw());
      st.textContent = shared ? '保存しました。すべての端末に反映されます。' : '保存しました。';
    } catch (e) { if (e.needOwner) needOwner(st); else st.textContent = C.apiErrorText(e); }
  });
  app.replaceChildren(el);
}

// ---------------------------------------------------------------- 記事一覧（投稿画面）
function renderIndex(app) {
  const el = h(`<section class="ed">
    <div class="ed-top"><h2 class="ed-h">記事を書く</h2><a class="ed-small" href="#/write/settings">設定</a></div>
    <p><a class="ed-primary ed-new" href="#/write/new">＋ 新しい記事</a></p>
    <ul class="ed-list"></ul>
  </section>`);
  const list = el.querySelector('.ed-list');
  const drafts = Object.keys(localStorage).filter(k => k.startsWith(DRAFT_PREFIX + 'new-'));
  for (const k of drafts) {
    let d = {};
    try { d = JSON.parse(localStorage.getItem(k)); } catch (e) { /* */ }
    list.appendChild(h(`<li><a href="#/write/${encodeURIComponent(k.slice(DRAFT_PREFIX.length))}"><span class="ed-tag">保存前</span>${C.esc(d.title || '（無題）')}</a></li>`));
  }
  const posts = C.index.posts.slice().sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.ts || 0) - (a.ts || 0));
  for (const p of posts) {
    list.appendChild(h(`<li><a href="#/write/${encodeURIComponent(p.id)}">${p.draft ? '<span class="ed-tag">下書き</span>' : ''}<span class="ed-date">${C.esc(p.date || '')}</span>${C.esc(p.title || '（無題）')}</a></li>`));
  }
  if (!posts.length && !drafts.length) list.appendChild(h('<li class="ed-note">まだ記事がありません。</li>'));
  app.replaceChildren(el);
}

// ---------------------------------------------------------------- 編集画面
async function renderEditor(app, path) {
  const isNew = path === 'new' || path.startsWith('new-');
  const draftId = path === 'new' ? 'new-' + C.randId(6) : path;
  const draftKey = DRAFT_PREFIX + draftId;
  let post = { title: '', date: todayJST(), tags: [], draft: false, md: '' };
  const existing = isNew ? null : C.index.posts.find(p => p.id === path);
  if (!isNew && !existing) { app.replaceChildren(h('<p class="error">記事が見つかりません。</p>')); return; }
  if (existing) {
    app.replaceChildren(h('<p class="ed-note">読み込んでいます…</p>'));
    post = { ...post, ...(await C.loadPost(existing.id)) };
  }
  let restored = false;
  try {
    const saved = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (saved) { post = { ...post, ...saved }; restored = true; }
  } catch (e) { /* */ }
  if (path === 'new') history.replaceState(null, '', '#/write/' + draftId);

  const el = h(`<section class="ed ed-editor">
    <div class="ed-top">
      <a class="ed-small" href="#/write">← 一覧</a>
      <div class="ed-tabs" role="tablist"><button type="button" role="tab" aria-selected="true" data-tab="edit">編集</button><button type="button" role="tab" aria-selected="false" data-tab="preview">プレビュー</button></div>
    </div>
    ${restored ? '<p class="ed-note ed-restored">保存していない書きかけを復元しました。<button type="button" data-act="discard">破棄</button></p>' : ''}
    <div class="ed-pane" data-pane="edit">
      <label class="ed-field"><span>タイトル</span><input name="title" enterkeyhint="next"></label>
      <div class="ed-row">
        <label class="ed-field"><span>日付</span><input name="date" type="date"></label>
        <label class="ed-field"><span>タグ（読点区切り）</span><input name="tags"></label>
      </div>
      <div class="ed-tools" role="toolbar" aria-label="書式">
        <button type="button" data-ins="ruby">ルビ</button><button type="button" data-ins="kenten">圏点</button>
        <button type="button" data-ins="math">数式</button><button type="button" data-ins="dmath">別行数式</button>
        <button type="button" data-ins="note">注</button><button type="button" data-ins="image">画像</button>
        <button type="button" data-ins="bold">太字</button><button type="button" data-ins="h2">見出し</button>
        <button type="button" data-ins="h3">小見出し</button><button type="button" data-ins="list">箇条</button>
        <button type="button" data-ins="quote">引用</button><button type="button" data-ins="link">リンク</button>
      </div>
      <textarea name="body" class="ed-text" spellcheck="false" autocapitalize="off" placeholder="本文（Markdown）"></textarea>
      <details class="ed-help"><summary>書き方</summary><ul>
        <li>段落の先頭の字下げ，和文と英数字の間のアキは自動です。</li>
        <li>数式 <code>$x^2$</code>，別行数式 <code>$$ … $$</code></li>
        <li>ルビ <code>{紫陽花|あじさい}</code>，熟語ルビ <code>{東京|とう|きょう}</code>，圏点 <code>《《強調》》</code></li>
        <li>注 <code>本文[^1]</code> と <code>[^1]: 注の文</code>，見出し <code>## 見出し</code></li>
      </ul></details>
      <input type="file" accept="image/*" multiple hidden>
    </div>
    <div class="ed-pane ed-preview" data-pane="preview" hidden></div>
    <div class="ed-foot">
      <label class="ed-check"><input type="checkbox" name="draft"><span>下書き（自分以外には表示しない）</span></label>
      <div class="ed-actions"><button class="ed-primary" type="button" data-act="save">保存して公開</button>${existing ? '<button class="ed-danger" type="button" data-act="delete">削除</button>' : ''}</div>
      <p class="ed-status" role="status"></p>
    </div>
  </section>`);
  const $ = (s) => el.querySelector(s);
  const ta = $('[name=body]');
  $('[name=title]').value = post.title;
  $('[name=date]').value = post.date;
  $('[name=tags]').value = (post.tags || []).join('、');
  $('[name=draft]').checked = !!post.draft;
  ta.value = post.md;
  const status = $('.ed-status');

  const collect = () => ({
    title: $('[name=title]').value.trim(),
    date: $('[name=date]').value || todayJST(),
    tags: $('[name=tags]').value.split(/[、,，]/).map(s => s.trim()).filter(Boolean),
    draft: $('[name=draft]').checked,
    md: ta.value.replace(/\s+$/, '') + '\n',
  });
  let timer = 0;
  el.addEventListener('input', () => {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { try { localStorage.setItem(draftKey, JSON.stringify(collect())); } catch (e) { /* */ } }, 400);
  });
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.max(ta.scrollHeight + 2, innerHeight * 0.5) + 'px'; };
  ta.addEventListener('input', grow);

  // 書式ボタン
  const changed = () => { ta.focus(); ta.dispatchEvent(new Event('input', { bubbles: true })); };
  const wrap = (a, b, ph) => {
    const s = ta.selectionStart, e = ta.selectionEnd, had = e > s;
    const sel = ta.value.slice(s, e) || ph;
    ta.setRangeText(a + sel + b, s, e, 'end');
    if (!had) ta.setSelectionRange(s + a.length, s + a.length + sel.length);
    changed();
  };
  const lineStart = (pre) => { const s = ta.selectionStart; const ls = ta.value.lastIndexOf('\n', s - 1) + 1; ta.setRangeText(pre, ls, ls, 'end'); changed(); };
  const block = (text, from, len) => {
    const s = ta.selectionStart;
    const pre = s === 0 ? '' : ta.value[s - 1] !== '\n' ? '\n\n' : (s > 1 && ta.value[s - 2] !== '\n' ? '\n' : '');
    ta.setRangeText(pre + text, s, ta.selectionEnd, 'end');
    if (from != null) ta.setSelectionRange(s + pre.length + from, s + pre.length + from + len);
    changed();
  };
  const fileInput = $('input[type=file]');
  $('.ed-tools').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    const k = b.dataset.ins, s = ta.selectionStart, e = ta.selectionEnd, sel = ta.value.slice(s, e);
    if (k === 'ruby') { const t = `{${sel || '親文字'}|よみ}`; ta.setRangeText(t, s, e, 'end'); ta.setSelectionRange(s + t.length - 3, s + t.length - 1); changed(); }
    else if (k === 'kenten') wrap('《《', '》》', '強調');
    else if (k === 'math') wrap('$', '$', 'x');
    else if (k === 'dmath') block(`$$\n${sel || 'x'}\n$$\n\n`, 3, (sel || 'x').length);
    else if (k === 'bold') wrap('**', '**', '太字');
    else if (k === 'h2') lineStart('## ');
    else if (k === 'h3') lineStart('### ');
    else if (k === 'list') lineStart('- ');
    else if (k === 'quote') lineStart('> ');
    else if (k === 'link') { const t = `[${sel || 'リンク'}](https://)`; ta.setRangeText(t, s, e, 'end'); ta.setSelectionRange(s + t.length - 9, s + t.length - 1); changed(); }
    else if (k === 'note') {
      const used = Array.from(ta.value.matchAll(/\[\^(\d+)\]/g)).map(m => +m[1]);
      const n = used.length ? Math.max(...used) + 1 : 1;
      ta.setRangeText(`[^${n}]`, e, e, 'end');
      ta.value = ta.value.replace(/\s+$/, '') + `\n\n[^${n}]: \n`;
      ta.setSelectionRange(ta.value.length - 1, ta.value.length - 1);
      changed();
    } else if (k === 'image') fileInput.click();
  });
  fileInput.addEventListener('change', async () => {
    const files = Array.from(fileInput.files);
    fileInput.value = '';
    for (const f of files) {
      status.textContent = '画像を準備しています…';
      try {
        const { bytes, ext } = await prepareImage(f);
        const id = C.randId(9) + '.' + ext;
        pending.set(id, { bytes, url: URL.createObjectURL(new Blob([bytes])) });
        block(`![](img:${id})\n\n`);
        status.textContent = `画像を追加しました（${Math.round(bytes.length / 1024)}KB）。`;
      } catch (e) { status.textContent = '画像を読み込めませんでした。'; }
    }
  });

  // プレビュー（公開時と同じ変換・組版）
  el.querySelector('.ed-tabs').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    el.querySelectorAll('.ed-tabs button').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    el.querySelectorAll('.ed-pane').forEach(p => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    if (b.dataset.tab === 'preview') {
      const pv = $('.ed-preview');
      pv.innerHTML = '<p class="ed-note">組版しています…</p>';
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('20秒たっても終わりませんでした')), 20000));
      try { await Promise.race([C.renderArticleInto(pv, collect(), pending), timeout]); }
      catch (e) {
        console.error(e);
        pv.innerHTML = '<p class="error">プレビューを作れませんでした。もう一度「プレビュー」を押してください。続く場合は下の文字を送ってください。</p><pre class="ed-preview-err"></pre>';
        pv.querySelector('.ed-preview-err').textContent = String((e && (e.stack || e.message)) || e).slice(0, 600) + '\n' + navigator.userAgent;
      }
    }
  });

  const discard = el.querySelector('[data-act=discard]');
  if (discard) discard.addEventListener('click', () => { localStorage.removeItem(draftKey); dirty = false; renderEditor(app, isNew ? 'new' : path); });

  // 保存：最新の一覧を GitHub から読み直し，記事・画像・一覧を暗号化して1コミットで保存
  $('[data-act=save]').addEventListener('click', async (ev) => {
    const p = collect();
    if (!p.title) { status.textContent = 'タイトルを入れてください。'; $('[name=title]').focus(); return; }
    if (!p.md.trim()) { status.textContent = '本文が空です。'; ta.focus(); return; }
    const btn = ev.currentTarget;
    btn.disabled = true;
    status.textContent = '暗号化して保存しています…';
    let step = '';
    try {
      step = '一覧の読み込み';
      const idx = await C.latestIndex();
      step = '暗号化';
      const id = existing ? existing.id : C.randId(12);
      const entry = { id, title: p.title, date: p.date, tags: p.tags, draft: p.draft, ts: Date.now() };
      const i = idx.posts.findIndex(x => x.id === id);
      if (i >= 0) idx.posts[i] = entry; else idx.posts.push(entry);
      const used = new Set(C.imageIds(p.md));
      const changes = [
        { path: `data/p-${id}.bin`, data: await C.sealJSON(p, C.key) },
        { path: 'data/index.bin', data: await C.sealJSON(idx, C.key) },
      ];
      for (const [imgId, img] of pending) if (used.has(imgId)) changes.push({ path: `data/i-${imgId}.bin`, data: await C.seal(img.bytes, C.key) });
      if (existing) {
        const old = C.postCache.get(id);
        if (old) for (const oldId of C.imageIds(old.md)) if (!used.has(oldId)) changes.push({ path: `data/i-${oldId}.bin`, delete: true });
      }
      step = 'GitHub への保存';
      await C.commit(`${existing ? '記事を更新' : '記事を追加'}`, changes);
      step = '';
      for (const [imgId, img] of pending) if (used.has(imgId)) C.imgCache.set(imgId, img.url);
      pending.clear();
      C.postCache.set(id, p);
      C.index = idx;
      localStorage.removeItem(draftKey);
      dirty = false;
      status.innerHTML = `保存しました。${p.draft ? '下書きなので一覧には自分にだけ表示されます。' : '他の端末への反映には1〜2分かかります。'} <a href="#/p/${encodeURIComponent(id)}">記事を見る</a>`;
      if (!existing) history.replaceState(null, '', '#/write/' + encodeURIComponent(id));
      btn.disabled = false;
    } catch (e) {
      console.error(e);
      status.textContent = (step ? `［${step}］` : '') + C.apiErrorText(e) + ' 書きかけはこの端末に残っています。';
      btn.disabled = false;
    }
  });
  const del = el.querySelector('[data-act=delete]');
  if (del) twoStep(del, 'もう一度押すと削除', async () => {
    status.textContent = '削除しています…';
    try {
      const idx = await C.latestIndex();
      idx.posts = idx.posts.filter(x => x.id !== existing.id);
      const old = await C.loadPost(existing.id);
      const changes = [{ path: `data/p-${existing.id}.bin`, delete: true }, { path: 'data/index.bin', data: await C.sealJSON(idx, C.key) }];
      for (const imgId of C.imageIds(old.md)) changes.push({ path: `data/i-${imgId}.bin`, delete: true });
      await C.commit('記事を削除', changes);
      C.index = idx;
      C.postCache.delete(existing.id);
      localStorage.removeItem(draftKey);
      dirty = false;
      location.hash = '#/write';
    } catch (e) { status.textContent = C.apiErrorText(e); }
  });

  app.replaceChildren(el);
  requestAnimationFrame(grow);
}

export async function render(app, ctx, path) {
  C = ctx;
  if (path === 'settings') return renderSettings(app);
  if (!path) return renderIndex(app);
  return renderEditor(app, path);
}
