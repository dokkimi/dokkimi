import {
  resolveDefinitions,
  type ResolverResult,
} from '@dokkimi/definition-resolver';
import { warnIfVersionMismatch } from '../lib/version';
import { checkForUpdate } from '../lib/update-check';
import { trackEvent } from '@dokkimi/telemetry';

export async function validate(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: dokkimi validate [path]');
    console.log('');
    console.log('Validate .dokkimi/ definition files without running them.');
    console.log('');
    console.log('Arguments:');
    console.log(
      '  [path]    Path to .dokkimi/ directory or a specific definition file (.json, .yml, .yaml)',
    );
    console.log('            Defaults to .dokkimi/ in the current directory');
    process.exit(0);
  }

  checkForUpdate();

  const target = args.find((a) => !a.startsWith('-'));
  const result: ResolverResult = resolveDefinitions(target);

  warnIfVersionMismatch(result.config);

  // Print results
  console.log('');

  let totalErrors = 0;
  let totalWarnings = 0;

  for (const e of result.errors) {
    console.log(`${e.file}:`);

    for (const msg of e.errors) {
      console.log(`  \x1b[31merror\x1b[0m  ${msg}`);
      totalErrors++;
    }
    for (const msg of e.warnings) {
      console.log(`  \x1b[33mwarn\x1b[0m   ${msg}`);
      totalWarnings++;
    }
    console.log('');
  }

  const defCount = result.definitions.length;
  const errFileCount = result.errors.filter((e) => e.errors.length > 0).length;

  console.log(
    `Resolved ${defCount} definition${defCount === 1 ? '' : 's'}` +
      (errFileCount > 0
        ? `, ${errFileCount} file${errFileCount === 1 ? '' : 's'} with errors`
        : ''),
  );

  if (totalErrors === 0 && totalWarnings === 0) {
    console.log('\x1b[32mAll files valid.\x1b[0m');
  } else if (totalErrors === 0) {
    console.log(
      `\x1b[32mNo errors.\x1b[0m ${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}.`,
    );
  } else {
    console.log(
      `\x1b[31m${totalErrors} error${totalErrors === 1 ? '' : 's'}\x1b[0m, ${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}.`,
    );
  }

  console.log('');

  trackEvent('cli_validate_result', {
    definition_count: defCount,
    error_count: totalErrors,
    warning_count: totalWarnings,
  });

  if (totalErrors > 0) {
    process.exit(1);
  }
}
