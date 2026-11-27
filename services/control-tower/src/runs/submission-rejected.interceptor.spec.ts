import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RunsController } from './runs.controller';
import { RunsService } from './runs.service';
import { RunStorageService } from '../storage/run-storage.service';

// Before, a submission the validation pipe rejected never reached the
// service: the instance stayed PENDING and the CLI waited forever.
describe('a rejected submission', () => {
  let app: INestApplication;
  const runs = {
    submitInstance: jest.fn(),
    rejectSubmission: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [RunsController],
      providers: [
        { provide: RunsService, useValue: runs },
        { provide: RunStorageService, useValue: {} },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    // As in main.ts
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('fails its instance, and still returns the 400', async () => {
    const res = await request(app.getHttpServer())
      .post('/runs/run-1/instances/inst-1')
      .send({ definition: { name: 'd', items: [], tests: [], bogus: 1 } });

    expect(res.status).toBe(400);
    expect(runs.submitInstance).not.toHaveBeenCalled();
    expect(runs.rejectSubmission).toHaveBeenCalledWith(
      'run-1',
      'inst-1',
      expect.objectContaining({ status: 400 }),
    );
  });

  it('leaves an accepted submission alone', async () => {
    runs.submitInstance.mockResolvedValue({ status: 'PENDING' });
    const res = await request(app.getHttpServer())
      .post('/runs/run-1/instances/inst-1')
      .send({ definition: { name: 'd', items: [], tests: [] } });

    expect(res.status).toBe(201);
    expect(runs.rejectSubmission).not.toHaveBeenCalled();
  });
});
