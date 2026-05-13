import React from 'react';
import styled from 'styled-components';

const Wrapper = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-bottom: 1px solid
    var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
`;

const Input = styled.input`
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 3px 8px;
  border: 1px solid var(--vscode-input-border, transparent);
  border-radius: 2px;
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  outline: none;

  &::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }

  &:focus {
    border-color: var(--vscode-focusBorder);
  }
`;

const RunAllButton = styled.button<{ $disabled: boolean }>`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-icon-foreground);
  cursor: ${(p) => (p.$disabled ? 'default' : 'pointer')};
  opacity: ${(p) => (p.$disabled ? 0.4 : 1)};

  &:hover {
    background: ${(p) =>
      p.$disabled ? 'transparent' : 'var(--vscode-toolbar-hoverBackground)'};
  }

  svg {
    width: 16px;
    height: 16px;
  }
`;

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  onRunAll: () => void;
  runningAll: boolean;
}

export function SearchBar({
  value,
  onChange,
  onRunAll,
  runningAll,
}: SearchBarProps) {
  return (
    <Wrapper>
      <Input
        type="text"
        placeholder="Filter definitions..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <RunAllButton
        $disabled={runningAll}
        onClick={runningAll ? undefined : onRunAll}
        title="Run all visible definitions"
      >
        <svg viewBox="0 0 16 16" fill="currentColor">
          <path d="M2 3.5L7 8 2 12.5V3.5z" />
          <path d="M8 3.5L13 8 8 12.5V3.5z" />
        </svg>
      </RunAllButton>
    </Wrapper>
  );
}
