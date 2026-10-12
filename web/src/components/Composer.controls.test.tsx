import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SessionRecord } from 'pi-agent-server/client';
import { Composer, type ComposerProps } from './Composer.js';
import type { SubmissionState } from '../attachment-state.js';
import { Modal } from './Modal.js';
const base = (): ComposerProps => ({ session: {id:'s'} as SessionRecord, projects:[], activeProjectId:null, onSelectProject:vi.fn(), canCreateSession:false, models:[], thinkingLevels:[], defaultModel:null, defaultThinkingLevel:'off', streaming:true, queued:false, placeholder:'task', onSend:vi.fn(), onFollowUp:vi.fn(), onConfigChange:vi.fn(), draft:{text:'draft',attachments:[],settings:{}}, onDraftText:vi.fn() });
describe('runtime composer dispatcher', () => {
  it('uses followUp for click and Enter without mode buttons, preserves controlled draft across scopes', async () => {
    const props = base(); const view = render(<Composer {...props} draftScope="a" />);
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(props.onFollowUp).toHaveBeenCalledWith('draft'));
    await waitFor(() => expect(screen.getByTestId('send-button')).toBeEnabled());
    fireEvent.keyDown(screen.getByTestId('composer-input'),{key:'Enter'});
    await waitFor(() => expect(props.onFollowUp).toHaveBeenCalledTimes(2));
    expect(props.onSend).not.toHaveBeenCalled();
    expect(screen.queryByRole('group',{name:'运行时发送模式'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'完成后追加'})).not.toBeInTheDocument();
    expect(props.onDraftText).not.toHaveBeenCalled();
    view.rerender(<Composer {...props} draftScope="b" />);
    expect(screen.getByTestId('composer-input')).toHaveValue('draft');
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(props.onFollowUp).toHaveBeenCalledTimes(3));
  });
  it.each([true, false])('idle/new session starts primary (existing=%s)', async existing => {
    const props = { ...base(), session: existing ? base().session : null, streaming: false, canCreateSession: true };
    render(<Composer {...props} />);
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    await waitFor(() => expect(props.onSend).toHaveBeenCalledWith('draft'));
    expect(props.onFollowUp).not.toHaveBeenCalled();
  });
  it.each([{primaryAwaitingStart:true},{canWrite:false},{historyLoading:true},{queued:true},{controlsBlocked:true},{submission:{phase:'unknown'} as SubmissionState},{submission:{phase:'submitting'} as SubmissionState},{pendingControls:[{id:'p',kind:'steer' as const,text:'x',status:'unknown' as const}]}])('gates every submission entry %j', overrides => {
    const props = {...base(), ...overrides}; render(<Composer {...props} />);
    expect(screen.getByTestId('send-button')).toBeDisabled();
    fireEvent.click(screen.getByTestId('send-button'));
    fireEvent.keyDown(screen.getByTestId('composer-input'),{key:'Enter'});
    expect(props.onFollowUp).not.toHaveBeenCalled(); expect(props.onSend).not.toHaveBeenCalled();
  });
  it.each(['creating', 'configuring', 'submitting', 'unknown'] as const)('protects primary %s even if agent started', phase => {
    render(<Composer {...base()} submission={{phase, stage:'send'} as SubmissionState} />);
    expect(screen.queryByRole('group', {name:'运行时发送模式'})).not.toBeInTheDocument();
    expect(screen.queryByTestId('abort-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('send-button')).toBeDisabled();
    expect(screen.getByTestId('composer-input')).toHaveValue('draft');
  });
  it('does not treat a server queued request as a running control target', () => {
    render(<Composer {...base()} queued />);
    expect(screen.queryByRole('group', {name:'运行时发送模式'})).not.toBeInTheDocument();
    expect(screen.queryByTestId('abort-button')).not.toBeInTheDocument();
  });
  it.each([false, true])('keeps old unknown notice readable without blocking a new submission (streaming=%s)', async streaming => {
    const props = { ...base(), streaming, pendingControls: [{ id: 'old', kind: 'followUp' as const, text: 'unconfirmed draft', status: 'unknown' as const, blocking: false }] };
    render(<Composer {...props} />);
    expect(screen.getByTestId('composer-pending-controls')).toHaveTextContent('状态未知');
    expect(screen.getByTestId('composer-input')).toHaveValue('draft');
    expect(screen.getByTestId('send-button')).toBeEnabled();
    fireEvent.click(screen.getByTestId('send-button'));
    await waitFor(() => expect(streaming ? props.onFollowUp : props.onSend).toHaveBeenCalledWith('draft'));
    expect(screen.getByTestId('composer-pending-controls')).toHaveTextContent('unconfirmed draft');
  });
  it('protects ShiftEnter and IME; empty running input has no stop or control row', () => {
    const props = base(); render(<Composer {...props} draft={{text:'',attachments:[],settings:{}}} />);
    fireEvent.keyDown(screen.getByTestId('composer-input'),{key:'Enter',shiftKey:true});
    fireEvent.keyDown(screen.getByTestId('composer-input'),{key:'Enter',keyCode:229});
    fireEvent.keyDown(screen.getByTestId('composer-input'),{key:'Enter',isComposing:true});
    expect(props.onFollowUp).not.toHaveBeenCalled();
    expect(screen.getByTestId('send-button')).toBeDisabled();
    expect(screen.queryByRole('button', {name: /中止|停止/})).not.toBeInTheDocument();
    expect(document.querySelector('.composer-runtime-controls')).toBeNull();
  });
  it('allows image-only followUp, explains unsupported file attachments', async () => {
    const props = base(); const image = {localId:'img',name:'image.png',size:10,kind:'image' as const,mediaType:'image/png',status:'ready' as const};
    const view = render(<Composer {...props} draft={{text:'',settings:{},attachments:[image]}} />);
    expect(screen.getByTestId('send-button')).toBeEnabled();
    fireEvent.click(screen.getByTestId('send-button')); await waitFor(() => expect(props.onFollowUp).toHaveBeenCalledWith(''));
    view.rerender(<Composer {...props} draft={{text:'draft',settings:{},attachments:[{...image,kind:'text'}]}} />);
    expect(screen.getByTestId('send-button')).toBeDisabled(); expect(screen.getByText(/追加仅支持文字和图片/)).toBeVisible();
  });
});

