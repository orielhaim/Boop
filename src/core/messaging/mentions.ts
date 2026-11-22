const nameCharacters = /[\p{L}\p{M}\p{N}_.-]/u;
const activeMention = /(?:^|[\s([{])@([\p{L}\p{M}\p{N}_.-]*)$/u;

export function mentionAt(
  text: string,
  selection: { start: number; end: number },
) {
  const { start, end } = selection;
  if (start !== end || start < 0 || start > text.length) return;
  const query = activeMention.exec(text.slice(0, start))?.[1];
  if (query === undefined) return;
  let tokenEnd = start;
  for (const character of text.slice(start)) {
    if (!nameCharacters.test(character)) break;
    tokenEnd += character.length;
  }
  return { query, start: start - query.length - 1, end: tokenEnd };
}

export function insertMention(
  text: string,
  range: { start: number; end: number },
  npub: string,
) {
  const after = text.slice(range.end);
  const hasSeparator = /^\s/u.test(after);
  const token = `nostr:${npub}${hasSeparator ? "" : " "}`;
  const caret = range.start + token.length + Number(hasSeparator);
  return { text: text.slice(0, range.start) + token + after, caret };
}

type MentionSpan = {
  start: number;
  end: number;
  wireStart: number;
  wireEnd: number;
};

export function projectMentions(
  wire: string,
  names: ReadonlyMap<string, string>,
) {
  const mentions: MentionSpan[] = [];
  if (!names.size) return { wire, text: wire, mentions };
  let text = "";
  let consumed = 0;
  for (const match of wire.matchAll(
    /(?:\bnostr:|(?<![\p{L}\p{N}_])@)(npub1[a-z0-9]{58})(?![a-z0-9])/giu,
  )) {
    const name = names.get(match[1].toLowerCase());
    if (!name) continue;
    const wireStart = match.index;
    const wireEnd = wireStart + match[0].length;
    text += wire.slice(consumed, wireStart);
    const start = text.length;
    text += `@${name}`;
    mentions.push({ start, end: text.length, wireStart, wireEnd });
    consumed = wireEnd;
  }
  return { wire, text: text + wire.slice(consumed), mentions };
}

type Projection = ReturnType<typeof projectMentions>;

export function mentionWireOffset(projection: Projection, offset: number) {
  let delta = 0;
  for (const span of projection.mentions) {
    if (offset <= span.start) break;
    if (offset < span.end) return span.wireStart;
    delta = span.wireEnd - span.end;
  }
  return offset + delta;
}

export function editMentionText(projection: Projection, next: string) {
  if (!projection.mentions.length) return next;
  const before = projection.text;
  if (before === next) return projection.wire;
  let start = 0;
  while (
    start < Math.min(before.length, next.length) &&
    before[start] === next[start]
  )
    start++;
  let end = before.length;
  let nextEnd = next.length;
  while (
    end > start &&
    nextEnd > start &&
    before[end - 1] === next[nextEnd - 1]
  ) {
    end--;
    nextEnd--;
  }
  const matchingTail = projection.mentions.find(
    (span) => span.start >= start && span.start < end && end < span.end,
  );
  if (matchingTail) {
    const prefix = before.slice(matchingTail.start, end);
    const prefixStart = nextEnd - prefix.length;
    if (prefixStart >= 0 && next.slice(prefixStart, nextEnd) === prefix) {
      start = Math.min(start, prefixStart);
      end = matchingTail.start;
      nextEnd = prefixStart;
    }
  }
  // Edits inside a name make that occurrence ordinary text. Untouched mentions keep their IDs.
  const head = projection.mentions.find(
    (span) => span.start < start && start < span.end,
  );
  const tail = projection.mentions.find(
    (span) => span.start < end && end < span.end,
  );
  return (
    projection.wire.slice(0, mentionWireOffset(projection, start)) +
    (head ? before.slice(head.start, start) : "") +
    next.slice(start, nextEnd) +
    (tail ? before.slice(end, tail.end) : "") +
    projection.wire.slice(tail?.wireEnd ?? mentionWireOffset(projection, end))
  );
}
