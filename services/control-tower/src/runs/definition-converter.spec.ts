import {
  stripInitFileContent,
  toDeployableDefinition,
  rawDefinitionToDeployable,
} from './definition-converter';

describe('definition-converter', () => {
  describe('stripInitFileContent', () => {
    it('removes content from init files, keeps filename', () => {
      const definition = {
        name: 'test-def',
        items: [
          {
            name: 'db',
            type: 'DATABASE',
            database: 'postgres',
            initFiles: [
              { filename: 'schema.sql', content: 'Q1JFQVRFIFRBQkxF' },
              { filename: 'seed.sql', content: 'SU5TRVJUIElOVE8=' },
            ],
          },
        ],
      };

      const result = stripInitFileContent(definition as any);

      expect(result.name).toBe('test-def');
      expect((result as any).items[0].initFiles).toEqual([
        { filename: 'schema.sql' },
        { filename: 'seed.sql' },
      ]);
    });

    it('preserves items without init files', () => {
      const definition = {
        name: 'test-def',
        items: [
          { name: 'svc', type: 'SERVICE', image: 'api:latest', port: 8080 },
        ],
      };

      const result = stripInitFileContent(definition as any);

      expect((result as any).items[0].initFiles).toBeUndefined();
    });

    it('preserves non-item fields', () => {
      const definition = {
        name: 'test-def',
        description: 'A test',
        items: [],
        tests: [{ name: 'test-1' }],
        variables: { key: 'val' },
      };

      const result = stripInitFileContent(definition as any);

      expect(result.description).toBe('A test');
      expect((result as any).tests).toEqual([{ name: 'test-1' }]);
      expect((result as any).variables).toEqual({ key: 'val' });
    });
  });

  describe('toDeployableDefinition', () => {
    it('converts base64 init file content to Buffer', () => {
      const content = Buffer.from('CREATE TABLE').toString('base64');
      const definition = {
        name: 'test-def',
        items: [
          {
            name: 'db',
            type: 'DATABASE',
            database: 'postgres',
            initFiles: [{ filename: 'schema.sql', content }],
          },
        ],
      };

      const result = toDeployableDefinition(definition as any);

      expect(result.items[0].initFiles![0].filename).toBe('schema.sql');
      expect(Buffer.isBuffer(result.items[0].initFiles![0].content)).toBe(true);
      expect(result.items[0].initFiles![0].content.toString()).toBe(
        'CREATE TABLE',
      );
    });

    it('sets initFiles to undefined when empty array', () => {
      const definition = {
        name: 'test-def',
        items: [
          {
            name: 'svc',
            type: 'SERVICE',
            image: 'api:latest',
            port: 8080,
            initFiles: [],
          },
        ],
      };

      const result = toDeployableDefinition(definition as any);

      expect(result.items[0].initFiles).toBeUndefined();
    });

    it('sets initFiles to undefined when not present', () => {
      const definition = {
        name: 'test-def',
        items: [
          { name: 'svc', type: 'SERVICE', image: 'api:latest', port: 8080 },
        ],
      };

      const result = toDeployableDefinition(definition as any);

      expect(result.items[0].initFiles).toBeUndefined();
    });

    it('maps top-level fields', () => {
      const definition = {
        name: 'my-def',
        description: 'desc',
        items: [],
        tests: [{ name: 't1', steps: [] }],
        variables: { foo: 'bar' },
        config: { timeout: 30 },
      };

      const result = toDeployableDefinition(definition as any);

      expect(result.name).toBe('my-def');
      expect(result.description).toBe('desc');
      expect(result.tests).toEqual([{ name: 't1', steps: [] }]);
      expect(result.variables).toEqual({ foo: 'bar' });
      expect(result.config).toEqual({ timeout: 30 });
    });

    it('handles multiple items with mixed init files', () => {
      const definition = {
        name: 'multi',
        items: [
          {
            name: 'db1',
            type: 'DATABASE',
            database: 'postgres',
            initFiles: [
              {
                filename: 'a.sql',
                content: Buffer.from('A').toString('base64'),
              },
            ],
          },
          { name: 'svc', type: 'SERVICE', image: 'x:1', port: 80 },
        ],
      };

      const result = toDeployableDefinition(definition as any);

      expect(result.items[0].initFiles).toHaveLength(1);
      expect(result.items[1].initFiles).toBeUndefined();
    });

    it('preserves stage property on items', () => {
      const definition = {
        name: 'staged',
        items: [
          { name: 'db', type: 'DATABASE', database: 'postgres', stage: 0 },
          { name: 'svc', type: 'SERVICE', image: 'x:1', port: 80, stage: 1 },
        ],
      };

      const result = toDeployableDefinition(definition as any);

      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe('db');
      expect(result.items[0].stage).toBe(0);
      expect(result.items[1].name).toBe('svc');
      expect(result.items[1].stage).toBe(1);
    });
  });

  describe('rawDefinitionToDeployable', () => {
    it('creates empty buffers for init files (content was stripped)', () => {
      const raw = {
        name: 'test-def',
        items: [
          {
            name: 'db',
            type: 'DATABASE',
            initFiles: [{ filename: 'schema.sql' }],
          },
        ],
      };

      const result = rawDefinitionToDeployable(raw);

      expect(result.items[0].initFiles).toHaveLength(1);
      expect(result.items[0].initFiles![0].filename).toBe('schema.sql');
      expect(result.items[0].initFiles![0].content.length).toBe(0);
    });

    it('sets initFiles to undefined when empty array', () => {
      const raw = {
        name: 'test-def',
        items: [{ name: 'svc', type: 'SERVICE', initFiles: [] }],
      };

      const result = rawDefinitionToDeployable(raw);

      expect(result.items[0].initFiles).toBeUndefined();
    });

    it('sets initFiles to undefined when not present', () => {
      const raw = {
        name: 'test-def',
        items: [{ name: 'svc', type: 'SERVICE' }],
      };

      const result = rawDefinitionToDeployable(raw);

      expect(result.items[0].initFiles).toBeUndefined();
    });

    it('maps top-level fields', () => {
      const raw = {
        name: 'raw-def',
        description: 'raw desc',
        items: [],
        tests: [{ name: 't1' }],
        variables: { x: 'y' },
        config: { timeout: 60 },
      };

      const result = rawDefinitionToDeployable(raw);

      expect(result.name).toBe('raw-def');
      expect(result.description).toBe('raw desc');
      expect(result.tests).toEqual([{ name: 't1' }]);
      expect(result.variables).toEqual({ x: 'y' });
      expect(result.config).toEqual({ timeout: 60 });
    });

    it('handles undefined description', () => {
      const raw = {
        name: 'minimal',
        items: [],
      };

      const result = rawDefinitionToDeployable(raw);

      expect(result.description).toBeUndefined();
    });

    it('preserves stage property from raw items', () => {
      const raw = {
        name: 'staged',
        items: [
          { name: 'db', type: 'DATABASE', stage: 0 },
          { name: 'svc', type: 'SERVICE', stage: 1 },
        ],
      };

      const result = rawDefinitionToDeployable(raw);

      expect(result.items).toHaveLength(2);
      expect(result.items[0].name).toBe('db');
      expect(result.items[0].stage).toBe(0);
      expect(result.items[1].name).toBe('svc');
      expect(result.items[1].stage).toBe(1);
    });
  });
});
