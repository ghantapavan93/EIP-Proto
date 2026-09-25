/** A same-origin path: one leading "/" not followed by "/" or "\" (browsers read "//x" and "/\x" as another host). */
const SAME_ORIGIN_PATH = /^\/(?![/\\])/;

function hasControlChar(s: string): boolean {
  // Tabs / newlines are stripped by URL parsers, so "/\t/evil.com" would become "//evil.com".
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

/**
 * Where to go after sign-in: the `next` query param when it is a plain
 * same-origin path (and not the login page itself), otherwise "/".
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !SAME_ORIGIN_PATH.test(next) || hasControlChar(next)) return '/';
  if (next.startsWith('/login')) return '/';
  return next;
}
