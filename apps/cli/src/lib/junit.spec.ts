import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

jest.mock('./cli-utils', () => ({
  fetchJson: jest.fn(),
}));

import { writeJUnitXml, generateJUnitXml } from './junit';
import { fetchJson } from './cli-utils';

const mockFetchJson = fetchJson as jest.MockedFunction<typeof fetchJson>;

describe('writeJUnitXml', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'junit-test-'));
    mockFetchJson.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes one testcase per instance for a passing run', async () => {
    mockFetchJson.mockResolvedValue([
      {
        id: 'a1',
        instanceId: 'inst-1',
        stepIndex: 0,
        assertionIndex: 0,
        assertionType: 'statusCode',
        passed: true,
        expected: 200,
        actual: 200,
        error: null,
        path: null,
        operator: 'equals',
        blockIndex: null,
        resultKind: null,
      },
    ]);

    const outputPath = path.join(tmpDir, 'results.xml');
    await writeJUnitXml({
      ctUrl: 'http://localhost:19001',
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'checkout-flow',
          status: 'STOPPED',
          testStatus: 'PASSED',
        },
      ],
      outputPath,
      durationMs: 5000,
    });

    const xml = fs.readFileSync(outputPath, 'utf-8');
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('<testsuites tests="1" failures="0"');
    expect(xml).toContain('<testsuite name="run-1" tests="1" failures="0"');
    expect(xml).toContain('name="checkout-flow"');
    expect(xml).toContain('classname="checkout-flow"');
    expect(xml).not.toContain('<failure');
    // One testcase, not one per assertion
    expect(xml.match(/<testcase /g)?.length).toBe(1);
  });

  it('writes failure details from assertions into a single testcase', async () => {
    mockFetchJson.mockResolvedValue([
      {
        id: 'a1',
        instanceId: 'inst-1',
        stepIndex: 0,
        assertionIndex: 0,
        assertionType: 'statusCode',
        passed: true,
        expected: 200,
        actual: 200,
        error: null,
        path: null,
        operator: 'equals',
        blockIndex: null,
        resultKind: null,
      },
      {
        id: 'a2',
        instanceId: 'inst-1',
        stepIndex: 1,
        assertionIndex: 0,
        assertionType: 'body',
        passed: false,
        expected: { name: 'Alice' },
        actual: { name: 'Bob' },
        error: null,
        path: '$.name',
        operator: 'equals',
        blockIndex: null,
        resultKind: null,
      },
    ]);

    const outputPath = path.join(tmpDir, 'results.xml');
    await writeJUnitXml({
      ctUrl: 'http://localhost:19001',
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'user-test',
          status: 'STOPPED',
          testStatus: 'FAILED',
        },
      ],
      outputPath,
      durationMs: 3000,
    });

    const xml = fs.readFileSync(outputPath, 'utf-8');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('<failure');
    expect(xml).toContain('1 assertion(s) failed');
    expect(xml).toContain('$.name');
    expect(xml).toContain('Alice');
    expect(xml).toContain('Bob');
    expect(xml.match(/<testcase /g)?.length).toBe(1);
  });

  it('handles instances with no assertions', async () => {
    mockFetchJson.mockResolvedValue([]);

    const outputPath = path.join(tmpDir, 'results.xml');
    await writeJUnitXml({
      ctUrl: 'http://localhost:19001',
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'infra-test',
          status: 'FAILED',
          errorMessage: 'Container crashed',
        },
      ],
      outputPath,
      durationMs: 1000,
    });

    const xml = fs.readFileSync(outputPath, 'utf-8');
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('Container crashed');
  });

  it('marks skipped instances', async () => {
    const outputPath = path.join(tmpDir, 'results.xml');
    await writeJUnitXml({
      ctUrl: 'http://localhost:19001',
      runId: 'run-1',
      instances: [
        {
          id: 'skipped-bad',
          name: 'bad',
          status: 'SKIPPED',
          testStatus: 'SKIPPED',
          errorMessage: 'Invalid definition',
        },
      ],
      outputPath,
      durationMs: 500,
    });

    const xml = fs.readFileSync(outputPath, 'utf-8');
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('<skipped/>');
  });

  it('returns XML string from generateJUnitXml', async () => {
    mockFetchJson.mockResolvedValue([]);

    const xml = await generateJUnitXml({
      ctUrl: 'http://localhost:19001',
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'my-test',
          status: 'STOPPED',
          testStatus: 'PASSED',
        },
      ],
      durationMs: 2000,
    });

    expect(typeof xml).toBe('string');
    expect(xml).toContain('<?xml version="1.0"');
    expect(xml).toContain('name="my-test"');
  });

  it('escapes XML special characters in names and messages', async () => {
    mockFetchJson.mockResolvedValue([]);

    const outputPath = path.join(tmpDir, 'results.xml');
    await writeJUnitXml({
      ctUrl: 'http://localhost:19001',
      runId: 'run-1',
      instances: [
        {
          id: 'inst-1',
          name: 'test <with> "special" chars',
          status: 'FAILED',
          errorMessage: 'Expected <200> & got "500"',
        },
      ],
      outputPath,
      durationMs: 1000,
    });

    const xml = fs.readFileSync(outputPath, 'utf-8');
    expect(xml).toContain('&lt;with&gt;');
    expect(xml).toContain('&quot;special&quot;');
    expect(xml).toContain('&lt;200&gt;');
    expect(xml).toContain('&amp;');
  });
});
