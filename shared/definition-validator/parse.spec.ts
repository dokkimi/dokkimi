import { parseDefinitionFile } from './parse';

describe('parseDefinitionFile', () => {
  // Before, "<<" arrived as a literal key
  it('applies YAML merge keys', () => {
    const raw = 'base: &b {a: 1, b: 2}\nbody:\n  <<: *b\n  b: 3\n';
    expect(parseDefinitionFile('d.yaml', raw)).toEqual({
      base: { a: 1, b: 2 },
      body: { a: 1, b: 3 },
    });
  });

  // Before, a file with only a comment was a parse error
  it.each([
    ['d.yaml', '# work in progress\n\n'],
    ['d.yml', ''],
    ['d.json', '  \n'],
  ])('reads an empty %s as nothing', (file, raw) => {
    expect(parseDefinitionFile(file, raw)).toBeUndefined();
  });

  it('still reports invalid YAML', () => {
    expect(() => parseDefinitionFile('d.yaml', 'a: [1, 2\n')).toThrow();
  });
});
