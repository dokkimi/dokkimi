import React from 'react';
import styled from 'styled-components';
import { TestItem } from './TestItem';
import type { DefinitionEntry, RunStatus } from '../App';

const List = styled.div`
  flex: 1;
  overflow-y: auto;
`;

const Empty = styled.div`
  padding: 8px 12px;
  text-align: center;
  color: var(--vscode-disabledForeground);
  font-style: italic;
`;

interface TestListProps {
  definitions: DefinitionEntry[];
  runStatuses: Record<string, RunStatus>;
}

export function TestList({ definitions, runStatuses }: TestListProps) {
  if (definitions.length === 0) {
    return <Empty>No definitions found</Empty>;
  }

  return (
    <List>
      {definitions.map((def) => (
        <TestItem
          key={def.file}
          definition={def}
          runStatus={runStatuses[def.file]}
        />
      ))}
    </List>
  );
}
