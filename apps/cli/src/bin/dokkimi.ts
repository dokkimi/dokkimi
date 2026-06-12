#!/usr/bin/env node

import { init } from '../commands/init';
import { DOKKIMI_VERSION } from '@dokkimi/config';
import { run } from '../commands/run';
import { validate } from '../commands/validate';
import { inspect } from '../commands/inspect';
import { status } from '../commands/status';
import { doctor } from '../commands/doctor';
import { clean } from '../commands/clean';
import { stop } from '../commands/stop';
import { dump } from '../commands/dump';
import { baselines } from '../commands/baselines';
import { shutdown } from '../commands/shutdown';
import { reboot } from '../commands/reboot';
import { uninstall } from '../commands/uninstall';
import { configCommand } from '../commands/config';
import { mcp } from '../commands/mcp';
import { registerLlmContext } from '../lib/llm-context-register';
import {
  initTelemetry,
  trackEvent,
  shutdownTelemetry,
} from '@dokkimi/telemetry';

const USAGE = `
Usage: dokkimi <command> [options]

Commands:
  init                  Scaffold a .dokkimi/ folder with example files
  validate [path]       Validate definition files without running
  status                Show service and instance status
  doctor                Run environment pre-flight checks
  stop                  Stop the current test run
  clean                 Stop all instances and clean up resources
  run [path]            Run definition(s) headless and stream results
  inspect [path]        Inspect traffic logs from the last run
  dump [path]           Output raw JSON data dump for LLM-assisted debugging
  baselines             Review and approve pending visual baselines
  shutdown              Stop all running Dokkimi services
  reboot                Restart all Dokkimi services
  uninstall             Remove Dokkimi data, images, and namespaces
  config                View and edit Dokkimi settings
  mcp                   Start the MCP server (stdio mode, for AI tool integration)
  version               Show version

Options:
  --help, -h        Show this help message
  --version, -v     Show version

Run 'dokkimi <command> --help' for command-specific help.
`.trim();

async function main() {
  initTelemetry({ showFirstRunNotice: true, detachedFlush: true });
  registerLlmContext();

  const args = process.argv.slice(2);
  const command = args[0];

  if (
    !command ||
    command === '--help' ||
    command === '-h' ||
    command === 'help'
  ) {
    console.log(USAGE);
    process.exit(0);
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`v${DOKKIMI_VERSION}`);
    process.exit(0);
  }

  const commandArgs = args.slice(1);
  const commandStart = Date.now();

  try {
    switch (command) {
      case 'init':
        await init(commandArgs);
        break;
      case 'run':
        await run(commandArgs);
        break;
      case 'validate':
        await validate(commandArgs);
        break;
      case 'shutdown':
        await shutdown(commandArgs);
        break;
      case 'reboot':
        await reboot(commandArgs);
        break;
      case 'status':
        await status(commandArgs);
        break;
      case 'doctor':
        await doctor(commandArgs);
        break;
      case 'stop':
        await stop(commandArgs);
        break;
      case 'clean':
        await clean(commandArgs);
        break;
      case 'inspect':
        await inspect(commandArgs);
        break;
      case 'dump':
        await dump(commandArgs);
        break;
      case 'baselines':
        await baselines(commandArgs);
        break;
      case 'uninstall':
        await uninstall(commandArgs);
        break;
      case 'config':
        await configCommand(commandArgs);
        break;
      case 'mcp':
        await mcp();
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error(`Run 'dokkimi --help' for usage.`);
        process.exit(1);
    }
    trackEvent('cli_command', {
      command,
      duration_ms: Date.now() - commandStart,
    });
  } catch (err) {
    trackEvent('cli_command_error', {
      command,
      duration_ms: Date.now() - commandStart,
      error_type: err instanceof Error ? err.constructor.name : 'Unknown',
      error_message:
        err instanceof Error
          ? err.message.slice(0, 200)
          : String(err).slice(0, 200),
    });
    throw err;
  }
}

main()
  .then(() => shutdownTelemetry())
  .catch(async (err) => {
    await shutdownTelemetry();
    console.error(err);
    process.exit(1);
  });
