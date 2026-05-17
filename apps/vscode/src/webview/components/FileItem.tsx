import React from 'react';
import styled from 'styled-components';
import type { FileEntry } from '../App';
import { vscode } from '../vscodeApi';

const Row = styled.div`
  display: flex;
  align-items: center;
  padding: 5px 12px;
  cursor: pointer;
  gap: 6px;

  &:hover {
    background: var(--vscode-list-hoverBackground);
  }
`;

const Icon = styled.span`
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
`;

const Name = styled.div`
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--vscode-font-size);
`;

const Badge = styled.span`
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 3px;
  font-size: 10px;
  line-height: 16px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  opacity: 0.7;
`;

const ITEM_TYPE_CODICONS: Record<string, string> = {
  SERVICE: 'codicon-server-process',
  DATABASE: 'codicon-database',
  MOCK: 'codicon-plug',
};

const EXT_CODICONS: Record<string, string> = {
  sql: 'codicon-database',
  js: 'codicon-file-code',
  png: 'codicon-file-media',
};

function fileIconClass(entry: FileEntry): string {
  const ext = entry.file.split('.').pop()?.toLowerCase() ?? '';

  if (EXT_CODICONS[ext]) {
    return EXT_CODICONS[ext];
  }

  if (entry.itemType && ITEM_TYPE_CODICONS[entry.itemType]) {
    return ITEM_TYPE_CODICONS[entry.itemType];
  }

  return 'codicon-symbol-snippet';
}

interface FileItemProps {
  entry: FileEntry;
}

export function FileItem({ entry }: FileItemProps) {
  const handleClick = () => {
    vscode.postMessage({ type: 'openFile', file: entry.file });
  };

  return (
    <Row onClick={handleClick}>
      <Icon className={`codicon ${fileIconClass(entry)}`} />
      <Name>{entry.name}</Name>
      {entry.itemType && <Badge>{entry.itemType}</Badge>}
    </Row>
  );
}
