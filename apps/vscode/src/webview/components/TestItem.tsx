import React from 'react';
import styled, { keyframes } from 'styled-components';
import type { DefinitionEntry, RunStatus } from '../App';
import { vscode } from '../vscodeApi';

const spin = keyframes`
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
`;

const Actions = styled.div`
  display: none;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
`;

const Row = styled.div`
  display: flex;
  align-items: center;
  padding: 5px 12px;
  cursor: pointer;
  gap: 6px;

  &:hover {
    padding: 2px 12px;
    background: var(--vscode-list-hoverBackground);
  }

  &:hover ${Actions} {
    display: flex;
  }
`;

const IconWrapper = styled.span`
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
`;

const Spinner = styled.svg`
  animation: ${spin} 1s linear infinite;
`;

const Name = styled.div`
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: var(--vscode-font-size);
`;

const ActionButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--vscode-icon-foreground);
  cursor: pointer;

  &:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  svg {
    width: 14px;
    height: 14px;
  }
`;

interface TestItemProps {
  definition: DefinitionEntry;
  runStatus?: RunStatus;
}

function StatusIcon({ definition, runStatus }: TestItemProps) {
  if (runStatus === 'running') {
    return (
      <Spinner viewBox="0 0 16 16" width="16" height="16">
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke="var(--vscode-progressBar-background, #0078d4)"
          strokeWidth="1.5"
          strokeDasharray="24 14"
          strokeLinecap="round"
        />
      </Spinner>
    );
  }

  if (runStatus === 'passed') {
    return (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="var(--vscode-testing-iconPassed, #388a34)"
      >
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm3.35 5.35l-4 4a.5.5 0 01-.7 0l-2-2a.5.5 0 01.7-.7L7 9.29l3.65-3.64a.5.5 0 01.7.7z" />
      </svg>
    );
  }

  if (runStatus === 'failed') {
    return (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="var(--vscode-testing-iconFailed, #d73a49)"
      >
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm2.85 9.15a.5.5 0 01-.7.7L8 8.71l-2.15 2.14a.5.5 0 01-.7-.7L7.29 8 5.15 5.85a.5.5 0 01.7-.7L8 7.29l2.15-2.14a.5.5 0 01.7.7L8.71 8l2.14 2.15z" />
      </svg>
    );
  }

  if (definition.errorCount > 0) {
    return (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="var(--vscode-editorError-foreground, #f44)"
      >
        <path d="M8 1a7 7 0 100 14A7 7 0 008 1zm2.85 9.15a.5.5 0 01-.7.7L8 8.71l-2.15 2.14a.5.5 0 01-.7-.7L7.29 8 5.15 5.85a.5.5 0 01.7-.7L8 7.29l2.15-2.14a.5.5 0 01.7.7L8.71 8l2.14 2.15z" />
      </svg>
    );
  }

  if (definition.warningCount > 0) {
    return (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="var(--vscode-editorWarning-foreground, #fc0)"
      >
        <path d="M7.56 1.44a.5.5 0 01.88 0l6.5 12A.5.5 0 0114.5 14h-13a.5.5 0 01-.44-.56l6.5-12zM8 5.5a.5.5 0 00-.5.5v3a.5.5 0 001 0V6a.5.5 0 00-.5-.5zm0 5.5a.75.75 0 100 1.5.75.75 0 000-1.5z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 16 16" width="16" height="16">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--vscode-testing-iconUnset, var(--vscode-disabledForeground))"
        strokeWidth="1.5"
      />
    </svg>
  );
}

export function TestItem({ definition, runStatus }: TestItemProps) {
  const handleClick = () => {
    vscode.postMessage({ type: 'openFile', file: definition.file });
  };

  const handleOpenFile = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'openFile', file: definition.file });
  };

  const handleRun = (e: React.MouseEvent) => {
    e.stopPropagation();
    vscode.postMessage({ type: 'runFile', file: definition.file });
  };

  const isRunning = runStatus === 'running';

  return (
    <Row onClick={handleClick}>
      <IconWrapper>
        <StatusIcon definition={definition} runStatus={runStatus} />
      </IconWrapper>
      <Name>{definition.name}</Name>
      <Actions>
        <ActionButton onClick={handleOpenFile} title="Open file">
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M8.58594 1.00098C8.98394 1.00098 9.36646 1.15943 9.64746 1.44043L12.5605 4.35352C12.8415 4.63552 13.001 5.01704 13.001 5.41504V13.001C13.001 14.106 12.106 15.001 11.001 15.001H5.00098C3.89599 15.001 3.00098 14.106 3.00098 13.001V6.00098H4.00098V13.001C4.00098 13.553 4.44899 14.001 5.00098 14.001H11.001C11.553 14.001 12.001 13.553 12.001 13.001V6.00098H9.50098C8.67299 6.00096 8.00098 5.32897 8.00098 4.50098V2.00098C7.99198 1.97699 7.98265 1.9527 7.97266 1.92871C7.89674 1.74704 7.78717 1.5812 7.64746 1.44238L7.20605 1.00098H8.58594ZM9 4.5C9 4.776 9.224 5 9.5 5H11.793L9 2.20703V4.5Z"
            />
            <path d="M4.5 0C4.63299 0 4.75952 0.0534683 4.85352 0.147461L6.85352 2.14746C6.90042 2.19336 6.93789 2.24775 6.96289 2.30859C6.98789 2.36959 7.00097 2.43498 7.00098 2.50098C7.00098 2.56698 6.98789 2.63236 6.96289 2.69336C6.93789 2.75323 6.90043 2.80956 6.85352 2.85547L4.85352 4.85547C4.75956 4.94917 4.63278 5.00195 4.5 5.00195C4.36722 5.00195 4.24044 4.94917 4.14648 4.85547C4.05248 4.76147 3.99902 4.63398 3.99902 4.50098C3.99903 4.36799 4.05249 4.24146 4.14648 4.14746L5.29297 3.00098H2.5C2.10201 3.00098 1.72045 3.15944 1.43945 3.44043C1.15846 3.72242 1.00001 4.10298 1 4.50098V5.50098C1 5.63398 0.947516 5.76147 0.853516 5.85547C0.759563 5.94817 0.632774 6.00098 0.5 6.00098C0.367225 6.00098 0.240437 5.94917 0.146484 5.85547C0.0534844 5.76147 0 5.63398 0 5.50098V4.50098C6.17892e-06 3.83799 0.263427 3.20239 0.732422 2.7334C1.20142 2.26441 1.83701 2.00098 2.5 2.00098H5.29297L4.14648 0.855469C4.05248 0.761469 3.99902 0.633977 3.99902 0.500977C3.99903 0.367985 4.05249 0.241455 4.14648 0.147461C4.24048 0.0534683 4.36701 0 4.5 0Z" />
          </svg>
        </ActionButton>
        {!isRunning && (
          <ActionButton onClick={handleRun} title="Run definition">
            <svg viewBox="0 0 16 16" fill="currentColor">
              <path d="M4 2.5v11l9-5.5L4 2.5z" />
            </svg>
          </ActionButton>
        )}
      </Actions>
    </Row>
  );
}
