import {
  DeployableDefinition,
  DefinitionItem,
  DefinitionInitFile,
} from '../namespace-lifecycle/deployment-context.types';
import { DefinitionDto } from './dto/submit-instance.dto';

export function stripInitFileContent(
  definition: DefinitionDto,
): Record<string, unknown> {
  return {
    ...definition,
    items: definition.items.map((item) => ({
      ...item,
      initFiles: item.initFiles?.map((f) => ({ filename: f.filename })),
    })),
  };
}

export function toDeployableDefinition(
  definition: DefinitionDto,
): DeployableDefinition {
  const items: DefinitionItem[] = definition.items.map((item) => {
    const initFiles: DefinitionInitFile[] | undefined = item.initFiles?.map(
      (f) => ({
        filename: f.filename,
        content: Buffer.from(f.content, 'base64'),
      }),
    );

    return {
      ...item,
      initFiles: initFiles?.length ? initFiles : undefined,
    } as DefinitionItem;
  });

  return {
    name: definition.name,
    description: definition.description,
    items,
    tests: definition.tests as DeployableDefinition['tests'],
    variables: definition.variables,
    config: definition.config as DeployableDefinition['config'],
  };
}

export function rawDefinitionToDeployable(
  raw: Record<string, unknown>,
): DeployableDefinition {
  const items = (raw.items as Record<string, unknown>[]).map((item) => {
    const rawInitFiles = item.initFiles as { filename: string }[] | undefined;
    return {
      ...item,
      initFiles: rawInitFiles?.length
        ? rawInitFiles.map((f) => ({
            filename: f.filename,
            content: Buffer.alloc(0),
          }))
        : undefined,
    } as unknown as DefinitionItem;
  });

  return {
    name: raw.name as string,
    description: raw.description as string | undefined,
    items,
    tests: raw.tests as DeployableDefinition['tests'],
    variables: raw.variables as Record<string, string> | undefined,
    config: raw.config as DeployableDefinition['config'],
  };
}
