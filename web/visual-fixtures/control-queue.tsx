import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Composer } from '../src/components/Composer';
import { ControlQueue, type ControlQueueItem } from '../src/components/ControlQueue';
import '../src/styles.css';
import type { SessionRecord } from 'pi-agent-server/client';
const session = { id: 'isolated', title: '隔离队列交互样例', modelId: null, modelProvider: null, thinkingLevel: 'off' } as SessionRecord;
function Fixture() {
  const [items, setItems] = useState<ControlQueueItem[]>([]);
  const [text, setText] = useState('');
  const [theme, setTheme] = useState('light');
  const [operations, setOperations] = useState({});
  const refresh = () => fetch('/v1/sessions/isolated/control-queue').then(r => r.json()).then(v => setItems(v.items));
  useEffect(() => { void refresh(); }, []);
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const mutate = async (id: string, promote = false) => {
    setOperations({ [id]: { status: 'pending' } });
    const r = await fetch(`/v1/sessions/isolated/control-queue/${id}${promote ? '/promote' : ''}`, { method: promote ? 'POST' : 'DELETE' });
    if (r.status === 409) await refresh();
    else setItems((await r.json()).items);
    setOperations({});
  };
  const send = async (kind: string, value: string) => {
    await fetch(`/v1/sessions/isolated/${kind}`, { method: 'POST', body: JSON.stringify({ text: value }) });
    await refresh();
    setText('');
    return true;
  };
  return <main data-theme={theme} style={{height:'100dvh', display:'flex', flexDirection:'column', background:'var(--bg-page)', color:'var(--text-primary)'}}>
    <header style={{padding:16, borderBottom:'1px solid var(--line)', display:'flex', justifyContent:'space-between'}}><strong>隔离队列交互样例</strong><button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>切换主题</button></header>
    <div style={{flex:1, minHeight:0, overflow:'auto', padding:24}}><p>真实组件 · mock API · 不访问实际会话</p><p>检查排队、删除与引导操作。</p></div>
    <footer className="chat-footer"><ControlQueue items={items} operations={operations} onDelete={id => void mutate(id)} onPromote={id => void mutate(id, true)} onRefresh={() => void refresh()} />
      <Composer session={session} projects={[]} activeProjectId={null} onSelectProject={() => {}} canCreateSession={false} models={[]} thinkingLevels={[]} defaultModel={null} defaultThinkingLevel="off" streaming={true} queued={false} placeholder="描述任务…" draft={{text, attachments:[], settings:{}}} onDraftText={setText} onSend={value => send('messages', value)} onFollowUp={value => send('follow-ups', value)} onConfigChange={() => {}} />
    </footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
