// Markdown → HTML 変換（TeX数式・ルビ・圏点・注）
// ビルド（Node.js）と投稿画面のプレビュー（ブラウザ）の両方で同じものを使う．
// markdown-it と KaTeX は呼び出し側から渡す．
let katex = null;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderTeX(tex, displayMode, macros) {
  return katex.renderToString(tex, {
    displayMode,
    throwOnError: false,
    strict: 'ignore',
    output: 'htmlAndMathml',
    trust: false,
    macros: { ...macros },
  });
}

// ---- 数式：$...$（行内），$$...$$（別行），```math（別行）
function mathPlugin(md, macros) {
  md.inline.ruler.after('escape', 'math_inline', (state, silent) => {
    const src = state.src;
    let pos = state.pos;
    if (src.charCodeAt(pos) !== 0x24 /* $ */) return false;
    const display = src.charCodeAt(pos + 1) === 0x24;
    const open = display ? 2 : 1;
    const start = pos + open;
    if (!display && /\s/.test(src[start] || ' ')) return false;
    let end = start;
    while (true) {
      end = src.indexOf(display ? '$$' : '$', end);
      if (end < 0) return false;
      let bs = 0;
      for (let k = end - 1; k >= start && src[k] === '\\'; k--) bs++;
      if (bs % 2 === 0) break;
      end += 1;
    }
    const content = src.slice(start, end);
    if (!content.trim()) return false;
    if (!display) {
      if (/\s/.test(src[end - 1])) return false;
      if (/[0-9]/.test(src[end + 1] || '')) return false;
    }
    if (!silent) {
      const t = state.push(display ? 'math_inline_display' : 'math_inline', 'math', 0);
      t.content = content;
    }
    state.pos = end + open;
    return true;
  });

  md.block.ruler.after('blockquote', 'math_block', (state, startLine, endLine, silent) => {
    let pos = state.bMarks[startLine] + state.tShift[startLine];
    let max = state.eMarks[startLine];
    if (state.sCount[startLine] - state.blkIndent >= 4) return false;
    if (state.src.slice(pos, pos + 2) !== '$$') return false;
    let firstLine = state.src.slice(pos + 2, max);
    let lastLine = '';
    let next = startLine;
    let found = false;
    if (firstLine.trim().endsWith('$$')) {
      firstLine = firstLine.trim().slice(0, -2);
      found = true;
    }
    if (silent) return true;
    const lines = [];
    if (firstLine.trim()) lines.push(firstLine);
    while (!found) {
      next++;
      if (next >= endLine) break;
      pos = state.bMarks[next] + state.tShift[next];
      max = state.eMarks[next];
      const line = state.src.slice(state.bMarks[next], max);
      if (line.trim().endsWith('$$')) {
        lastLine = line.trim().slice(0, -2);
        if (lastLine.trim()) lines.push(lastLine);
        found = true;
        break;
      }
      lines.push(line);
    }
    state.line = next + 1;
    const t = state.push('math_block', 'math', 0);
    t.block = true;
    t.content = lines.join('\n');
    t.map = [startLine, state.line];
    return true;
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });

  md.renderer.rules.math_inline = (tokens, idx) => renderTeX(tokens[idx].content, false, macros);
  md.renderer.rules.math_inline_display = (tokens, idx) => renderTeX(tokens[idx].content, true, macros);
  md.renderer.rules.math_block = (tokens, idx) => renderTeX(tokens[idx].content, true, macros) + '\n';
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, idx, opts, env, self) => {
    const info = (tokens[idx].info || '').trim();
    if (info === 'math') return renderTeX(tokens[idx].content, true, macros) + '\n';
    return fence(tokens, idx, opts, env, self);
  };
}

// ---- ルビ：{親文字|るび}（グループルビ），{漢字|かん|じ}（熟語ルビ：親文字1字ごと）
function rubyPlugin(md) {
  md.inline.ruler.before('emphasis', 'ruby', (state, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x7B /* { */) return false;
    const m = /^\{([^{}|\n]+)\|([^{}\n]+)\}/.exec(state.src.slice(state.pos));
    if (!m) return false;
    if (!silent) {
      const base = m[1];
      const parts = m[2].split('|');
      const chars = Array.from(base);
      let html;
      if (parts.length > 1 && parts.length === chars.length) {
        html = '<ruby class="jr" data-t="j">' + chars.map((c, i) => `<rb>${esc(c)}</rb><rt>${esc(parts[i])}</rt>`).join('') + '</ruby>';
      } else {
        html = `<ruby class="jr" data-t="g"><rb>${esc(base)}</rb><rt>${esc(parts.join(''))}</rt></ruby>`;
      }
      const t = state.push('html_inline', '', 0);
      t.content = html;
    }
    state.pos += m[0].length;
    return true;
  });
}

// ---- 圏点：《《強調》》（JIS X 4051 4.14：親文字1字に1つ，文字サイズ1/2，横組みでは上側）
function kentenPlugin(md) {
  md.inline.ruler.before('emphasis', 'kenten', (state, silent) => {
    const src = state.src;
    if (!src.startsWith('《《', state.pos)) return false;
    const end = src.indexOf('》》', state.pos + 2);
    if (end < 0 || end === state.pos + 2) return false;
    if (!silent) {
      state.push('kenten_open', 'span', 1).attrSet('class', 'kenten');
      const oldMax = state.posMax;
      state.pos += 2;
      state.posMax = end;
      state.md.inline.tokenize(state);
      state.posMax = oldMax;
      state.push('kenten_close', 'span', -1);
    }
    state.pos = end + 2;
    return true;
  });
}

