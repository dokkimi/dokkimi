export function envArrayToRecord(
  envArray: Array<{ name: string; value: string }>,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { name, value } of envArray) {
    record[name] = value;
  }
  return record;
}
