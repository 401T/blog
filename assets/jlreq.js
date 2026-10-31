/*!
 * jlreq.js — JIS X 4051:2004 / JLReq に基づく横組み行組版エンジン
 *
 * ブラウザの行分割・両端揃えには任せず，次をすべて自前で行う．
 *   - 文字クラスの判定（JLReq 付録A / JIS X 4051 表4）
 *   - 文字間の空き量（JIS X 4051 4.2, 4.6, 4.7, 表5）
 *   - 分割可能条件（行頭禁則・行末禁則・分離禁止．JIS 4.3〜4.6, 表6）
 *   - 追込み（詰め処理）を追出し（延ばし処理）より優先する行分割（JIS 6.2.9）
 *   - 行の調整処理の優先順位（JIS 4.19 a, b）
 *   - 行頭・行末での約物の配置（JIS 4.2 f, g）
 *   - ルビ（JIS 4.12：中付き，1:2:1 配置，ルビかけ，熟語ルビ）
 *   - 段落末尾処理（JIS 4.20：最終行が1字だけにならないようにする）
 * 行長は常に文字サイズの整数倍（JLReq 2.4.2 c，JIS 7.4.1）にする．
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 文字クラス
  const OPEN = 1, CLOSE = 2, HYPHEN = 3, DIVIDE = 4, MIDDOT = 5, STOP = 6, COMMA = 7,
    INSEP = 8, ITER = 9, PROLONG = 10, SMALL = 11, PREFIX = 12, POSTFIX = 13, IDSP = 14,
    HIRA = 15, KATA = 16, KANJI = 19, REF = 20, RUBY = 22, WEST = 27, ATOM = 28, LABEL = 29;

  const S = (s) => new Set(Array.from(s));
  const S_OPEN = S('（〔［｛〈《「『【｟〘〖«〝');
  const S_CLOSE = S('）〕］｝〉》」』】｠〙〗»〟');
  const S_HYPHEN = S('〜゠～');
  const S_DIVIDE = S('？！‼⁇⁈⁉');
  const S_MIDDOT = S('・：；');
  const S_STOP = S('。．');
  const S_COMMA = S('、，');
  const S_INSEP = S('―…‥〳〴〵');
  const S_ITER = S('ヽヾゝゞ々〻');
  const S_PROLONG = S('ー');
  const S_SMALL = S('ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶㇰㇱㇲㇳㇴㇵㇶㇷㇸㇹㇺㇻㇼㇽㇾㇿ');
  const S_PREFIX = S('￥＄￡＃€№');
  const S_POSTFIX = S('°′″℃￠％‰㏋ℓ');
  // 文脈で和文用か欧文用かが決まる文字（JLReq cl-01/02/03/08 と欧文用文字の両方に属しうる）
  const AMBIG_OPEN = S('‘“');
  const AMBIG_CLOSE = S('’”');
  const AMBIG_DASH = S('‐–—');

  function isJapaneseCp(cp) {
    return (cp >= 0x2E80 && cp <= 0x2FDF) || (cp >= 0x3000 && cp <= 0x30FF) ||
      (cp >= 0x3190 && cp <= 0x31FF) || (cp >= 0x3400 && cp <= 0x4DBF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) || (cp >= 0xF900 && cp <= 0xFAFF) ||
      (cp >= 0xFE30 && cp <= 0xFE4F) || (cp >= 0xFF00 && cp <= 0xFFEF) ||
      (cp >= 0x20000 && cp <= 0x3FFFF);
  }

  function baseClass(c) {
    if (S_OPEN.has(c)) return OPEN;
    if (S_CLOSE.has(c)) return CLOSE;
    if (S_COMMA.has(c)) return COMMA;
    if (S_STOP.has(c)) return STOP;
    if (S_MIDDOT.has(c)) return MIDDOT;
    if (S_DIVIDE.has(c)) return DIVIDE;
    if (S_HYPHEN.has(c)) return HYPHEN;
    if (S_INSEP.has(c)) return INSEP;
    if (S_ITER.has(c)) return ITER;
    if (S_PROLONG.has(c)) return PROLONG;
    if (S_SMALL.has(c)) return SMALL;
    if (S_PREFIX.has(c)) return PREFIX;
    if (S_POSTFIX.has(c)) return POSTFIX;
    if (c === '　') return IDSP;
    if (AMBIG_OPEN.has(c) || AMBIG_CLOSE.has(c) || AMBIG_DASH.has(c)) return -1;
    const cp = c.codePointAt(0);
    if (cp >= 0x3041 && cp <= 0x309F) return HIRA;
    if ((cp >= 0x30A0 && cp <= 0x30FF) || (cp >= 0x31F0 && cp <= 0x31FF)) return KATA;
    if (isJapaneseCp(cp)) return KANJI;
    return WEST;
  }

  const PUNCT = new Set([OPEN, CLOSE, COMMA, STOP, MIDDOT]);
  const JA_ORD = new Set([HIRA, KATA, KANJI, SMALL, ITER, PROLONG, HYPHEN, INSEP, RUBY, PREFIX, POSTFIX]);
  const JA_ANY = new Set([...JA_ORD, OPEN, CLOSE, COMMA, STOP, MIDDOT, DIVIDE, IDSP]);
  const isWest = (c) => c === WEST || c === ATOM;
  // 行頭禁則（JIS 4.3：終わり括弧類・読点・句点・中点類・区切り約物・ハイフン類・行頭禁則和字・後置省略記号）
  const NO_START = new Set([CLOSE, COMMA, STOP, MIDDOT, DIVIDE, SMALL, ITER, PROLONG, HYPHEN, POSTFIX, REF]);

  // インライン要素の扱い
  const WRAP = new Set(['A', 'STRONG', 'EM', 'B', 'I', 'U', 'S', 'DEL', 'INS', 'MARK', 'SMALL', 'CODE', 'KBD', 'SAMP', 'VAR', 'ABBR', 'CITE', 'Q', 'DFN', 'TIME', 'SUB', 'SUP', 'SPAN', 'BDI', 'BDO', 'DATA']);

  function atomClassOf(el) {
    if (el.classList.contains('fnref')) return REF;
    if (el.classList.contains('fnlabel')) return LABEL;
    if (el.tagName === 'RUBY') return RUBY;
    return ATOM;
  }
  function isAtomEl(el) {
    if (el.classList.contains('katex') || el.classList.contains('fnref') || el.classList.contains('fnlabel')) return true;
    if (el.tagName === 'RUBY' || el.tagName === 'IMG' || el.tagName === 'SVG' || el.tagName === 'svg') return true;
    if (el.tagName === 'SUB' || el.tagName === 'SUP') return true; // 添え字は親文字群として分割しない（JIS 4.13 e）
    return !WRAP.has(el.tagName);
  }

  // ---------------------------------------------------------------- 字句解析
  // 段落のDOMから「アトム」（組版の最小単位）の列を作る．
  function tokenize(block) {
    const items = [];
    (function walk(node, chain) {
      for (const n of Array.from(node.childNodes)) {
        if (n.nodeType === 3) {
          for (const c of n.data) {
            if (/\s/.test(c) && c !== '　') items.push({ t: 'sp' });
            else items.push({ t: 'c', c, chain });
          }
        } else if (n.nodeType === 1) {
          if (n.classList.contains('jl-m')) continue;
          if (n.tagName === 'BR') items.push({ t: 'br', chain });
          else if (isAtomEl(n)) items.push({ t: 'el', el: n, chain });
          else walk(n, chain.concat([n]));
        }
      }
    })(block, []);

    // 文脈依存文字の解決：隣接する文字が和字なら和文用約物として扱う
    const neighborChar = (i, dir) => {
      for (let j = i + dir; j >= 0 && j < items.length; j += dir) {
        if (items[j].t === 'c') return items[j].c;
        if (items[j].t === 'el') return items[j].el.tagName === 'RUBY' ? '漢' : 'a';
        return null;
      }
      return null;
    };
    const jaNeighbor = (ch) => ch != null && JA_ANY.has(baseClass(ch));
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.t !== 'c') continue;
      let cl = baseClass(it.c);
      if (cl === -1) {
        const p = neighborChar(i, -1), n = neighborChar(i, 1);
        if (AMBIG_OPEN.has(it.c)) cl = jaNeighbor(n) ? OPEN : WEST;
        else if (AMBIG_CLOSE.has(it.c)) cl = jaNeighbor(p) ? CLOSE : WEST;
        else if (it.c === '—') cl = (jaNeighbor(p) || jaNeighbor(n) || p === '—' || n === '—') ? INSEP : WEST;
        else cl = (jaNeighbor(p) && jaNeighbor(n)) ? HYPHEN : WEST;
      }
      it.cls = cl;
    }

    // アトム化：欧文用文字の連続は1語にまとめる（欧文の単語中では分割しない．JIS 4.7 d）
    const atoms = [];
    let space = false, word = null;
    const flush = () => { if (word) { atoms.push(word); word = null; } };
    for (const it of items) {
      if (it.t === 'sp') { flush(); if (atoms.length) space = true; continue; }
      if (it.t === 'c' && it.cls === WEST) {
        if (word && word.chain === it.chain) { word.text += it.c; continue; }
        flush();
        word = { kind: 'w', text: it.c, cls: WEST, chain: it.chain, sp: space };
        space = false;
        continue;
      }
      flush();
      if (it.t === 'c') atoms.push({ kind: 'c', text: it.c, cls: it.cls, chain: it.chain, sp: space });
      else if (it.t === 'el') atoms.push({ kind: 'el', el: it.el, cls: atomClassOf(it.el), chain: it.chain, sp: space });
      else atoms.push({ kind: 'br', cls: 0, chain: it.chain, sp: false });
      space = false;
    }
    flush();
    // 熟語ルビ（JIS 4.12.3 c）：モノルビに分けられる場合だけ親文字ごとに分割する
    const out = [];
    for (const a of atoms) {
      if (a.cls === RUBY) {
        const r = parseRuby(a.el);
        for (const part of r) out.push({ kind: 'ruby', cls: RUBY, chain: a.chain, sp: false, ruby: part, jukugo: r.length > 1 });
        if (out.length) out[out.length - r.length].sp = a.sp;
      } else out.push(a);
    }
    return out;
  }

  // <ruby class="jr" data-t="g|j"><rb>..</rb><rt>..</rt>...</ruby>
  function parseRuby(el) {
    const pairs = [];
    let base = '';
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === 3) base += n.data;
      else if (n.tagName === 'RB') base += n.textContent;
      else if (n.tagName === 'RT') { pairs.push({ base, rt: n.textContent }); base = ''; }
    }
    if (base && pairs.length) pairs[pairs.length - 1].base += base;
    const jukugo = el.getAttribute('data-t') === 'j';
    if (!jukugo || pairs.length < 2) {
      return [{ base: pairs.map(p => p.base).join(''), rt: pairs.map(p => p.rt).join(''), group: true }];
    }
    return pairs.map(p => ({ base: p.base, rt: p.rt, group: false, jparts: pairs }));
  }

  // ---------------------------------------------------------------- 空き量（表5）
  // 戻り値：[量(em), 種別] の配列．種別は行の調整処理での扱いを表す
  //   fix: 調整しない　space: 欧文間隔　mid: 中点類の前後　brk: 括弧類の前後　wao: 和欧間・和文と連数字間
  function gapParts(a, b) {
    const A = a.cls, B = b.cls;
    if (b.frag) return [];
    if (A === LABEL) return [[1, 'fix']];          // 注番号と注文字列の間は全角アキ（JIS 9.3 c 2）
    if (B === REF) return [];                        // 合印の前はベタ（JIS 9.2 b 5.2）
    if (A === IDSP || B === IDSP) return [];         // 和字間隔の前後はベタ
    if (b.sp && isWest(A) && isWest(B)) return [[1 / 3, 'space']]; // 欧文間隔は三分（JIS 4.7 c）
    if (A === OPEN) return B === MIDDOT ? [[0.25, 'mid']] : [];
    if (B === CLOSE || B === COMMA || B === STOP) return A === MIDDOT ? [[0.25, 'mid']] : []; // 4.2 d1, e1, e2
    if (A === DIVIDE) return B === DIVIDE ? [] : [[1, 'fix']];  // 区切り約物の後ろは全角アキ（JLReq 3.1.6）
    if (B === OPEN) {
      if (A === STOP) return [[0.5, 'fix']];         // 句点の後ろは二分アキ（4.2 e3）
      if (A === MIDDOT) return [[0.25, 'mid']];      // 中点類→始め括弧類は四分（4.2 c2）
      return [[0.5, 'brk']];                         // 始め括弧類の前は二分（4.2 b1, d2）
    }
    if (A === CLOSE || A === COMMA) return B === MIDDOT ? [[0.25, 'mid']] : [[0.5, 'brk']];
    if (A === STOP) return B === MIDDOT ? [[0.5, 'fix'], [0.25, 'mid']] : [[0.5, 'fix']];
    if (A === MIDDOT) return B === MIDDOT ? [[0.25, 'mid'], [0.25, 'mid']] : [[0.25, 'mid']];
    if (B === MIDDOT) return [[0.25, 'mid']];
    if (B === DIVIDE) return [];
    if ((JA_ORD.has(A) && isWest(B)) || (isWest(A) && JA_ORD.has(B))) {
      if (A === PREFIX || B === POSTFIX) return [];  // 省略記号と連数字は分離禁止・ベタ
      return [[0.25, 'wao']];                        // 和欧間・和文と連数字間は四分（4.6 d, 4.7 a）
    }
    return [];
  }

  // 分割可能条件（表6）：b の前で改行してよいか
  function canBreak(a, b) {
    const A = a.cls, B = b.cls;
    if (NO_START.has(B)) return false;               // 行頭禁則（4.3）
    if (A === OPEN || A === PREFIX || A === LABEL) return false; // 行末禁則（4.4）・分離禁止（4.5）
    if (A === INSEP && B === INSEP && a.text === b.text) return false; // 分離禁止文字（4.5）
    if (isWest(A) && isWest(B) && !b.sp) return false;
    if (a.kind === 'ruby' && b.kind === 'ruby' && a.ruby.jparts && a.ruby.jparts === b.ruby.jparts) return true; // 熟語ルビの親文字群間は分割可
    return true;
  }

  // 行末にきたときに残る後ろ側の空き量（4.2 b2：句点の後ろは二分アキ．終わり括弧類・読点はベタ＝4.2 f1）
  function trailing(a) { return a.cls === STOP ? 0.5 : 0; }

  // ---------------------------------------------------------------- 計測
  let haltOK = null;
  const widthCache = new Map();

  function chainSig(chain) {
    return chain.map(e => e.tagName + '.' + e.className + '.' + (e.getAttribute('style') || '')).join('>');
  }
  function wrapChain(chain, inner) {
    let node = inner;
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i].cloneNode(false);
      c.removeAttribute('id');
      c.appendChild(node);
      node = c;
    }
    return node;
  }
  function punctSpan(text, cls) {
    const s = document.createElement('span');
    s.className = cls === OPEN ? 'hp hp-o' : cls === MIDDOT ? 'hp hp-m' : 'hp hp-c';
    s.textContent = text;
    return s;
  }
  function plainSpan(text, className) {
    const s = document.createElement('span');
    if (className) s.className = className;
    s.textContent = text;
    return s;
  }

  // 各アトムの字幅を実際の描画で計測する（同じ書式・同じ文字は1回だけ計測）
  function measureAtoms(block, atoms, fs) {
    const box = document.createElement('div');
    box.className = 'jl-m';
    box.setAttribute('aria-hidden', 'true');
    block.appendChild(box);
    const bcs = getComputedStyle(block);
    const keyPrefix = [bcs.fontFamily, bcs.fontSize, bcs.fontWeight, bcs.fontStyle, bcs.fontFeatureSettings].join('/') + '|';
    const pending = new Map();   // key -> {probe, setters[]}
    const want = (key, chain, makeInner, set) => {
      if (key && widthCache.has(key)) { set(widthCache.get(key)); return; }
      if (key && pending.has(key)) { pending.get(key).setters.push(set); return; }
      const inner = makeInner();
      const holder = document.createElement('span');
      holder.className = 'jl-mh';
      holder.appendChild(wrapChain(chain, inner));
      box.appendChild(holder);
      pending.set(key || Symbol(), { probe: inner, setters: [set], key });
    };
    for (const a of atoms) {
      const sig = keyPrefix + chainSig(a.chain);
      if (a.kind === 'c') {
        want(sig + '|c|' + a.cls + '|' + a.text, a.chain,
          () => PUNCT.has(a.cls) ? punctSpan(a.text, a.cls) : plainSpan(a.text, a.cls === DIVIDE ? 'dv' : ''),
          w => { a.w = w; });
      } else if (a.kind === 'w') {
        want(sig + '|w|' + a.text, a.chain, () => plainSpan(a.text, 'w'), w => { a.w = w; });
      } else if (a.kind === 'el') {
        want(null, a.chain, () => a.el.cloneNode(true), w => { a.w = w; });
      } else if (a.kind === 'ruby') {
        const rs = [a.ruby].concat(a.ruby.jparts || []);
        for (const r of rs) {
          want(sig + '|rb|' + r.base, a.chain, () => plainSpan(r.base, 'rbm'), w => { r.L = w; });
          want(sig + '|rt|' + r.rt, a.chain, () => plainSpan(r.rt, 'rtm'), w => { r.l = w; });
        }
      } else a.w = 0;
    }
    const results = [];
    for (const job of pending.values()) results.push([job, job.probe.getBoundingClientRect().width]);
    for (const [job, w] of results) {
      if (job.key) widthCache.set(job.key, w);
      for (const s of job.setters) s(w);
    }
    box.remove();
    // halt（半角幅の約物）が使えないフォントでは，全角幅から半分を差し引いて扱う
    if (!haltOK) for (const a of atoms) {
      if (a.kind === 'c' && PUNCT.has(a.cls)) a.w -= 0.5 * fs;
    }
  }

  function detectHalt(container) {
    if (haltOK !== null) return haltOK;
    const t = document.createElement('span');
    t.className = 'jl-m';
    t.innerHTML = '<span class="hp hp-o">「</span><span class="jl-ref">漢</span>';
    container.appendChild(t);
    const a = t.firstChild.getBoundingClientRect().width;
    const b = t.lastChild.getBoundingClientRect().width;
    t.remove();
    haltOK = b > 0 && a / b < 0.75;
    document.documentElement.classList.toggle('jl-nohalt', !haltOK);
    return haltOK;
  }

  // ---------------------------------------------------------------- ルビの配置（JIS 4.12）
  function layoutRuby(a, fs, prev, next) {
    const r = a.ruby;
    const rs = fs / 2;                          // ルビ文字サイズは親文字の1/2（4.12.1）
    const nBase = Array.from(r.base).length, nRt = Array.from(r.rt).length;
    r.basePad = 0; r.baseLS = 0; r.rtPad = 0; r.rtLS = 0; r.ovhPrev = 0; r.ovhNext = 0;
    if (r.l <= r.L) {
      a.w = r.L;
      if (r.group && nRt >= 2) {                // グループルビ：x:y:z = 1:2:1（4.12.3 b 1.2）
        const u = (r.L - r.l) / (2 * nRt);
        r.rtPad = u; r.rtLS = 2 * u;
      } else r.rtPad = (r.L - r.l) / 2;         // モノルビ・1字：中心をそろえる（4.12.3 a 2）
    } else {
      a.w = r.l;
      const u = (r.l - r.L) / (2 * nBase);      // 親文字間を X:Y:Z = 1:2:1（4.12.3 b 2.2）
      r.basePad = u; r.baseLS = 2 * u;
      const cap = Math.min(u, rs);
      // ルビかけ（4.12.3 a 3）：前は空き・平仮名・分離禁止文字・和字間隔，後ろはそれに終わり括弧類・句点類
      const prevOK = prev && (prev.cls === HIRA || prev.cls === INSEP || prev.cls === IDSP);
      const nextOK = next && (next.cls === HIRA || next.cls === INSEP || next.cls === IDSP ||
        next.cls === CLOSE || next.cls === COMMA || next.cls === STOP);
      r.ovhPrev = prevOK ? cap : 0;
      r.ovhNext = nextOK ? cap : 0;
      r.akiCap = cap;
    }
  }

  // 熟語ルビ：どれか1つでもはみ出すならグループルビとしてまとめる（4.12.3 c 2.1）
  function resolveJukugo(atoms) {
    const out = [];
    for (let i = 0; i < atoms.length; i++) {
      const a = atoms[i];
      if (a.kind === 'ruby' && a.ruby.jparts) {
        const parts = a.ruby.jparts;
        const over = parts.some(p => p.l > p.L + 0.01);
        if (over) {
          out.push({ kind: 'ruby', cls: RUBY, chain: a.chain, sp: a.sp, ruby: { base: parts.map(p => p.base).join(''), rt: parts.map(p => p.rt).join(''), group: true, L: parts.reduce((s, p) => s + p.L, 0), l: parts.reduce((s, p) => s + p.l, 0) } });
          i += parts.length - 1;
          continue;
        }
      }
      out.push(a);
    }
    return out;
  }

  // ---------------------------------------------------------------- 行分割と行の調整
  const SHRINK_ORDER = ['space', 'mid', 'brk', 'wao'];   // 4.19 a 1)〜4)
  function shrinkCap(kind, v) {
    if (kind === 'space') return v - 0.25;               // 欧文間隔は四分まで
    if (kind === 'mid' || kind === 'brk') return v;      // ベタまで
    if (kind === 'wao') return v - 0.125;                // 八分まで
    return 0;
  }

  function buildGaps(atoms, fs) {
    const g = new Array(atoms.length);
    for (let i = 1; i < atoms.length; i++) {
      const a = atoms[i - 1], b = atoms[i];
      if (a.kind === 'br' || b.kind === 'br') { g[i] = { nat: 0, parts: [], brk: false, ovh: 0 }; continue; }
      const parts = gapParts(a, b);
      let nat = parts.reduce((s, p) => s + p[0], 0) * fs;
      // ルビかけ：二分アキ等の空きにも，その量までかけてよい（表5「二分かけ」）
      let ovh = 0;
      if (b.kind === 'ruby' && b.ruby.akiCap) ovh += b.ruby.ovhPrev || Math.min(b.ruby.akiCap, nat);
      if (a.kind === 'ruby' && a.ruby.akiCap) ovh += a.ruby.ovhNext || Math.min(a.ruby.akiCap, Math.max(0, nat - ovh));
      g[i] = { nat, parts: parts.map(p => ({ v: p[0] * fs, k: p[1] })), brk: canBreak(a, b), ovh };
    }
    return g;
  }

  // 行 [s, e) の自然長と最大の詰め量
  function lineMetrics(atoms, g, s, e) {
    let nat = 0, shrink = 0;
    for (let i = s; i < e; i++) {
      nat += atoms[i].w;
      if (i > s) {
        nat += g[i].nat - g[i].ovh;
        for (const p of g[i].parts) shrink += shrinkCap(p.k, p.v / 1) * 1;
      }
    }
    return { nat, shrink };
  }

  function breakLines(atoms, g, fs, widthOf) {
    const lines = [];
    let s = 0, lineNo = 0;
    while (s < atoms.length) {
      while (s < atoms.length && atoms[s].kind === 'br') { lines.push({ s, e: s, last: true, empty: true }); s++; lineNo++; }
      if (s >= atoms.length) break;
      const L = widthOf(lineNo);
      let nat = 0, shrinkPx = 0, k1 = -1, chosen = -1, forced = false;
      for (let e = s + 1; e <= atoms.length; e++) {
        const a = atoms[e - 1];
        if (a.kind === 'br') { chosen = e - 1; forced = true; break; }
        nat += a.w;
        if (e - 1 > s) {
          nat += g[e - 1].nat - g[e - 1].ovh;
          for (const p of g[e - 1].parts) shrinkPx += shrinkCap(p.k, p.v / fs) * fs;
        }
        const atEnd = e === atoms.length || atoms[e].kind === 'br';
        const breakable = atEnd || g[e].brk;
        if (!breakable) continue;
        const width = nat + trailing(a) * fs;
        if (width <= L + 0.5) { k1 = e; if (atEnd) { chosen = e; if (atoms[e] && atoms[e].kind === 'br') forced = true; break; } continue; }
        // 行長を超えた最初の分割可能点：詰め処理で収まるなら追い込む（4.3 a, 4.4 a, 6.2.9）
        if (width - shrinkPx <= L + 0.5) chosen = e;
        else chosen = k1;
        break;
      }
      if (chosen === -1 || chosen <= s) {
        // 分割可能点がない（長い欧文単語・数式など）：行内に収まる最大位置で分割する（4.7 e）
        let w = 0, e = s;
        while (e < atoms.length && atoms[e].kind !== 'br' && (e === s || w + atoms[e].w + (g[e] ? g[e].nat : 0) <= L)) { w += atoms[e].w + (e > s ? g[e].nat : 0); e++; }
        chosen = Math.max(e, s + 1);
      }
      const last = chosen >= atoms.length || forced;
      lines.push({ s, e: chosen, last });
      s = chosen;
      if (forced && atoms[s] && atoms[s].kind === 'br') s++;
      lineNo++;
    }
    return lines;
  }

  // 1行に収まらない欧文単語（URLなど）は，行長に収まる長さの断片に分ける
  // （ハイフネーション可能な箇所の判定は処理系定義．JIS 4.7 e）
  function splitLongWords(atoms, L, fs) {
    const out = [];
    for (const a of atoms) {
      if (a.kind !== 'w' || a.w <= L) { out.push(a); continue; }
      const chars = Array.from(a.text);
      const per = a.w / chars.length;
      const n = Math.max(1, Math.floor(L / per));
      for (let j = 0; j < chars.length; j += n) {
        const t = chars.slice(j, j + n).join('');
        out.push({ kind: 'w', text: t, cls: WEST, chain: a.chain, sp: j === 0 ? a.sp : true, w: per * Array.from(t).length, frag: j > 0 });
      }
    }
    return out;
  }

  // 段落末尾処理（4.20）：最終行が1字だけの場合，前の行から1字送る
  function fixWidow(atoms, g, lines, fs, widthOf) {
    if (lines.length < 2) return;
    const lastL = lines[lines.length - 1], prev = lines[lines.length - 2];
    if (!lastL.last || lastL.empty || prev.last) return;
    const cnt = lastL.e - lastL.s;
    if (cnt !== 1 || atoms[lastL.s].kind !== 'c') return;
    for (let e = prev.e - 1; e > prev.s + 1; e--) {
      if (!g[e].brk) continue;
      const m = lineMetrics(atoms, g, e, lastL.e);
      if (m.nat + trailing(atoms[lastL.e - 1]) * fs <= widthOf(lines.length - 1) + 0.5) {
        prev.e = e; lastL.s = e;
      }
      return;
    }
  }

  // 行の調整処理（4.19）：各字間の最終的な量（px）を返す
  function justify(atoms, g, line, L, fs) {
    const { s, e } = line;
    const gaps = [];
    let nat = 0;
    for (let i = s; i < e; i++) {
      nat += atoms[i].w;
      if (i > s) {
        const parts = g[i].parts.map(p => ({ v: p.v, k: p.k }));
        gaps.push({ i, parts, brk: g[i].brk, extra: 0, ovh: g[i].ovh });
        nat += g[i].nat - g[i].ovh;
      }
    }
    nat += trailing(atoms[e - 1]) * fs;
    let delta = L - nat;
    if (delta < -0.01) {
      let need = -delta;
      for (const kind of SHRINK_ORDER) {
        const caps = [];
        for (const gp of gaps) for (const p of gp.parts) if (p.k === kind) caps.push(p);
        const total = caps.reduce((sum, p) => sum + shrinkCap(p.k, p.v / fs) * fs, 0);
        if (total <= 0) continue;
        const take = Math.min(need, total);
        for (const p of caps) p.v -= shrinkCap(p.k, p.v / fs) * fs * (take / total);
        need -= take;
        if (need <= 0.01) break;
      }
    } else if (delta > 0.01 && !line.last) {
      let need = delta;
      const stage = (filter, capPx) => {
        const list = [];
        for (const gp of gaps) for (const p of gp.parts) if (filter(p, gp)) list.push(p);
        if (!list.length || need <= 0.01) return;
        const each = Math.min(capPx, need / list.length);
        for (const p of list) p.v += each;
        need -= each * list.length;
      };
      stage(p => p.k === 'space', fs / 6);                 // 1) 欧文間隔を二分まで
      stage(p => p.k === 'wao', fs / 4);                   // 2) 和欧間・和文と連数字間を二分まで
      const ext = gaps.filter(gp => gp.brk);
      if (ext.length && need > 0.01) {                     // 3) 延ばし可能な字間を四分まで
        const each = Math.min(fs / 4, need / ext.length);
        for (const gp of ext) gp.extra += each;
        need -= each * ext.length;
      }
      if (ext.length && need > 0.01) {                     // 4) 分割可能な字間を均等に
        const each = need / ext.length;
        for (const gp of ext) gp.extra += each;
        need = 0;
      }
    }
    const result = new Map();
    for (const gp of gaps) result.set(gp.i, gp.parts.reduce((s2, p) => s2 + p.v, 0) + gp.extra - gp.ovh);
    return { gaps: result, nat };
  }

  // ---------------------------------------------------------------- 描画
  function renderAtom(a, parent) {
    if (a.kind === 'c') {
      if (PUNCT.has(a.cls)) { parent.appendChild(punctSpan(a.text, a.cls)); return; }
      if (a.cls === DIVIDE) { parent.appendChild(plainSpan(a.text, 'dv')); return; }
      const last = parent.lastChild;
      if (last && last.nodeType === 3) last.data += a.text;
      else parent.appendChild(document.createTextNode(a.text));
    } else if (a.kind === 'w') {
      const sp = plainSpan(a.text, 'w');
      parent.appendChild(sp);
    } else if (a.kind === 'el') {
      parent.appendChild(a.el.cloneNode(true));
    } else if (a.kind === 'ruby') {
      parent.appendChild(renderRuby(a));
    }
  }

  function renderRuby(a) {
    const r = a.ruby;
    const box = document.createElement('span');
    box.className = 'rb';
    box.style.width = a.w + 'px';
    const base = document.createElement('span');
    base.className = 'rbb';
    Array.from(r.base).forEach((c, j) => {
      const s = plainSpan(c);
      const m = j === 0 ? r.basePad : r.baseLS;
      if (m) s.style.marginLeft = m + 'px';
      base.appendChild(s);
    });
    const rt = document.createElement('span');
    rt.className = 'rbt';
    rt.setAttribute('aria-hidden', 'true');
    Array.from(r.rt).forEach((c, j) => {
      const s = plainSpan(c);
      const m = j === 0 ? r.rtPad : r.rtLS;
      if (m) s.style.marginLeft = m + 'px';
      rt.appendChild(s);
    });
    box.appendChild(base);
    box.appendChild(rt);
    // 読み上げ・コピー用に元の表記を残す
    const sr = document.createElement('span');
    sr.className = 'jl-sr';
    sr.textContent = '（' + r.rt + '）';
    box.appendChild(sr);
    return box;
  }

  function renderLine(atoms, line, gaps, indentPx, align) {
    const el = document.createElement('span');
    el.className = 'ln';
    if (align === 'center') el.classList.add('ln-c');
    const first = atoms[line.s];
    if (line.s > 0 && first.sp && isWest(first.cls) && isWest(atoms[line.s - 1].cls)) el.classList.add('ln-sp');
    if (indentPx) {
      const sp = document.createElement('span');
      sp.className = 'g';
      sp.style.marginLeft = indentPx + 'px';
      el.appendChild(sp);
    }
    const stack = []; // [{orig, node}]
    for (let i = line.s; i < line.e; i++) {
      const a = atoms[i];
      const chain = a.chain;
      let k = 0;
      while (k < stack.length && k < chain.length && stack[k].orig === chain[k]) k++;
      stack.length = k;
      if (i > line.s) {
        const v = gaps.get(i) || 0;
        const wordSpace = a.sp && isWest(atoms[i - 1].cls) && isWest(a.cls);
        if (Math.abs(v) > 0.01 || wordSpace) {
          const sp = document.createElement('span');
          sp.className = wordSpace ? 'g gs' : 'g';
          sp.style.marginLeft = v + 'px';
          (k ? stack[k - 1].node : el).appendChild(sp);
        }
      }
      for (let j = k; j < chain.length; j++) {
        const c = chain[j].cloneNode(false);
        c.removeAttribute('id');
        (j ? stack[j - 1].node : el).appendChild(c);
        stack.push({ orig: chain[j], node: c });
      }
      renderAtom(a, chain.length ? stack[chain.length - 1].node : el);
    }
    return el;
  }

  function cloneAtoms(tpl) {
    const pmap = new Map();
    return tpl.map(a => {
      const c = Object.assign({}, a, { w: null });
      if (a.ruby) {
        let jp = null;
        if (a.ruby.jparts) {
          if (!pmap.has(a.ruby.jparts)) pmap.set(a.ruby.jparts, a.ruby.jparts.map(p => ({ base: p.base, rt: p.rt })));
          jp = pmap.get(a.ruby.jparts);
        }
        c.ruby = { base: a.ruby.base, rt: a.ruby.rt, group: a.ruby.group, jparts: jp };
      }
      return c;
    });
  }

  // ---------------------------------------------------------------- 段落単位の処理
  function cssNum(cs, name, dflt) {
    const v = parseFloat(cs.getPropertyValue(name));
    return isNaN(v) ? dflt : v;
  }

  function compose(block) {
    const cs = getComputedStyle(block);
    const fs = parseFloat(cs.fontSize);
    let st = block.__jl;
    if (!st) st = block.__jl = { tpl: tokenize(block) };
    const contentW = block.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    // 行長は文字サイズの整数倍（JLReq 2.4.2 c）
    const L = Math.floor(contentW / fs + 0.001) * fs;
    if (!(L > 0)) return;
    const indentFirst = cssNum(cs, '--jl-indent-first', 1) * fs;
    const indentRest = cssNum(cs, '--jl-indent-rest', 0) * fs;
    const align = cs.getPropertyValue('--jl-align').trim() || 'start';

    if (!st.measured || st.fs !== fs) {
      st.atoms = cloneAtoms(st.tpl);
      measureAtoms(block, st.atoms, fs);
      st.atoms = resolveJukugo(st.atoms);
      st.measured = true; st.fs = fs;
    }
    const widthOf = (n) => L - (n === 0 ? indentFirst : indentRest);
    let atoms = st.atoms.filter((a, i, arr) => !(a.kind === 'br' && i === arr.length - 1));
    atoms = splitLongWords(atoms, Math.min(widthOf(0), widthOf(1)), fs);
    if (!atoms.length) { block.replaceChildren(); return; }
    for (let i = 0; i < atoms.length; i++) if (atoms[i].kind === 'ruby') layoutRuby(atoms[i], fs, atoms[i - 1], atoms[i + 1]);
    const g = buildGaps(atoms, fs);
    const lines = breakLines(atoms, g, fs, widthOf);
    fixWidow(atoms, g, lines, fs, widthOf);
    const frag = document.createDocumentFragment();
    lines.forEach((ln, n) => {
      const width = widthOf(n);
      if (ln.empty) { const e = document.createElement('span'); e.className = 'ln'; e.innerHTML = '&#8203;'; frag.appendChild(e); return; }
      const { gaps } = justify(atoms, g, ln, width, fs);
      const el = renderLine(atoms, ln, gaps, n === 0 ? indentFirst : indentRest, align);
      frag.appendChild(el);
    });
    block.replaceChildren(frag);
    block.classList.add('jl-done');
    block.style.setProperty('--jl-L', L + 'px');
  }

  function prepare(root) {
    // ブロック要素とインライン要素が混在する箇所（箇条書きの中の入れ子など）は，インライン部分をまとめる
    const BLOCKS = new Set(['P', 'DIV', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'PRE', 'TABLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGURE', 'HR', 'DL', 'DT', 'DD', 'SECTION', 'FIGCAPTION']);
    const isBlockEl = (n) => n.nodeType === 1 && (BLOCKS.has(n.tagName) || n.classList.contains('katex-display'));
    root.querySelectorAll('li, dd, blockquote, td, th, figure, section.footnotes li').forEach(el => {
      const kids = Array.from(el.childNodes);
      if (!kids.some(isBlockEl)) return;
      let run = [];
      const flush = () => {
        if (run.some(n => n.nodeType === 1 || n.data.trim())) {
          const d = document.createElement('div');
          d.className = 'jl-run';
          run[0].before(d);
          run.forEach(n => d.appendChild(n));
        }
        run = [];
      };
      for (const n of kids) { if (isBlockEl(n)) flush(); else run.push(n); }
      flush();
    });
  }

  function targets(root) {
    const sel = 'p, h1, h2, h3, h4, h5, h6, li, dt, dd, figcaption, .jl-run, .jl-block';
    return Array.from(root.querySelectorAll(sel)).filter(el => {
      if (el.closest('pre, table, .katex, .no-jl')) return false;
      if (el.querySelector('p, h1, h2, h3, h4, h5, h6, li, ul, ol, div, blockquote, pre, table, figure, dl, .katex-display')) return false;
      return true;
    });
  }

  function composeAll(root) {
    detectHalt(root);
    prepare(root);
    for (const el of targets(root)) {
      try { compose(el); } catch (err) { console.error('jlreq', err, el); el.classList.add('jl-fail'); }
    }
    root.classList.add('jl-ready');
  }

  function recomposeAll(root, remeasure) {
    if (remeasure) { widthCache.clear(); haltOK = null; }
    detectHalt(root);
    for (const el of targets(root)) {
      if (!el.__jl) continue;
      if (remeasure) el.__jl.measured = false;
      try { compose(el); } catch (err) { console.error('jlreq', err, el); }
    }
  }

  // コピー時：行ごとの改行を入れず，ルビは親文字のみ，数式はTeXソースにする
  function copyText(frag) {
    let out = '';
    (function walk(n) {
      if (n.nodeType === 3) { out += n.data; return; }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1) {
        if (n.classList.contains('rbt') || n.classList.contains('jl-m') || n.classList.contains('katex-html')) return;
        if (n.classList.contains('katex-mathml')) {
          const ann = n.querySelector('annotation');
          if (ann) out += (n.closest && n.closest('.katex-display') ? '$$' + ann.textContent + '$$' : '$' + ann.textContent + '$');
          return;
        }
        if (n.classList.contains('jl-sr')) return;
        if (n.classList.contains('gs')) { out += ' '; return; }
        if (n.classList.contains('ln-sp')) out += ' ';
      }
      for (const c of n.childNodes) walk(c);
      if (n.nodeType === 1 && /^(P|H[1-6]|LI|DT|DD|PRE|BLOCKQUOTE|DIV|FIGCAPTION|TR)$/.test(n.tagName) && !n.classList.contains('ln')) out += '\n';
    })(frag);
    return out.replace(/\n{3,}/g, '\n\n').trim();
  }
  function installCopyHandler(doc) {
    doc.addEventListener('copy', (e) => {
      const sel = doc.getSelection();
      if (!sel || !sel.rangeCount) return;
      const range = sel.getRangeAt(0);
      const anc = range.commonAncestorContainer;
      const host = (anc.nodeType === 1 ? anc : anc.parentElement);
      if (!host || !host.closest('.jl-ready')) return;
      e.clipboardData.setData('text/plain', copyText(range.cloneContents()));
      e.preventDefault();
    });
  }

  global.JLReq = { composeAll, recomposeAll, installCopyHandler, _test: { baseClass, gapParts, canBreak, tokenize } };
})(window);
