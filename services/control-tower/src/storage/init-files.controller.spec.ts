import { NotFoundException } from '@nestjs/common';
import { InitFilesController } from './init-files.controller';

const mockPipe = jest.fn();
jest.mock('@dokkimi/platform', () => ({
  createDirectoryTar: jest.fn(() => ({ pipe: mockPipe })),
}));

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return { ...actual, existsSync: jest.fn() };
});

import * as fs from 'fs';

describe('InitFilesController', () => {
  let controller: InitFilesController;
  let mockRunStorage: { getInitFilesDir: jest.Mock };
  let mockRes: { setHeader: jest.Mock };

  beforeEach(() => {
    mockRunStorage = {
      getInitFilesDir: jest
        .fn()
        .mockResolvedValue('/tmp/init-files/inst-1/svc-a'),
    };
    mockRes = { setHeader: jest.fn() };
    controller = new InitFilesController(mockRunStorage as any);
    jest.clearAllMocks();
  });

  it('should set Content-Type to application/x-tar and pipe tar stream when directory exists', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createDirectoryTar } = require('@dokkimi/platform');

    await controller.getInitFiles('inst-1', 'svc-a', mockRes as any);

    expect(mockRes.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/x-tar',
    );
    expect(createDirectoryTar).toHaveBeenCalledWith(
      '/tmp/init-files/inst-1/svc-a',
    );
    expect(mockPipe).toHaveBeenCalledWith(mockRes);
  });

  it('should throw NotFoundException when directory does not exist', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);

    await expect(
      controller.getInitFiles('inst-1', 'svc-a', mockRes as any),
    ).rejects.toThrow(NotFoundException);
  });
});
