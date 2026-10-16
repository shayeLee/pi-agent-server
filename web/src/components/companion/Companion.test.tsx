import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { CompanionDock, CompanionWelcome } from './Companion.js';
import { DEFAULT_PERSONA, readPersona, type CompanionPersona } from './companion-lines.js';

function Welcome() {
  const [persona, setPersona] = useState<CompanionPersona>(DEFAULT_PERSONA);
  return <CompanionWelcome mood="idle" nodKey={0} persona={persona} onPersona={setPersona} projectId="p" projectName="repo"
    recent={null} now={() => new Date(2026, 9, 16, 9)} seed={1} />;
}

describe('companion', () => {
  afterEach(() => localStorage.clear());

  it('renames itself and changes voice from its own figure', () => {
    render(<Welcome />);
    expect(screen.getByText('小派')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /和小派打招呼/ }));
    fireEvent.click(screen.getByRole('radio', { name: '正式' }));
    expect(screen.getByText(/^早上好。请问今天在 repo/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('名字'), { target: { value: '阿派' } });
    fireEvent.click(screen.getByRole('button', { name: '好了' }));
    expect(screen.getByText('阿派')).toBeInTheDocument();
    expect(screen.queryByTestId('companion-editor')).not.toBeInTheDocument();
  });

  it('docks with its mood on hover and can be sent away and called back', () => {
    const onPersona = vi.fn();
    const { rerender } = render(<CompanionDock mood="working" nodKey={0} persona={DEFAULT_PERSONA} onPersona={onPersona} />);
    const dock = screen.getByTestId('companion-dock');
    expect(dock).toHaveAttribute('title', '小派：埋头干活中！');
    fireEvent.click(dock);
    expect(onPersona).toHaveBeenCalledWith({ ...DEFAULT_PERSONA, docked: false });
    rerender(<CompanionDock mood="working" nodKey={0} persona={{ ...DEFAULT_PERSONA, docked: false }} onPersona={onPersona} />);
    expect(screen.getByRole('button', { name: '叫回小派' })).toBeInTheDocument();
    expect(readPersona()).toEqual(DEFAULT_PERSONA);
  });
});