// ---- 注：本文中の [^ラベル] と，行頭の [^ラベル]: 注文字列（JIS X 4051 9.3 後注）
function footnotePlugin(md) {
  md.block.ruler.before('reference', 'fn_def', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const lineText = state.src.slice(start, state.eMarks[startLine]);
    const m = /^\[\^([^\]\s]+)\]:[ \t]*(.*)$/.exec(lineText);
    if (!m) return false;
    if (silent) return true;
    const body = [m[2]];
    let next = startLine + 1;
    while (next < endLine) {
      const s = state.bMarks[next] + state.tShift[next];
      const t = state.src.slice(s, state.eMarks[next]);
      if (!t.trim() || /^\[\^[^\]\s]+\]:/.test(t)) break;
      body.push(t.trim());
      next++;
    }
    state.env.fnDefs = state.env.fnDefs || {};
    state.env.fnDefs[m[1]] = body.join('\n');
    state.line = next;
    return true;
  }, { alt: ['paragraph'] });
  md.inline.ruler.after('ruby', 'fn_ref', (state, silent) => {
    const m = /^\[\^([^\]\s]+)\]/.exec(state.src.slice(state.pos));
    if (!m) return false;
    const defs = state.env.fnDefs || {};
    if (!(m[1] in defs)) return false;
    if (!silent) {
      const env = state.env;
      env.fnOrder = env.fnOrder || [];
      let n = env.fnOrder.indexOf(m[1]) + 1;
      if (!n) { env.fnOrder.push(m[1]); n = env.fnOrder.length; }
      const t = state.push('html_inline', '', 0);
      t.content = `<sup class="fnref"><a href="#fn-${n}" id="fnref-${n}-${(env.fnRefCount = (env.fnRefCount || 0) + 1)}">${n}<span class="hp hp-c">）</span></a></sup>`;
    }
    state.pos += m[0].length;
    return true;
  });
}

export function renderFootnotes(md, env) {
  if (!env.fnOrder || !env.fnOrder.length) return '';
  const items = env.fnOrder.map((label, i) => {
    const n = i + 1;
    return `<li id="fn-${n}"><span class="fnlabel">${n}<span class="hp hp-c">）</span></span>${md.renderInline(env.fnDefs[label], env)}</li>`;
  }).join('\n');
  return `<section class="footnotes" aria-label="注"><ol>\n${items}\n</ol></section>`;
}

// ---- 画像：本文と同じく暗号化して配信する．画像だけの段落は図として扱う
function imagePlugin(md, resolveAsset) {
  const defaultImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet('src') || '';
    if (/^(https?:)?\/\//.test(src) || src.startsWith('data:')) return defaultImage(tokens, idx, opts, env, self);
    const asset = resolveAsset(src, env);
    if (!asset) return defaultImage(tokens, idx, opts, env, self);
    const alt = self.renderInlineAsText(t.children, opts, env);
    if (asset.url) return `<img src="${esc(asset.url)}" alt="${esc(alt)}">`;
    return `<img data-enc="${asset.id}" data-mime="${asset.mime}" alt="${esc(alt)}" loading="lazy">`;
  };
  const isFigure = (tokens, i) => {
    const inl = tokens[i];
    return inl && inl.type === 'inline' && inl.children && inl.children.length === 1 && inl.children[0].type === 'image';
  };
  const pOpen = md.renderer.rules.paragraph_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
  const pClose = md.renderer.rules.paragraph_close || ((t, i, o, e, s) => s.renderToken(t, i, o));
  md.renderer.rules.paragraph_open = (tokens, idx, opts, env, self) =>
    isFigure(tokens, idx + 1) ? '<figure>' : pOpen(tokens, idx, opts, env, self);
  md.renderer.rules.paragraph_close = (tokens, idx, opts, env, self) => {
    if (!isFigure(tokens, idx - 1)) return pClose(tokens, idx, opts, env, self);
    const img = tokens[idx - 1].children[0];
    const title = img.attrGet('title');
    return (title ? `<figcaption>${md.renderInline(title, env)}</figcaption>` : '') + '</figure>\n';
  };
}

function linkPlugin(md) {
  const open = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const href = tokens[idx].attrGet('href') || '';
    if (/^https?:\/\//.test(href)) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
    }
    return open(tokens, idx, opts, env, self);
  };
}

// markdown-it 標準の text 規則に「《」を区切り文字として加える（圏点の開始を検出するため）
function textRule(state, silent) {
  let pos = state.pos;
  const max = state.posMax, src = state.src;
  const stop = (c) => c === 0x0A || c === 0x21 || c === 0x23 || c === 0x24 || c === 0x25 || c === 0x26 || c === 0x2A ||
    c === 0x2B || c === 0x2D || c === 0x3A || c === 0x3C || c === 0x3D || c === 0x40 || c === 0x5B || c === 0x5C ||
    c === 0x5D || c === 0x5E || c === 0x5F || c === 0x60 || c === 0x7B || c === 0x7D || c === 0x7E || c === 0x300A;
  while (pos < max && !stop(src.charCodeAt(pos))) pos++;
  if (pos === state.pos) return false;
  if (!silent) state.pending += src.slice(state.pos, pos);
  state.pos = pos;
  return true;
}

export function createMarkdown({ MarkdownIt, katex: katexLib, resolveAsset, macros = {} }) {
  katex = katexLib;
  const md = new MarkdownIt({ html: true, linkify: false, typographer: false, breaks: false });
  md.inline.ruler.at('text', textRule);
  mathPlugin(md, macros);
  rubyPlugin(md);
  kentenPlugin(md);
  footnotePlugin(md);
  imagePlugin(md, resolveAsset);
  linkPlugin(md);
  return md;
}
