export function findDokkimiBin(): string {
  return process.argv[1] ?? 'dokkimi';
}
