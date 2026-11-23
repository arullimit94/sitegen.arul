// sitegen: a faster drop-in for makefun-site 1.0.0 (the reference program of
// site-generator-speed-01). run(input) returns, for one site's input, exactly
// the output tree makefun-site 1.0.0's build returns for it, byte for byte.
// It is a from-scratch reimplementation of the same rules (README.md of
// vendor/makefun-site), written for speed: a fused Markdown lexer/renderer
// with a single-pass inline scanner, an array-accumulating template renderer,
// memoized slugs and allocation-free word counting. No dependencies, no I/O,
// no clock, no randomness: the output is a function of the input alone.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' (README.md). */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left. Results are memoized: titles and tag names repeat.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  if (slugCache.size < 65536) slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** The code units JavaScript counts as whitespace (\s: White_Space and LineTerminator), as a table. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279]) WS_TABLE[c] = 1;

/** The words of a body: its runs of characters other than whitespace, counted by one scan, no regex and no array. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let k = 0; k < text.length; k++) {
    if (WS_TABLE[text.charCodeAt(k)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A line's `key: value` (LINE: /^([a-z_]+):(?: (.*))?$/), or null when it is not one. */
function fmLine(line) {
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 97 && c <= 122) || c === 95) k++;
    else break;
  }
  if (k === 0 || line[k] !== ':') return null;
  if (k + 1 === line.length) return { key: line.slice(0, k), raw: '' };
  if (line[k + 1] !== ' ') return null;
  return { key: line.slice(0, k), raw: line.slice(k + 2) };
}

/** `s` with its trailing spaces and tabs dropped. */
function rtrimSpaces(s) {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
  return e === s.length ? s : s.slice(0, e);
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends.
 */
function parseFrontMatter(text) {
  const lines = text.split('\n');
  if (lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      close = i;
      break;
    }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (line === '' || line[0] === '#') continue;
    if (line[0] === ' ' || line[0] === '\t') {
      let blank = true;
      for (let k = 0; k < line.length; k++) {
        if (line[k] !== ' ' && line[k] !== '\t') { blank = false; break; }
      }
      if (blank) continue;
    }
    const m = fmLine(line);
    if (m === null) return { error: `line ${i + 1} is not "key: value"` };
    const key = m.key;
    const raw = rtrimSpaces(m.raw);
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: lines.slice(close + 1).join('\n') };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (an array of pieces, joined by the caller) in
 * `scope` ({ vars, parent }). `templates` holds the parsed templates, `depth`
 * the include depth. Accumulating into an array instead of `out +=` per node
 * is the same text, faster.
 */
function renderNodes(nodes, scope, templates, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, templates, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          renderNodes(n.body, { vars: { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } }, parent: scope }, templates, depth, out);
        }
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, templates, depth + 1, out);
        break;
      }
    }
  }
}

