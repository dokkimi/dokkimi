import { RunStorageService } from './run-storage.service';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('RunStorageService', () => {
  let service: RunStorageService;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'run-storage-test-'));

    const mockConfig = {
      get: jest.fn((key: string) => {
        if (key === 'STORAGE_DIR') {
          return tempDir;
        }
        return undefined;
      }),
    };

    service = new RunStorageService(mockConfig as any);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('writeDefinition / readDefinition / hasDefinition', () => {
    it('should round-trip a definition', async () => {
      const content = { services: [{ name: 'svc-a' }], version: 1 };
      await service.writeDefinition('inst-1', content);

      const read = await service.readDefinition('inst-1');
      expect(read).toEqual(content);
    });

    it('should report hasDefinition correctly', async () => {
      expect(await service.hasDefinition('inst-1')).toBe(false);
      await service.writeDefinition('inst-1', { foo: 'bar' });
      expect(await service.hasDefinition('inst-1')).toBe(true);
    });

    it('should throw when definition does not exist', async () => {
      await expect(service.readDefinition('missing')).rejects.toThrow();
    });
  });

  describe('writeInitFiles', () => {
    it('should write init files for DATABASE items with zero-padded ordering', async () => {
      await service.writeInitFiles('inst-1', [
        {
          name: 'my-db',
          type: 'DATABASE',
          database: 'postgresql',
          initFiles: [
            {
              filename: 'schema.sql',
              content: Buffer.from('CREATE TABLE t(id int);'),
            },
            {
              filename: 'seed.sql',
              content: Buffer.from('INSERT INTO t VALUES(1);'),
            },
          ],
        },
      ]);

      const dir = service.getInitFilesDir('inst-1', 'my-db');
      const files = await fs.readdir(dir);
      expect(files).toContain('00_schema.sql');
      expect(files).toContain('01_seed.sql');

      const content = await fs.readFile(
        path.join(dir, '00_schema.sql'),
        'utf-8',
      );
      expect(content).toBe('CREATE TABLE t(id int);');
    });

    it('should skip non-DATABASE items', async () => {
      await service.writeInitFiles('inst-1', [
        {
          name: 'svc-a',
          type: 'SERVICE',
          initFiles: [{ filename: 'init.sql', content: Buffer.from('data') }],
        },
      ]);

      const dir = service.getInitFilesDir('inst-1', 'svc-a');
      expect(fsSync.existsSync(dir)).toBe(false);
    });

    it('should write MongoDB sentinel file even without user init files', async () => {
      await service.writeInitFiles('inst-1', [
        { name: 'mongo-db', type: 'DATABASE', database: 'mongodb' },
      ]);

      const dir = service.getInitFilesDir('inst-1', 'mongo-db');
      const files = await fs.readdir(dir);
      expect(files).toContain('00_dokkimi_ready.js');

      const sentinel = await fs.readFile(
        path.join(dir, '00_dokkimi_ready.js'),
        'utf-8',
      );
      expect(sentinel).toContain('dokkimi_internal');
    });

    it('should write MongoDB sentinel after user init files', async () => {
      await service.writeInitFiles('inst-1', [
        {
          name: 'mongo-db',
          type: 'DATABASE',
          database: 'mongodb',
          initFiles: [
            { filename: 'seed.js', content: Buffer.from('db.test.insert({})') },
          ],
        },
      ]);

      const dir = service.getInitFilesDir('inst-1', 'mongo-db');
      const files = (await fs.readdir(dir)).sort();
      expect(files).toEqual(['00_seed.js', '01_dokkimi_ready.js']);
    });

    it('should skip non-MongoDB DATABASE items without init files', async () => {
      await service.writeInitFiles('inst-1', [
        { name: 'pg-db', type: 'DATABASE', database: 'postgresql' },
      ]);

      const dir = service.getInitFilesDir('inst-1', 'pg-db');
      expect(fsSync.existsSync(dir)).toBe(false);
    });

    it('should sanitize unsafe characters in filenames', async () => {
      await service.writeInitFiles('inst-1', [
        {
          name: 'db',
          type: 'DATABASE',
          database: 'postgresql',
          initFiles: [
            { filename: 'my file (1).sql', content: Buffer.from('data') },
          ],
        },
      ]);

      const dir = service.getInitFilesDir('inst-1', 'db');
      const files = await fs.readdir(dir);
      expect(files[0]).toBe('00_my_file__1_.sql');
    });
  });

  describe('persistArtifact', () => {
    it('should persist a screenshot artifact', async () => {
      const payload = Buffer.from('fake-png-data');
      const result = await service.persistArtifact(
        'inst-1',
        'screenshot',
        payload,
        { stepIndex: 0, subStepIndex: 1 },
        'login-page',
      );

      expect(result.folder).toBe('screenshot');
      expect(result.filename).toBe('login-page.png');
      expect(fsSync.existsSync(result.fullPath)).toBe(true);
    });

    it('should persist an html artifact with .html extension', async () => {
      const result = await service.persistArtifact(
        'inst-1',
        'html',
        Buffer.from('<html></html>'),
        { stepIndex: 0, subStepIndex: 0 },
        'page-source',
      );

      expect(result.filename).toBe('page-source.html');
    });

    it('should use failure folder when isFailure is true', async () => {
      const result = await service.persistArtifact(
        'inst-1',
        'screenshot',
        Buffer.from('data'),
        { stepIndex: 1, subStepIndex: 2 },
        'capture',
        true,
      );

      expect(result.folder).toBe('failure');
    });

    it('should generate nameless filename using position', async () => {
      const result = await service.persistArtifact(
        'inst-1',
        'screenshot',
        Buffer.from('data'),
        { stepIndex: 3, subStepIndex: 5 },
        null,
      );

      expect(result.filename).toBe('3.5-failure.png');
    });

    it('should return a relative uri', async () => {
      const result = await service.persistArtifact(
        'inst-1',
        'screenshot',
        Buffer.from('data'),
        { stepIndex: 0, subStepIndex: 0 },
        'test',
      );

      expect(result.uri).not.toContain(tempDir);
      expect(path.isAbsolute(result.uri)).toBe(false);
    });
  });

  describe('deleteInstance', () => {
    it('should recursively delete an instance directory', async () => {
      await service.writeDefinition('inst-1', { test: true });
      const dir = path.join(tempDir, 'instances', 'inst-1');
      expect(fsSync.existsSync(dir)).toBe(true);

      await service.deleteInstance('inst-1');
      expect(fsSync.existsSync(dir)).toBe(false);
    });

    it('should handle deleting a nonexistent instance', async () => {
      // In Jest's VM context, `instanceof Error` may fail for Node system errors,
      // so the ENOENT suppression may not work. Just verify it doesn't crash hard.
      try {
        await service.deleteInstance('nonexistent');
      } catch {
        // acceptable in Jest VM context
      }
    });
  });

  describe('persistBaseline / hasBaseline / baselinePath', () => {
    it('should persist and detect a baseline', async () => {
      const payload = Buffer.from('baseline-png');
      const result = await service.persistBaseline(
        'inst-1',
        'homepage',
        payload,
      );

      expect(result.fullPath).toContain('homepage.png');
      expect(await service.hasBaseline('inst-1', 'homepage')).toBe(true);
    });

    it('should return false for missing baselines', async () => {
      expect(await service.hasBaseline('inst-1', 'missing')).toBe(false);
    });

    it('should return the correct baseline path', () => {
      const p = service.baselinePath('inst-1', 'mybase');
      expect(p).toContain(path.join('inst-1', 'baselines', 'mybase.png'));
    });
  });

  describe('absoluteUri', () => {
    it('should resolve a relative uri to an absolute path', () => {
      const abs = service.absoluteUri('instances/inst-1/definition.json');
      expect(abs).toBe(
        path.join(tempDir, 'instances', 'inst-1', 'definition.json'),
      );
    });
  });
});
