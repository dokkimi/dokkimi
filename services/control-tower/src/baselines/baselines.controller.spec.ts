import { BadRequestException } from '@nestjs/common';
import { BaselinesController } from './baselines.controller';

describe('BaselinesController', () => {
  let controller: BaselinesController;
  let mockStorage: { persistBaseline: jest.Mock };

  beforeEach(() => {
    mockStorage = {
      persistBaseline: jest
        .fn()
        .mockResolvedValue({ uri: '/baselines/inst-1/img.png' }),
    };
    controller = new BaselinesController(mockStorage as any);
  });

  describe('upload', () => {
    it('should call persistBaseline and return uri on valid upload', async () => {
      const file = {
        buffer: Buffer.from('png data'),
        size: 100,
      } as Express.Multer.File;
      const body = { instanceId: 'inst-1', name: 'img.png' };

      const result = await controller.upload(file, body);

      expect(mockStorage.persistBaseline).toHaveBeenCalledWith(
        'inst-1',
        'img.png',
        file.buffer,
      );
      expect(result).toEqual({ uri: '/baselines/inst-1/img.png' });
    });

    it('should throw BadRequestException when no file is uploaded', async () => {
      const body = { instanceId: 'inst-1', name: 'img.png' };

      await expect(controller.upload(undefined, body)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should throw BadRequestException when file has size 0', async () => {
      const file = { buffer: Buffer.alloc(0), size: 0 } as Express.Multer.File;
      const body = { instanceId: 'inst-1', name: 'img.png' };

      await expect(controller.upload(file, body)).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