/** The template `name` rendered with `vars`, or null when it is missing. */
function renderTemplate(templates, name, vars) {
  const nodes = templates.get(name);
  if (nodes === undefined) return null;
  const out = [];
  renderNodes(nodes, { vars, parent: null }, templates, 0, out);
  return out.join('');
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_TEST = /\s/;
const CONTINUED = /^ {2,}\S/;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. A single pass
 * that jumps from one markup character to the next with indexOf (native
 * speed) and escapes the plain runs between them in bulk, instead of the
 * reference's per-character escapeHtml call.
 */
function inline(s, env) {
  const n = s.length;
  const out = [];
  let i = 0; // scan position: the next character not yet decided
  let plain = 0; // start of the pending plain run (literal characters so far, escaped in bulk)
  while (i < n) {
    let j = n;
    let k = s.indexOf('\\', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('`', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('*', i);
    if (k !== -1 && k < j) j = k;
    k = s.indexOf('[', i);
    if (k !== -1 && k < j) j = k;
    if (j === n) break; // no more markup: the plain run to the end is flushed below
    const c = s[j];
    if (c === '\\') {
      const d = s[j + 1];
      if (j + 1 < n && ESCAPABLE.has(d)) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push(d); // no escapable character is one of & < > " ', so escapeHtml(d) is d itself
        i = j + 2;
        plain = i;
        continue;
      }
      i = j + 1; // a backslash before anything else is itself, left in the plain run
      continue;
    }
    if (c === '`') {
      const m = s.indexOf('`', j + 1);
      if (m > j + 1) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push('<code>', escapeHtml(s.slice(j + 1, m)), '</code>');
        i = m + 1;
        plain = i;
        continue;
      }
      i = j + 1; // a backtick with no closer is itself
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const m = findUnescaped(s, '**', j + 2);
        if (m > j + 2) {
          if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
          out.push('<strong>', inline(s.slice(j + 2, m), env), '</strong>');
          i = m + 2;
          plain = i;
          continue;
        }
        i = j + 2; // ** with no closer is itself
        continue;
      }
      const m = findSingleStar(s, j + 1);
      if (m > j + 1) {
        if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
        out.push('<em>', inline(s.slice(j + 1, m), env), '</em>');
        i = m + 1;
        plain = i;
        continue;
      }
      i = j + 1; // a single * with no closer is itself
      continue;
    }
    // c === '['
    const close = findUnescaped(s, ']', j + 1);
    const paren = close !== -1 && s[close + 1] === '(' ? s.indexOf(')', close + 2) : -1;
    const target = paren === -1 ? '' : s.slice(close + 2, paren);
    if (target !== '' && !WS_TEST.test(target)) {
      if (j > plain) out.push(escapeHtml(s.slice(plain, j)));
      out.push('<a href="', escapeHtml(env.link(target)), '">', inline(s.slice(j + 1, close), env), '</a>');
      i = paren + 1;
      plain = i;
      continue;
    }
    i = j + 1; // a [ that opens no link is itself
  }
  if (plain < n) out.push(escapeHtml(s.slice(plain, n)));
  return out.join('');
}

/** Whether `line` is blank: empty, or spaces and tabs only. */
function isBlankLine(line) {
  if (line === '') return true;
  const c = line[0];
  if (c !== ' ' && c !== '\t') return false;
  for (let k = 1; k < line.length; k++) {
    if (line[k] !== ' ' && line[k] !== '\t') return false;
  }
  return true;
}

/** A line with its spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/**
 * A fence's language when `line` (opening on ```) opens one
 * (/^```([A-Za-z0-9_+-]*)[ \t]*$/), else null.
 */
function fenceLang(line) {
  let j = 3;
  const n = line.length;
  while (j < n) {
    const c = line.charCodeAt(j);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45)) break;
    j++;
  }
  const lang = line.slice(3, j);
  while (j < n && (line[j] === ' ' || line[j] === '\t')) j++;
  return j === n ? lang : null;
}

/** Whether `line` closes a fence (/^```[ \t]*$/). */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let d = 0;
  while (d < line.length && line[d] === '#') d++;
  if (d === 0 || d > 6) return null;
  if (d >= line.length || (line[d] !== ' ' && line[d] !== '\t')) return null;
  let a = d;
  while (a < line.length && (line[a] === ' ' || line[a] === '\t')) a++;
  let b = line.length;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  if (b === a) return null;
  return { depth: d, text: line.slice(a, b) };
}

/** Whether `line` is a thematic break (`---` or `***`, then spaces or tabs only). */
function isHr(line) {
  const c = line[0];
  if (c !== '-' && c !== '*') return false;
  const mark = c === '-' ? '---' : '***';
  if (!line.startsWith(mark)) return false;
  for (let j = 3; j < line.length; j++) {
    if (line[j] !== ' ' && line[j] !== '\t') return false;
  }
  return true;
}

