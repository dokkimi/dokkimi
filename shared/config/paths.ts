import * as os from 'os';
import * as path from 'path';

export const DOKKIMI_DIR = path.join(os.homedir(), '.dokkimi');
export const DUMP_DIR = path.join(DOKKIMI_DIR, 'generated');
export const DUMP_PATH = path.join(DUMP_DIR, 'dump.json');
export const DUMP_FAILED_PATH = path.join(DUMP_DIR, 'dump_failed.json');
