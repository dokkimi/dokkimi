import { Logger } from '@nestjs/common';
import { loadConfig } from '@dokkimi/config';
import * as path from 'path';

const configPath =
  process.env.CONFIG_PATH ||
  path.resolve(__dirname, '../../../config', 'config.yaml');

try {
  loadConfig(configPath);
} catch (error) {
  console.warn('Failed to load config in test setup:', error);
}

Logger.prototype.error = jest.fn() as typeof Logger.prototype.error;
Logger.prototype.warn = jest.fn() as typeof Logger.prototype.warn;
Logger.prototype.log = jest.fn() as typeof Logger.prototype.log;
Logger.prototype.debug = jest.fn() as typeof Logger.prototype.debug;
Logger.prototype.verbose = jest.fn() as typeof Logger.prototype.verbose;