/** A bullet list item's content, or null when `line` is not one. */
function bulletContent(line) {
  const c = line[0];
  if ((c === '-' || c === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered list item's content, or null when `line` is not one. */
function orderedContent(line) {
  const c = line[0];
  if (c < '0' || c > '9') return null;
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d > 9) return null;
  if (line[d] === '.' && line[d + 1] === ' ') return line.slice(d + 2);
  return null;
}

/** A list's first line, or null when `line` does not open one. */
function listStart(line) {
  const b = bulletContent(line);
  if (b !== null) return { ordered: false, start: 1, content: b };
  const c = line[0];
  if (c < '0' || c > '9') return null;
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d > 9) return null;
  if (line[d] === '.' && line[d + 1] === ' ') return { ordered: true, start: Number(line.slice(0, d)), content: line.slice(d + 2) };
  return null;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * Blocks are rendered straight to text in one pass over the lines, with no
 * token objects in between.
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const n = lines.length;
  const out = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    const ch = line[0];
    if (ch === undefined) {
      i++; // empty line
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
      // A space-leading line that is not blank cannot open any other block: a paragraph.
    } else if (ch === '`') {
      if (line.startsWith('```')) {
        const lang = fenceLang(line);
        if (lang !== null) {
          i++;
          const body = [];
          while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
          if (i < n) i++;
          let code = '<pre><code';
          if (lang !== '') code += ` class="language-${escapeHtml(lang)}"`;
          code += '>';
          for (const l of body) {
            code += escapeHtml(l);
            code += '\n';
          }
          code += '</code></pre>';
          out.push(code);
          continue;
        }
      }
      // A backtick line that opens no fence is a paragraph line.
    } else if (ch === '#') {
      const hd = headingOf(line);
      if (hd !== null) {
        const id = uniqueSlug(slugify(hd.text), ids);
        const html = inline(hd.text, env);
        out.push(`<h${hd.depth} id="${id}">${html}</h${hd.depth}>`);
        if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html });
        i++;
        continue;
      }
      // A # line that is no heading is a paragraph line.
    } else if (ch === '-' || ch === '*') {
      if (isHr(line)) {
        out.push('<hr>');
        i++;
        continue;
      }
      const ls = listStart(line);
      if (ls !== null) {
        const isOrdered = ls.ordered;
        const items = [[trimLine(ls.content)]];
        i++;
        while (i < n) {
          const m = isOrdered ? orderedContent(lines[i]) : bulletContent(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
          } else if (CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        const tag = isOrdered ? 'ol' : 'ul';
        const open = isOrdered && ls.start !== 1 ? `<ol start="${ls.start}">` : `<${tag}>`;
        let s = `${open}\n`;
        for (const parts of items) s += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        s += `</${tag}>`;
        out.push(s);
        continue;
      }
      // A - or * line that is neither a break nor a list is a paragraph line.
    } else if (ch === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      out.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    } else if (ch >= '0' && ch <= '9') {
      const ls = listStart(line);
      if (ls !== null) {
        const items = [[trimLine(ls.content)]];
        i++;
        while (i < n) {
          const m = orderedContent(lines[i]);
          if (m !== null) {
            items.push([trimLine(m)]);
            i++;
          } else if (CONTINUED.test(lines[i])) {
            items[items.length - 1].push(trimLine(lines[i]));
            i++;
          } else break;
        }
        let s = ls.start !== 1 ? `<ol start="${ls.start}">\n` : '<ol>\n';
        for (const parts of items) s += `<li>${inline(parts.join('\n'), env)}</li>\n`;
        s += '</ol>';
        out.push(s);
        continue;
      }
      // A digit line that opens no list is a paragraph line.
    }
    const body = [trimLine(line)];
    i++;
    while (i < n) {
      const l2 = lines[i];
      const c2 = l2[0];
      if (c2 === undefined) break; // blank
      if (c2 === ' ' || c2 === '\t') {
        if (isBlankLine(l2)) break;
      } else if (c2 === '`') {
        if (l2.startsWith('```') && fenceLang(l2) !== null) break;
      } else if (c2 === '#') {
        if (headingOf(l2) !== null) break;
      } else if ((c2 === '-' || c2 === '*') && isHr(l2)) break;
      body.push(trimLine(l2));
      i++;
    }
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>`);
  }
  return { html: out.length === 0 ? '' : `${out.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(s, card) {
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. */
export function build(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's output directory and url, its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => renderTemplate(templates, name, { site, tags: allTags, recent, ...vars });
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, s.post ? cards.get(s) : cardOf(s)) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
