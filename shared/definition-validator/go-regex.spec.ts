import { goRegexProblem } from './go-regex';

describe('goRegexProblem', () => {
  it.each([
    'abc',
    '^order-\\d+$',
    '(?i)hello',
    'a(?i)b',
    '(?i:hello) world',
    '(?s-i:a.b)',
    '(?P<id>\\d+)',
    '(?<id>\\d+)',
    '(?:a|b)+',
    '\\(?=',
    '[(?=]',
    '\\\\1',
    '[[:alpha:]]+',
  ])('accepts %s', (pattern) => {
    expect(goRegexProblem(pattern)).toBeNull();
  });

  it.each([
    ['foo(?=bar)', 'lookaround'],
    ['foo(?!bar)', 'lookaround'],
    ['(?<=foo)bar', 'lookaround'],
    ['(?<!foo)bar', 'lookaround'],
    ['(?i)^(?!.*refund).*charge', 'lookaround'],
    ['(a)\\1', 'backreferences'],
    ['(?<n>a)\\k<n>', 'backreferences'],
    ['[invalid', 'Invalid regular expression'],
    ['a)', 'Invalid regular expression'],
    ['*a', 'Invalid regular expression'],
  ])('rejects %s', (pattern, problem) => {
    expect(goRegexProblem(pattern)).toContain(problem);
  });
});
