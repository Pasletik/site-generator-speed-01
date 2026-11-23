// A fast drop-in for makefun-site 1.0.0: run(input) returns the same output tree (path -> text, byte for byte) as
// the reference build, computed with single-pass scanners, run-based escaping and small caches instead of per-
// character regex work. The semantics are makefun-site's own (its README states them; its code is the reference):
// front matter, its Markdown subset, its template dialect, permalinks, collections, tags and the build report.

const hasOwn = Object.hasOwn;

/** JavaScript's \s set as char codes, for word counting and link-target checks. */
function isSpaceCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** `s` with & < > " and ' escaped; the string itself when it holds none of them. */
function escapeHtml(s) {
  let out = null;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = '';
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return out === null ? s : out + s.slice(start);
}

const SLUG_MAX = 64;
const slugCache = new Map();

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most 64 characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII text needs no normalisation (NFKD is the identity there and ASCII holds no combining marks); any other
 * text goes through NFKD and the mark strip first. Either way a code-unit scan gives the reference's answer: every
 * non-ASCII unit is a gap character, and consecutive gaps collapse to one "-".
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
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
const longDateCache = new Map();

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const hit = longDateCache.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const out = `${d} ${MONTHS[m - 1]} ${y}`;
  longDateCache.set(date, out);
  return out;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const sp = c === 32 || (c >= 9 && c <= 13) || (c > 127 && isSpaceCode(c));
    if (sp) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

const isDigit = (c) => c >= 48 && c <= 57;

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
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
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; ok && i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      if (ok) {
        let prevDash = true; // a leading dash (or an empty segment) refuses
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) {
            if (prevDash) { ok = false; break; }
            prevDash = true;
          } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
          else { ok = false; break; }
        }
        if (prevDash) ok = false; // a trailing dash refuses
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. Lines are scanned by offset; the body is the text after the closing line, never rebuilt.
 */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  // The closing line is found before any line is judged: an unclosed block refuses as such, whatever its lines hold.
  const starts = [firstNl + 1]; // start offset of line 2, then of each line after it
  let closeStart = -1;
  let closeNl = -1;
  for (let pos = firstNl + 1; ; ) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    if (lineEnd - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeStart = pos;
      closeNl = nl;
      break;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    pos = nl + 1;
    starts.push(pos);
  }
  const data = {};
  for (let li = 0; li < starts.length - 1; li++) {
    const lineNo = li + 2; // the opening --- is line 1
    const line = text.slice(starts[li], starts[li + 1] - 1);
    // blank (spaces and tabs only) or a comment
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (blank || line.charCodeAt(0) === 35) continue;
    // "key: value" — a key of a-z and _, a colon, then end of line or one space and the value
    let ki = 0;
    while (ki < line.length) {
      const c = line.charCodeAt(ki);
      if ((c >= 97 && c <= 122) || c === 95) ki++;
      else break;
    }
    if (ki === 0 || line.charCodeAt(ki) !== 58 || (ki + 1 < line.length && line.charCodeAt(ki + 1) !== 32)) {
      return { error: `line ${lineNo} is not "key: value"` };
    }
    const key = line.slice(0, ki);
    let raw = ki + 1 < line.length ? line.slice(ki + 2) : '';
    let rawEnd = raw.length;
    while (rawEnd > 0) {
      const c = raw.charCodeAt(rawEnd - 1);
      if (c === 32 || c === 9) rawEnd--;
      else break;
    }
    if (rawEnd !== raw.length) raw = raw.slice(0, rawEnd);
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeNl === -1 ? '' : text.slice(closeNl + 1) };
}

// ---------------------------------------------------------------- markdown

const isBlankLine = (line) => {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
};

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether the rest of `line` from `from` is spaces and tabs only. */
function onlySpacesTabs(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language ("" for none), or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  return onlySpacesTabs(line, i) ? line.slice(3, i) : null;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
const fenceClose = (line) =>
  line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && onlySpacesTabs(line, 3);

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let i = n;
  const c0 = line.charCodeAt(i);
  if (c0 !== 32 && c0 !== 9) return null;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) break;
    i++;
  }
  let b = line.length;
  while (b > i) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return b > i ? { depth: n, text: line.slice(i, b) } : null;
}

/** Whether `line` is a thematic break: --- or ***, then spaces or tabs only. */
function isHr(line) {
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false;
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  return onlySpacesTabs(line, 3);
}

/** A bullet item line's text, or null. */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  return (c === 45 || c === 42) && line.charCodeAt(1) === 32 ? line.slice(2) : null;
}

