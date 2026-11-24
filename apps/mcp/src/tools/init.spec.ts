import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDefinitions } from '@dokkimi/definition-resolver';
import { createMockServer } from './__helpers__/mock-server';
import { registerInit } from './init';

it('creates an example that validates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'init-'));
  jest.spyOn(process, 'cwd').mockReturnValue(dir);
  const { server, call } = createMockServer();
  registerInit(server);

  await call('init');
  const { definitions, errors } = resolveDefinitions();
  fs.rmSync(dir, { recursive: true });

  expect(errors).toEqual([]);
  expect(definitions).toHaveLength(1);
});
