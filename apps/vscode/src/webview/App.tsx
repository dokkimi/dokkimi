import React, { useState, useMemo, useEffect, useCallback } from 'react';
import styled, { createGlobalStyle } from 'styled-components';
import { SearchBar } from './components/SearchBar';
import { Section } from './components/Section';
import { TestItem } from './components/TestItem';
import { FileItem } from './components/FileItem';
import { vscode } from './vscodeApi';

export interface DefinitionEntry {
  file: string;
  name: string;
  testCount: number;
  errorCount: number;
  warningCount: number;
}

export interface FileEntry {
  file: string;
  name: string;
  itemType?: string;
}

export interface WorkspaceData {
  definitions: DefinitionEntry[];
  fragments: FileEntry[];
  initFiles: FileEntry[];
  baselines: FileEntry[];
}

export type RunStatus = 'running' | 'passed' | 'failed';

const GlobalStyle = createGlobalStyle`
  body {
    margin: 0;
    padding: 0;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-sideBar-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
`;

const Container = styled.div`
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
`;

const ScrollArea = styled.div`
  flex: 1;
  overflow-y: auto;
`;

const Empty = styled.div`
  padding: 16px 12px;
  text-align: center;
  color: var(--vscode-disabledForeground);
  font-style: italic;
`;

function filterEntries<T extends { name: string }>(
  entries: T[],
  filter: string,
): T[] {
  if (!filter) {
    return entries;
  }
  const lower = filter.toLowerCase();
  return entries.filter((e) => e.name.toLowerCase().includes(lower));
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceData>({
    definitions: [],
    fragments: [],
    initFiles: [],
    baselines: [],
  });
  const [filter, setFilter] = useState('');
  const [runStatuses, setRunStatuses] = useState<Record<string, RunStatus>>({});
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'workspace') {
        setWorkspace(message.workspace);
      }
      if (message.type === 'runStatus') {
        setRunStatuses((prev) => ({ ...prev, [message.file]: message.status }));
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const filtered = useMemo(
    () => ({
      definitions: filterEntries(workspace.definitions, filter),
      fragments: filterEntries(workspace.fragments, filter),
      initFiles: filterEntries(workspace.initFiles, filter),
      baselines: filterEntries(workspace.baselines, filter),
    }),
    [workspace, filter],
  );

  const hasFilter = filter.length > 0;

  const isCollapsed = (key: string) =>
    hasFilter ? false : (collapsed[key] ?? false);

  const toggleSection = (key: string) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  const handleRunAll = useCallback(() => {
    const files = filtered.definitions.map((d) => d.file);
    if (files.length > 0) {
      vscode.postMessage({ type: 'runAll', files });
    }
  }, [filtered.definitions]);

  const anyRunning = filtered.definitions.some(
    (d) => runStatuses[d.file] === 'running',
  );

  const totalItems =
    filtered.definitions.length +
    filtered.fragments.length +
    filtered.initFiles.length +
    filtered.baselines.length;

  return (
    <>
      <GlobalStyle />
      <Container>
        <SearchBar
          value={filter}
          onChange={setFilter}
          onRunAll={handleRunAll}
          runningAll={anyRunning}
        />
        <ScrollArea>
          {totalItems === 0 && <Empty>No files found</Empty>}

          {filtered.definitions.length > 0 && (
            <Section
              title="Definitions"
              count={filtered.definitions.length}
              collapsed={isCollapsed('definitions')}
              onToggle={() => toggleSection('definitions')}
              actions={
                <Section.RunAllButton
                  disabled={anyRunning}
                  onClick={handleRunAll}
                />
              }
            >
              {filtered.definitions.map((def) => (
                <TestItem
                  key={def.file}
                  definition={def}
                  runStatus={runStatuses[def.file]}
                />
              ))}
            </Section>
          )}

          {filtered.fragments.length > 0 && (
            <Section
              title="Fragments"
              count={filtered.fragments.length}
              collapsed={isCollapsed('fragments')}
              onToggle={() => toggleSection('fragments')}
            >
              {filtered.fragments.map((entry) => (
                <FileItem key={entry.file} entry={entry} />
              ))}
            </Section>
          )}

          {filtered.initFiles.length > 0 && (
            <Section
              title="Init Files"
              count={filtered.initFiles.length}
              collapsed={isCollapsed('initFiles')}
              onToggle={() => toggleSection('initFiles')}
            >
              {filtered.initFiles.map((entry) => (
                <FileItem key={entry.file} entry={entry} />
              ))}
            </Section>
          )}

          {filtered.baselines.length > 0 && (
            <Section
              title="Baselines"
              count={filtered.baselines.length}
              collapsed={isCollapsed('baselines')}
              onToggle={() => toggleSection('baselines')}
            >
              {filtered.baselines.map((entry) => (
                <FileItem key={entry.file} entry={entry} />
              ))}
            </Section>
          )}
        </ScrollArea>
      </Container>
    </>
  );
}