describe('runtime abort controls', () => {
  it('ignores the closed native Modal mounted by the app', () => {
    const props = { ...base(), onAbort: vi.fn() };
    render(<><Composer {...props} /><Modal open={false} onClose={() => {}} title="隐藏对话框">内容</Modal></>);
    expect(document.querySelector('dialog[role="dialog"]')).not.toHaveAttribute('open');
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Escape' });
    expect(props.onAbort).toHaveBeenCalledOnce();
  });
  it('ignores a custom overlay inside a hidden ancestor', () => {
    const props = { ...base(), onAbort: vi.fn() };
    render(<><Composer {...props} /><div style={{display:'none'}}><div role="dialog" /></div></>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onAbort).toHaveBeenCalledOnce();
  });
  it('stops by button and Escape while preserving the draft and Enter followUp', async () => {
    const props = { ...base(), onAbort: vi.fn() };
    const view = render(<Composer {...props} />);
    expect(screen.queryByTestId('send-button')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('abort-button'));
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Escape' });
    expect(props.onAbort).toHaveBeenCalledTimes(2);
    expect(props.onDraftText).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByTestId('composer-input'), { key: 'Enter' });
    await waitFor(() => expect(props.onFollowUp).toHaveBeenCalledWith('draft'));
    view.rerender(<Composer {...props} streaming={false} />);
    expect(screen.getByTestId('send-button')).toBeEnabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onAbort).toHaveBeenCalledTimes(2);
  });
  it('allows stopping with empty input and blocked pending controls', () => {
    const props = { ...base(), onAbort: vi.fn(), controlsBlocked: true, draft: { text: '', attachments: [], settings: {} } };
    render(<Composer {...props} />);
    expect(screen.getByTestId('abort-button')).toBeEnabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onAbort).toHaveBeenCalledOnce();
  });
  it.each([{ queued: true }, { canWrite: false }, { historyLoading: true }, { session: null }])('does not abort unavailable targets %j', overrides => {
    const props = { ...base(), onAbort: vi.fn(), ...overrides };
    render(<Composer {...props} />);
    expect(screen.queryByTestId('abort-button')).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(props.onAbort).not.toHaveBeenCalled();
  });
  it('leaves Escape to dialogs and ignores IME and repeated keydowns', () => {
    const props = { ...base(), onAbort: vi.fn() };
    const view = render(<><Composer {...props} /><div role="dialog" /></>);
    fireEvent.keyDown(document, { key: 'Escape' });
    view.rerender(<Composer {...props} />);
    fireEvent.keyDown(document, { key: 'Escape', isComposing: true });
    fireEvent.keyDown(document, { key: 'Escape', repeat: true });
    expect(props.onAbort).not.toHaveBeenCalled();
  });
});
