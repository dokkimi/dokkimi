import React, { useState, useMemo, useEffect, useCallback } from 'react';
import styled, { createGlobalStyle } from 'styled-components';
import { SearchBar } from './components/SearchBar';
import { TestList } from './components/TestList';
import { vscode } from './vscodeApi';

export interface DefinitionEntry {
  file: string;
  name: string;
  testCount: number;
  errorCount: number;
  warningCount: number;
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

export function App() {
  const [definitions, setDefinitions] = useState<DefinitionEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [runStatuses, setRunStatuses] = useState<Record<string, RunStatus>>({});

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === 'definitions') {
        setDefinitions(message.definitions);
      }
      if (message.type === 'runStatus') {
        setRunStatuses((prev) => ({ ...prev, [message.file]: message.status }));
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const filtered = useMemo(() => {
    if (!filter) {
      return definitions;
    }
    const lower = filter.toLowerCase();
    return definitions.filter((d) => d.name.toLowerCase().includes(lower));
  }, [filter, definitions]);

  const handleRunAll = useCallback(() => {
    const files = filtered.map((d) => d.file);
    if (files.length > 0) {
      vscode.postMessage({ type: 'runAll', files });
    }
  }, [filtered]);

  const anyRunning = filtered.some((d) => runStatuses[d.file] === 'running');

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
        <TestList definitions={filtered} runStatuses={runStatuses} />
      </Container>
    </>
  );
}
