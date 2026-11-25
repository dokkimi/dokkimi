/**
 * What is wrong with a regex that runs in the Go services, or null. Checks it as
 * JavaScript, apart from the differences people run into: Go has flags like
 * `(?i)` and `(?P<name>...)`, and no lookaround or backreferences.
 */
export function goRegexProblem(pattern: string): string | null {
  // Without escapes and character classes, "(?" and "(" are always syntax
  const bare = pattern
    .replace(/\\[^1-9k]/g, '_')
    .replace(/\[\^?\]?[^\]]*\]/g, '_');
  if (/\(\?<?[=!]/.test(bare)) {
    return 'lookaround is not supported';
  }
  if (/\\[1-9k]/.test(bare)) {
    return 'backreferences are not supported';
  }

  try {
    new RegExp(
      pattern
        .replace(/\(\?[imsU]*(?:-[imsU]+)?\)/g, '')
        .replace(/\(\?[imsU]*(?:-[imsU]+)?:/g, '(?:')
        .replace(/\(\?P</g, '(?<'),
    );
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
