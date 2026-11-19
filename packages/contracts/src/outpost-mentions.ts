export interface NamedOutpost { id: string; name?: string | undefined }
export interface OutpostMention { text: string; outpostId?: string }

/** AI prose often abbreviates IDs. Resolve only map references with explicit
 * location syntax; bare quantities, timestamps and opaque IDs stay untouched. */
export function aiOutpostMentions(text: string, outposts: NamedOutpost[]): OutpostMention[] {
  const numbers = new Map<number, NamedOutpost | null>();
  for (const post of outposts) {
    const match = /^据点\s*(\d+)$/.exec(post.id);
    if (!match) continue;
    const n = Number(match[1]), previous = numbers.get(n);
    if (previous === undefined) numbers.set(n, post);
    else if (previous?.id !== post.id) numbers.set(n, null);
  }
  const location = /(?<![A-Za-z0-9_.-])\d{1,3}(?:号(?:据点)?)?(?![A-Za-z0-9_.-])/g;
  const parts: OutpostMention[] = [];
  for (const part of outpostMentions(text, outposts)) {
    if (part.outpostId) {
      const post = outposts.find(p => p.id === part.outpostId);
      parts.push({...part, text: post?.name || part.text});
      continue;
    }
    let end = 0;
    for (const match of part.text.matchAll(location)) {
      const start = match.index, value = match[0];
      const before = part.text.slice(0, start), after = part.text.slice(start + value.length);
      const post = numbers.get(Number(value.replace(/号.*$/, '')));
      if (!post?.name) continue;
      // A bare "22矿" can mean mined resources, so it is deliberately not an alias.
      const explicit = value.includes('号') || /^(?:驻军|驻兵|现有?\d|仍有?\d|留\d|实有\d)/.test(after);
      const route = /(?:→|←|↔|->)\s*$/.test(before) || /^\s*(?:→|←|↔|->)/.test(after);
      const action = /(?:攻|守|赴|撤往|撤回|抵达|增援|反夺|占领)\s*$/.test(before) &&
        !/^(?:兵|盾|小时|分钟|秒|天|日|%|％)/.test(after.trimStart());
      if (!explicit && !route && !action) continue;
      if (start > end) parts.push({text: part.text.slice(end, start)});
      parts.push({text: post.name, outpostId: post.id});
      end = start + value.length;
    }
    if (end < part.text.length) parts.push({text: part.text.slice(end)});
  }
  return parts;
}

/** Match only known map names/IDs, preserving message text and punctuation. */
export function outpostMentions(text: string, outposts: NamedOutpost[]): OutpostMention[] {
  const aliases = new Map<string, string | null>();
  for (const post of outposts) {
    const number=/^据点\s*(\d+)$/.exec(post.id);
    const numberedAliases=number?[post.id.replace(/\s+/g,''),`据点${Number(number[1])}`,`据点 ${Number(number[1])}`]:[];
    for (const alias of [post.name,post.id,...numberedAliases]) {
      if (!alias) continue;
      const key = alias.toUpperCase();
      if (!aliases.has(key)) aliases.set(key, post.id);
      else if (aliases.get(key) !== post.id) aliases.set(key, null);
    }
  }
  const names = [...aliases.keys()].filter(key => aliases.get(key))
    .sort((a, b) => b.length - a.length)
    .map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!names.length) return [{text}];
  const pattern = new RegExp(names.join('|'), 'gi');
  const parts: OutpostMention[] = [];
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index, value = match[0];
    // English names may adjoin Chinese prose, but must not match inside words.
    if (/[a-z0-9_]/i.test(value[0]!) && /[a-z0-9_]/i.test(text[start - 1] ?? '') ||
        /[a-z0-9_]/i.test(value.at(-1)!) && /[a-z0-9_]/i.test(text[start + value.length] ?? '')) continue;
    if (start > end) parts.push({text: text.slice(end, start)});
    parts.push({text: value, outpostId: aliases.get(value.toUpperCase())!});
    end = start + value.length;
  }
  if (end < text.length) parts.push({text: text.slice(end)});
  return parts;
}