/** An ordered item line's start number and text, or null. */
function orderedOf(line) {
  let i = 0;
  while (i < line.length && isDigit(line.charCodeAt(i))) i++;
  if (i === 0 || i > 9 || line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null;
  return { start: Number(line.slice(0, i)), text: line.slice(i + 2) };
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinuation(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i >= 2 && i < line.length && !isSpaceCode(line.charCodeAt(i));
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 96) return fenceOpen(line) !== null;
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return isHr(line);
  if (c === 32 || c === 9 || line.length === 0) return isBlankLine(line);
  return false;
}

/** The characters a backslash escapes, by char code. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of '\\`*_[]()#+-.!>') ESCAPABLE[ch.charCodeAt(0)] = 1;
const isEscapable = (code) => code < 128 && ESCAPABLE[code] === 1;

/** The first index from `from` where `s` holds "**" outside a backslash escape, or -1. */
function findUnescapedStars(s, from) {
  for (let j = from; j <= s.length - 2; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first index from `from` where `s` holds `code` outside a backslash escape, or -1. */
function findUnescapedChar(s, code, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c === code) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 92 && j + 1 < s.length && isEscapable(s.charCodeAt(j + 1))) { j++; continue; }
    if (c !== 42) continue;
    if (s.charCodeAt(j + 1) === 42) { j++; continue; }
    return j;
  }
  return -1;
}

/** Whether `s` holds any whitespace (JavaScript's \s). */
function hasSpace(s) {
  for (let i = 0; i < s.length; i++) if (isSpaceCode(s.charCodeAt(i))) return true;
  return false;
}

/** Character kinds for the inline scanner: 1 = inline markup, 2 = needs HTML escaping, 0 = plain. */
const KIND = new Uint8Array(128);
for (const ch of '\\`*[') KIND[ch.charCodeAt(0)] = 1;
for (const ch of '&<>"\'') KIND[ch.charCodeAt(0)] = 2;

