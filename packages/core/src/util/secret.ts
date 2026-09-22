/**
 * Reading a credential out of the environment, and noticing when it arrived damaged.
 *
 * Every dashboard that stores secrets - Render, Vercel, a .env file edited in a hurry - will
 * happily keep whatever was on the clipboard, including the newline the copy button added and
 * the quotes someone typed around it out of shell habit. The key is then correct in every
 * sense the person can see, and the provider still answers 401 or 403, because what we send
 * is `"abc123"` or `abc123\n` rather than `abc123`.
 *
 * That failure is indistinguishable from a wrong key at the HTTP layer, which makes it the
 * same class of problem as the rest of this directory: a configuration fault wearing a
 * credential fault's clothes, sending someone off to regenerate a key that was never wrong.
 *
 * So: strip it, and say that it was stripped. The stripping is what makes the key work; the
 * saying is what stops the next hour being spent on the wrong suspect.
 */

export interface SecretShape {
  /** Characters in the usable value. Never the value itself. */
  length: number;
  /** Surrounding whitespace, including the trailing newline a copy button leaves behind. */
  hadWhitespace: boolean;
  /** A matched pair of single or double quotes wrapped around the value. */
  hadQuotes: boolean;
  /** Whitespace *inside* the value, which trimming cannot fix - usually a truncated paste. */
  hasInnerWhitespace: boolean;
}

export interface ReadSecret {
  value: string | undefined;
  shape: SecretShape | null;
}

/** Strip the damage a clipboard does, and report what had to be stripped. */
export function readSecret(raw: string | undefined): ReadSecret {
  if (raw === undefined || raw === null) return { value: undefined, shape: null };
  const trimmed = raw.trim();
  const hadWhitespace = trimmed !== raw;

  // Only a *matched* pair is removed. A key that legitimately ends in a quote is not a thing
  // any of these providers issue, but stripping one-sided quotes would corrupt a valid value.
  const quoted = trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")));
  const unquoted = quoted ? trimmed.slice(1, -1).trim() : trimmed;

  if (!unquoted) return { value: undefined, shape: { length: 0, hadWhitespace, hadQuotes: quoted, hasInnerWhitespace: false } };

  return {
    value: unquoted,
    shape: { length: unquoted.length, hadWhitespace, hadQuotes: quoted, hasInnerWhitespace: /\s/.test(unquoted) },
  };
}

/** Just the cleaned value, for call sites that only need the credential. */
export function secret(raw: string | undefined): string | undefined {
  return readSecret(raw).value;
}

/**
 * A sentence about the credential's shape that is safe to show an operator.
 *
 * Deliberately never includes the value, not even a prefix: an admin page is screen-shared
 * and pasted into chats, and a "just the first four characters" habit is how key fragments
 * end up in tickets. Length and damage are enough to tell a mangled paste from a wrong key.
 */
export function describeSecretShape(shape: SecretShape | null): string {
  if (!shape) return "";
  const notes: string[] = [];
  if (shape.hadQuotes) notes.push("the stored value was wrapped in quotes, which are not part of the key");
  if (shape.hadWhitespace) notes.push("the stored value had surrounding whitespace or a trailing newline");
  if (shape.hasInnerWhitespace) notes.push("the value contains a space or line break inside it, which usually means the paste was truncated or split");
  if (!notes.length) return `the stored key is ${shape.length} characters with no stray whitespace or quotes, so it is reaching the provider exactly as stored`;
  return `${notes.join("; ")} (${shape.length} characters after cleaning)`;
}
