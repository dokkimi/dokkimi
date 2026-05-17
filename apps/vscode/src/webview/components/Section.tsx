import React from 'react';
import styled from 'styled-components';

const Header = styled.div`
  display: flex;
  align-items: center;
  padding: 4px 12px;
  cursor: pointer;
  user-select: none;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--vscode-sideBarSectionHeader-foreground);
  background: var(--vscode-sideBarSectionHeader-background);
  border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
  position: sticky;
  top: 0;
  z-index: 1;

  &:hover {
    background: var(--vscode-list-hoverBackground);
  }
`;

const Chevron = styled.span<{ $collapsed: boolean }>`
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-right: 4px;
  transform: ${(p) => (p.$collapsed ? 'rotate(-90deg)' : 'rotate(0deg)')};
  transition: transform 0.1s ease;

  svg {
    width: 12px;
    height: 12px;
  }
`;

const Title = styled.span`
  flex: 1;
  min-width: 0;
`;

const Count = styled.span`
  flex-shrink: 0;
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 600;
  line-height: 16px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
`;

const Actions = styled.div`
  flex-shrink: 0;
  display: flex;
  align-items: center;
  margin-left: 6px;
`;

const RunAllBtn = styled.button<{ $disabled: boolean }>`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
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
    width: 12px;
    height: 12px;
  }
`;

const Body = styled.div``;

interface SectionProps {
  title: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  actions?: React.ReactNode;
  children: React.ReactNode;
}

export function Section({
  title,
  count,
  collapsed,
  onToggle,
  actions,
  children,
}: SectionProps) {
  return (
    <div>
      <Header onClick={onToggle}>
        <Chevron $collapsed={collapsed}>
          <svg viewBox="0 0 16 16" fill="currentColor">
            <path d="M2.3 5.7l5 5a1 1 0 001.4 0l5-5a1 1 0 00-1.4-1.4L8 8.58 3.7 4.3a1 1 0 00-1.4 1.42z" />
          </svg>
        </Chevron>
        <Title>{title}</Title>
        <Count>{count}</Count>
        {actions && (
          <Actions onClick={(e) => e.stopPropagation()}>{actions}</Actions>
        )}
      </Header>
      {!collapsed && <Body>{children}</Body>}
    </div>
  );
}

function SectionRunAllButton({
  disabled,
  onClick,
}: {
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <RunAllBtn
      $disabled={disabled}
      onClick={disabled ? undefined : onClick}
      title="Run all definitions"
    >
      <svg viewBox="0 0 16 16" fill="currentColor">
        <path d="M2 3.5L7 8 2 12.5V3.5z" />
        <path d="M8 3.5L13 8 8 12.5V3.5z" />
      </svg>
    </RunAllBtn>
  );
}

Section.RunAllButton = SectionRunAllButton;