/** `s` rendered inline; `env.link(target)` is a link's href. Plain runs are escaped in bulk, never per character. */
function inline(s, env) {
  const parts = [];
  let i = 0;
  let runStart = 0;
  let runEscapes = false; // the current plain run holds a character escapeHtml would change
  const flush = (to) => {
    if (to > runStart) {
      const run = s.slice(runStart, to);
      parts.push(runEscapes ? escapeHtml(run) : run);
    }
    runEscapes = false;
  };
  while (i < s.length) {
    // Advance over plain text in one tight scan.
    while (i < s.length) {
      const c = s.charCodeAt(i);
      const k = c < 128 ? KIND[c] : 0;
      if (k === 1) break;
      if (k === 2) runEscapes = true;
      i++;
    }
    if (i >= s.length) break;
    const c = s.charCodeAt(i);
    if (c === 92) {
      if (i + 1 < s.length && isEscapable(s.charCodeAt(i + 1))) {
        flush(i);
        parts.push(escapeHtml(s[i + 1]));
        i += 2;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        parts.push('<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>');
        i = j + 1;
        runStart = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescapedStars(s, i + 2);
        if (j > i + 2) {
          flush(i);
          parts.push('<strong>' + inline(s.slice(i + 2, j), env) + '</strong>');
          i = j + 2;
          runStart = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          flush(i);
          parts.push('<em>' + inline(s.slice(i + 1, j), env) + '</em>');
          i = j + 1;
          runStart = i;
        } else i++;
      }
      continue;
    }
    // c === 91, '['
    const k = findUnescapedChar(s, 93, i + 1);
    const m = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !hasSpace(target)) {
      flush(i);
      parts.push('<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>');
      i = m + 1;
      runStart = i;
    } else i++;
  }
  flush(s.length);
  return parts.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !fenceClose(lines[i])) body.push(escapeHtml(lines[i++]) + '\n');
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      blocks.push(`<pre><code${cls}>${body.join('')}</code></pre>\n`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) { blocks.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const kept = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const stripped = lines[i].charCodeAt(1) === 32 ? lines[i].slice(2) : lines[i].slice(1);
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? ordered.start : 1;
      const items = [];
      while (i < lines.length) {
        const t = isOrdered ? orderedOf(lines[i]) : bulletOf(lines[i]);
        if (t !== null) {
          items.push([trimLine(isOrdered ? t.text : t)]);
          i++;
        } else if (isContinuation(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      const lis = items.map((parts) => `<li>${inline(parts.join('\n'), env)}</li>\n`).join('');
      blocks.push(`${open}\n${lis}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** Whether `text` is a path: names joined by dots, each from a letter or _, then letters, digits and _. */
function isPath(text) {
  if (text.length === 0) return false;
  let segStart = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 46) {
      if (segStart) return false;
      segStart = true;
      continue;
    }
    const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
    if (segStart) {
      if (!letter) return false;
      segStart = false;
    } else if (!letter && !isDigit(c)) return false;
  }
  return !segStart;
}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!isPath(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether src[a..b) is spaces and tabs only. */
function spacesTabsOnly(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
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
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
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
    const standalone = spacesTabsOnly(src, lineStart, open) && spacesTabsOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** A name (a letter or _, then letters, digits and _) at `from` in `tag`, or -1. Returns [name, endIndex]. */
function nameAt(tag, from) {
  let i = from;
  if (i >= tag.length) return null;
  const c0 = tag.charCodeAt(i);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122) || c0 === 95)) return null;
  i++;
  while (i < tag.length) {
    const c = tag.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigit(c) || c === 95) i++;
    else break;
  }
  return [tag.slice(from, i), i];
}

/** A {% for %} tag's variable and path text, or null. */
function forOf(tag) {
  if (!tag.startsWith('for ')) return null;
  const nm = nameAt(tag, 4);
  if (nm === null) return null;
  const [varName, end] = nm;
  if (!tag.startsWith(' in ', end)) return null;
  const pathText = tag.slice(end + 4);
  return pathText !== '' && !hasSpace(pathText) ? { varName, pathText } : null;
}

/** A {% if %} tag's negation and path text, or null. */
function ifOf(tag) {
  if (!tag.startsWith('if ')) return null;
  let rest = tag.slice(3);
  let not = false;
  if (rest.startsWith('not ')) {
    not = true;
    rest = rest.slice(4);
  }
  return rest !== '' && !hasSpace(rest) ? { not, pathText: rest } : null;
}

/** A {% include %} tag's template name, or null. */
function includeOf(tag) {
  if (!tag.startsWith('include "') || !tag.endsWith('"') || tag.length < 11) return null;
  const name = tag.slice(9, -1);
  if (name === '') return null;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return null;
  }
  return name;
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
      if ((m = forOf(tag)) !== null) {
        const node = { kind: 'for', name: m.varName, path: pathOf(name, m.pathText), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = ifOf(tag)) !== null) {
        const node = { kind: 'if', not: m.not, path: pathOf(name, m.pathText), then: [], else: null };
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
      } else if ((m = includeOf(tag)) !== null) body.push({ kind: 'include', name: m });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  const first = path[0];
  while (s !== null && !hasOwn(s.vars, first)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[first];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
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

/** `nodes` rendered into `out` in `scope` ({ vars, parent }); `ctx` holds the parsed templates. */
function renderInto(nodes, scope, ctx, depth, out) {
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
        if (branch !== null) renderInto(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope reused across iterations: rendering is synchronous and depth-first, so nothing keeps it.
        const vars = {};
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const childScope = { vars, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          vars[n.name] = xs[k];
          vars.loop = loop; // after the name, as the reference's object literal has it: "loop" wins a clash
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderInto(n.body, childScope, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInto(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

/** `nodes` rendered in `scope` as one string. */
function renderNodes(nodes, scope, ctx, depth) {
  const out = [];
  renderInto(nodes, scope, ctx, depth, out);
  return out.join('');
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

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

const dirOf = (path) => {
  const at = path.lastIndexOf('/');
  return at === -1 ? '' : path.slice(0, at);
};

/** Whether `target` carries a scheme: a letter, then letters, digits, +, . or -, then a colon. */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 46 || c === 45)) return false;
  }
  return false;
}

/** One site's output tree: path -> text. */
export function run(input) {
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
  let base = input.site.base_url;
  while (base.endsWith('/')) base = base.slice(0, -1);

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
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
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
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

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let dirTaken = taken.get(dir);
    if (dirTaken === undefined) {
      dirTaken = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, dirTaken);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), dirTaken);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const linkCaches = new Map(); // directory -> (target -> { href, broken })
  for (const s of kept) {
    const dir = dirOf(s.path);
    let dirCache = linkCaches.get(dir);
    if (dirCache === undefined) {
      dirCache = new Map();
      linkCaches.set(dir, dirCache);
    }
    const env = {
      link: (target) => {
        const hit = dirCache.get(target);
        if (hit !== undefined) {
          if (hit.broken) broken.add(`broken-link ${s.path} -> ${target}`);
          return hit.href;
        }
        let href;
        let isBroken = false;
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) {
          href = target;
        } else {
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null && bySource.has(path)) href = `${bySource.get(path).url}${frag}`;
          else if (path !== null && staticPaths.has(path)) href = `${base}/${path}${frag}`;
          else {
            isBroken = true;
            href = target;
          }
        }
        dirCache.set(target, { href, broken: isBroken });
        if (isBroken) broken.add(`broken-link ${s.path} -> ${target}`);
        return href;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push({ name, slug });
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, link records and pages as templates read them (each source's card computed once).
  const cardCache = new Map();
  const cardOf = (s) => {
    let card = cardCache.get(s);
    if (card === undefined) {
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
        tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      };
      cardCache.set(s, card);
    }
    return card;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
