import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { approveAll, PendingItem, WriteContext } from './baselines-ops';

// A project in a temporary folder, with one definition and its captures
function setup(): { root: string; ctx: WriteContext; verdicts: string[] } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dokkimi-baselines-'));
  const sourceFile = path.join(
    root,
    '.dokkimi',
    'shop',
    'definitions',
    'checkout.yaml',
  );
  fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
  fs.writeFileSync(sourceFile, '');
  fs.mkdirSync(path.join(root, 'storage'));
  fs.writeFileSync(path.join(root, 'storage', 'cart.png'), 'png');

  const verdicts: string[] = [];
  global.fetch = jest.fn(async (url: string | URL | Request) => {
    verdicts.push(String(url));
    return new Response('{}');
  }) as typeof fetch;

  return {
    root,
    ctx: {
      sourceByName: new Map([['checkout', sourceFile]]),
      storageDir: path.join(root, 'storage'),
      ctUrl: 'http://ct',
    },
    verdicts,
  };
}

function item(id: string, name: string, uri: string): PendingItem {
  return {
    instanceId: 'i1',
    instanceName: 'checkout',
    artifact: { id, name, uri } as PendingItem['artifact'],
  };
}

describe('approveAll', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  // Before, a baseline that couldn't be written was approved and counted
  it('approves only the baselines it wrote', async () => {
    const { root, ctx, verdicts } = setup();
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const count = await approveAll(
        [item('a1', 'cart', 'cart.png'), item('a2', 'pay', 'pruned.png')],
        ctx,
      );

      expect(count).toBe(1);
      expect(verdicts).toEqual(['http://ct/artifacts/a1/verdict']);
      expect(
        fs.readFileSync(
          path.join(root, '.dokkimi', 'shop', 'baselines', 'cart.png'),
          'utf-8',
        ),
      ).toBe('png');
      expect(errors.mock.calls[0][0]).toContain(
        'the captured screenshot is gone',
      );
    } finally {
      errors.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
