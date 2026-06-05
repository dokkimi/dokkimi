import { Controller, Get, Param, Res, NotFoundException } from '@nestjs/common';
import * as express from 'express';
import { RunStorageService } from './run-storage.service';
import * as fs from 'fs';
import { createDirectoryTar } from '@dokkimi/platform';

@Controller('init-files')
export class InitFilesController {
  constructor(private readonly runStorage: RunStorageService) {}

  @Get(':instanceId/:itemName')
  async getInitFiles(
    @Param('instanceId') instanceId: string,
    @Param('itemName') itemName: string,
    @Res() res: express.Response,
  ): Promise<void> {
    const dir = await this.runStorage.getInitFilesDir(instanceId, itemName);

    if (!fs.existsSync(dir)) {
      throw new NotFoundException(
        `Init files not found for instance=${instanceId}, item=${itemName}`,
      );
    }

    res.setHeader('Content-Type', 'application/x-tar');
    createDirectoryTar(dir).pipe(res);
  }
}
