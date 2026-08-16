import * as path from 'path';
import { DOKKIMI_DIR, projectRunsDir } from './paths';

describe('projectRunsDir', () => {
  it('strips a leading POSIX separator', () => {
    expect(projectRunsDir('/Users/x/proj')).toBe(
      path.join(DOKKIMI_DIR, 'runs', 'Users/x/proj'),
    );
  });

  it('strips a Windows drive letter and its separator', () => {
    expect(projectRunsDir('C:\\Users\\x\\proj')).toBe(
      path.join(DOKKIMI_DIR, 'runs', 'Users\\x\\proj'),
    );
  });

  it('strips a UNC prefix', () => {
    expect(projectRunsDir('\\\\server\\share\\proj')).toBe(
      path.join(DOKKIMI_DIR, 'runs', 'server\\share\\proj'),
    );
  });

  it('leaves no colon inside the generated segment', () => {
    // A colon is illegal in a Windows path component, so an embedded drive
    // letter makes the directory impossible to create (ENOENT on mkdir).
    const result = projectRunsDir('C:\\Users\\x\\proj');
    expect(result.slice(DOKKIMI_DIR.length)).not.toContain(':');
  });

  it('is idempotent for an already-relative path', () => {
    expect(projectRunsDir('Users/x/proj')).toBe(
      path.join(DOKKIMI_DIR, 'runs', 'Users/x/proj'),
    );
  });
});
