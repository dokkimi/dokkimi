import { unix } from './platform-unix';
import { windows } from './platform-windows';
import type { Platform } from './platform';

export type { Platform, ExecOptions, SpawnOptions, SpawnResult } from './platform';

const platform: Platform = process.platform === 'win32' ? windows : unix;

export const isProcessAlive = platform.isProcessAlive.bind(platform);
export const killProcess = platform.killProcess.bind(platform);
export const findProcessesByPattern =
  platform.findProcessesByPattern.bind(platform);
export const execSilent = platform.execSilent.bind(platform);
export const isCommandAvailable = platform.isCommandAvailable.bind(platform);
export const openFile = platform.openFile.bind(platform);
export const startDocker = platform.startDocker.bind(platform);
export const getDiskSpaceAvailable =
  platform.getDiskSpaceAvailable.bind(platform);
export const spawnInShell = platform.spawnInShell.bind(platform);

export { createDirectoryTar } from './tar';
