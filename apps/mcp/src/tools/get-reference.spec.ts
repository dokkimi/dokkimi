import * as fs from 'fs';
import * as path from 'path';

jest.mock('../lib/load-spec', () => ({ loadSpec: () => '' }));

import { extractTopic } from './get-reference';

// The real reference, as an agent gets it
const spec = fs.readFileSync(
  path.join(__dirname, '../../../../shared/docs/dokkimi-instructions.md'),
  'utf-8',
);

const headingsOf = (text: string) =>
  text.split('\n').filter((l) => /^#{2,3} /.test(l));

describe('get_reference topics', () => {
  it('config is the definition config, not the config file', () => {
    const text = extractTopic(spec, 'config');
    expect(text.split('\n')[0]).toBe('## Config');
    expect(text).toContain('timeoutSeconds');
    expect(text).not.toContain('## Config File');
  });

  it('a "#" comment in a code example does not end a section', () => {
    const text = extractTopic(spec, 'ref');
    expect(text).toContain('## $ref (Action References)');
    expect(text).toContain('### UI sub-step `$ref`');
    expect(text).toContain('### Rules');
  });

  it('a parent heading gives only its introduction', () => {
    const service = extractTopic(spec, 'service');
    expect(headingsOf(service)).toEqual(['## Item Types', '### SERVICE']);

    const ui = extractTopic(spec, 'ui');
    expect(headingsOf(ui)).toEqual(['## Tests', '### Step Actions']);
    expect(ui).not.toContain('### Assertion Blocks');
  });

  it('has topics for workers, brokers and loops', () => {
    expect(headingsOf(extractTopic(spec, 'worker'))).toEqual([
      '## Item Types',
      '### WORKER',
    ]);
    expect(headingsOf(extractTopic(spec, 'broker'))).toEqual([
      '## Item Types',
      '### BROKER',
    ]);
    expect(extractTopic(spec, 'loops')).toContain('### Loops');
  });

  it('every topic returns a section', () => {
    for (const topic of [
      'service',
      'worker',
      'database',
      'mock',
      'broker',
      'tests',
      'assertions',
      'loops',
      'variables',
      'ui',
      'config',
      'ref',
      'examples',
    ]) {
      expect(extractTopic(spec, topic)).not.toBe('');
    }
  });
});
