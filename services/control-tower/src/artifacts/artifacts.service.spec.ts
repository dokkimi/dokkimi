import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { ArtifactsService } from './artifacts.service';
import { PrismaService } from '../prisma/prisma.service';
import { RunStorageService } from '../storage/run-storage.service';
import type { UploadArtifactDto } from './dto/upload-artifact.dto';

describe('ArtifactsService', () => {
  let service: ArtifactsService;
  const mockArtifactCreate = jest.fn();
  const mockPersistArtifact = jest.fn();

  const mockPrisma = {
    artifact: { create: mockArtifactCreate },
  };

  const mockStorage = { persistArtifact: mockPersistArtifact };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPersistArtifact.mockResolvedValue({
      folder: 'screenshot',
      filename: 'foo.png',
      fullPath: '/tmp/foo.png',
      uri: 'instances/inst-1/artifacts/screenshot/foo.png',
    });
    mockArtifactCreate.mockResolvedValue({
      id: 'art-1',
      uri: 'instances/inst-1/artifacts/screenshot/foo.png',
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ArtifactsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RunStorageService, useValue: mockStorage },
      ],
    }).compile();

    service = module.get<ArtifactsService>(ArtifactsService);
  });

  function dto(overrides: Partial<UploadArtifactDto> = {}): UploadArtifactDto {
    return {
      instanceId: 'inst-1',
      stepIndex: 2,
      subStepIndex: 7,
      type: 'screenshot',
      ...overrides,
    } as UploadArtifactDto;
  }

  describe('persist — happy paths', () => {
    it('persists a named screenshot (visualMatch capture / explicit primitive)', async () => {
      const result = await service.persist(
        dto({ name: 'checkout-page' }),
        Buffer.from('png-bytes'),
      );

      expect(result).toEqual({
        id: 'art-1',
        uri: 'instances/inst-1/artifacts/screenshot/foo.png',
      });
      expect(mockPersistArtifact).toHaveBeenCalledWith(
        'inst-1',
        'screenshot',
        Buffer.from('png-bytes'),
        { stepIndex: 2, subStepIndex: 7 },
        'checkout-page',
        false,
      );
      expect(mockArtifactCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            type: 'screenshot',
            name: 'checkout-page',
            uri: 'instances/inst-1/artifacts/screenshot/foo.png',
          }),
        }),
      );
    });

    it('persists a nameless screenshot (debug failure capture)', async () => {
      await service.persist(dto({ type: 'screenshot' }), Buffer.from('x'));
      expect(mockPersistArtifact).toHaveBeenCalledWith(
        'inst-1',
        'screenshot',
        Buffer.from('x'),
        { stepIndex: 2, subStepIndex: 7 },
        null,
        false,
      );
    });

    it('persists a named diff (visualMatch failure)', async () => {
      await service.persist(
        dto({ type: 'diff', name: 'checkout-page' }),
        Buffer.from('x'),
      );
      expect(mockPersistArtifact).toHaveBeenCalled();
    });

    it('persists nameless html (debug failure capture)', async () => {
      await service.persist(dto({ type: 'html' }), Buffer.from('<html/>'));
      expect(mockPersistArtifact).toHaveBeenCalled();
    });
  });

  describe('persist — type/name pairing rejections', () => {
    it("rejects type='diff' without a name", async () => {
      await expect(
        service.persist(dto({ type: 'diff' }), Buffer.from('x')),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPersistArtifact).not.toHaveBeenCalled();
    });

    it("rejects type='html' WITH a name", async () => {
      await expect(
        service.persist(
          dto({ type: 'html', name: 'unexpected' }),
          Buffer.from('x'),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mockPersistArtifact).not.toHaveBeenCalled();
    });
  });

  describe('persist — payload validation', () => {
    it('rejects an empty payload', async () => {
      await expect(
        service.persist(dto({ name: 'x' }), Buffer.alloc(0)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
