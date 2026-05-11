import { BadRequestException } from '@nestjs/common';
import { ArtifactsController } from './artifacts.controller';

describe('ArtifactsController', () => {
  let controller: ArtifactsController;

  const mockArtifacts: any = {
    persist: jest.fn(),
    listForInstance: jest.fn(),
    listPendingBaselines: jest.fn(),
    hasPendingBaselines: jest.fn(),
    updateVerdict: jest.fn(),
  };

  beforeEach(() => {
    controller = new ArtifactsController(mockArtifacts);
    jest.clearAllMocks();
  });

  describe('upload', () => {
    it('calls artifacts.persist with dto and file buffer', async () => {
      const dto = {
        instanceId: 'inst-1',
        stepIndex: 0,
        subStepIndex: 0,
        type: 'screenshot',
        name: 'checkout',
      };
      const file = { buffer: Buffer.from('png-data') } as Express.Multer.File;
      mockArtifacts.persist.mockResolvedValue({
        id: 'art-1',
        uri: '/path/to/art',
      });

      const result = await controller.upload(file, dto as any);

      expect(mockArtifacts.persist).toHaveBeenCalledWith(dto, file.buffer);
      expect(result).toEqual({ id: 'art-1', uri: '/path/to/art' });
    });

    it('throws BadRequestException when no file provided', async () => {
      const dto = {
        instanceId: 'inst-1',
        stepIndex: 0,
        subStepIndex: 0,
        type: 'screenshot',
      };

      await expect(controller.upload(undefined, dto as any)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('listForInstance', () => {
    it('returns artifacts wrapped in object', async () => {
      const artifacts = [{ id: 'art-1', name: 'checkout', type: 'screenshot' }];
      mockArtifacts.listForInstance.mockResolvedValue(artifacts);

      const result = await controller.listForInstance('inst-1');

      expect(mockArtifacts.listForInstance).toHaveBeenCalledWith('inst-1');
      expect(result).toEqual({ artifacts });
    });

    it('returns empty array when no artifacts', async () => {
      mockArtifacts.listForInstance.mockResolvedValue([]);

      const result = await controller.listForInstance('inst-1');

      expect(result).toEqual({ artifacts: [] });
    });
  });

  describe('listPendingBaselines', () => {
    it('returns pending baselines', async () => {
      const pending = [{ id: 'art-2', name: 'cart', verdict: 'no-baseline' }];
      mockArtifacts.listPendingBaselines.mockResolvedValue(pending);

      const result = await controller.listPendingBaselines('inst-1');

      expect(mockArtifacts.listPendingBaselines).toHaveBeenCalledWith('inst-1');
      expect(result).toEqual({ pending });
    });
  });

  describe('hasPendingBaselines', () => {
    it('returns true when pending baselines exist', async () => {
      mockArtifacts.hasPendingBaselines.mockResolvedValue(true);

      const result = await controller.hasPendingBaselines('run-1');

      expect(mockArtifacts.hasPendingBaselines).toHaveBeenCalledWith('run-1');
      expect(result).toEqual({ hasPending: true });
    });

    it('returns false when no pending baselines', async () => {
      mockArtifacts.hasPendingBaselines.mockResolvedValue(false);

      const result = await controller.hasPendingBaselines('run-1');

      expect(result).toEqual({ hasPending: false });
    });
  });

  describe('updateVerdict', () => {
    it('accepts "approved" verdict', async () => {
      mockArtifacts.updateVerdict.mockResolvedValue(undefined);

      const result = await controller.updateVerdict('art-1', {
        verdict: 'approved',
      });

      expect(mockArtifacts.updateVerdict).toHaveBeenCalledWith(
        'art-1',
        'approved',
      );
      expect(result).toEqual({ ok: true });
    });

    it('accepts "skipped" verdict', async () => {
      mockArtifacts.updateVerdict.mockResolvedValue(undefined);

      const result = await controller.updateVerdict('art-1', {
        verdict: 'skipped',
      });

      expect(mockArtifacts.updateVerdict).toHaveBeenCalledWith(
        'art-1',
        'skipped',
      );
      expect(result).toEqual({ ok: true });
    });

    it('throws BadRequestException for invalid verdict', async () => {
      await expect(
        controller.updateVerdict('art-1', { verdict: 'rejected' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws BadRequestException for empty verdict', async () => {
      await expect(
        controller.updateVerdict('art-1', { verdict: '' }),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
