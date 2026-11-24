import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { init } from './init';

it('creates an example that validates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  jest.spyOn(process, 'cwd').mockReturnValue(dir);
  jest.spyOn(console, 'log').mockImplementation();

  await init([]);
  const { definitions, errors } = resolveDefinitions();
  fs.rmSync(dir, { recursive: true });

  expect(errors).toEqual([]);
  expect(definitions).toHaveLength(1);
});
