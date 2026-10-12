import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Inspector } from '../src/components/Inspector.js';
import type { SessionRecord } from 'pi-agent-server/client';
import type { SessionStep } from '../../src/shared/session-steps.js';
import '../src/styles.css';
const rows: SessionStep[] = [
 {id:'u',kind:'user',content:'怎么突然有个会话 404？',timestamp:'2026-06-01T10:24:01Z'},
 {id:'t',kind:'thinking',content:'我会检查会话记录与权限边界，先读取已保存的历史，不调用真实模型。',timestamp:'2026-06-01T10:24:02Z'},
 {id:'c',kind:'tool_call',toolName:'subagent',content:{task:'检查会话记录与权限边界',mode:'lite'},timestamp:'2026-06-01T10:24:03Z'},
 {id:'r',kind:'tool_result',toolName:'subagent',content:'已检查模拟会话。\n'+'这是完整结果，展开后保留所有内容。\n'.repeat(8)+'END_OF_RESULT',timestamp:'2026-06-01T10:24:10Z'},
 {id:'c2',kind:'tool_call',toolName:'bash',content:{command:'git status --short'},timestamp:'2026-06-01T10:24:31Z'},
 {id:'r2',kind:'tool_result',toolName:'bash',content:{exitCode:0,output:''},timestamp:'2026-06-01T10:24:32Z'},
 {id:'a',kind:'assistant_text',content:'检查完成，以上仅为隔离的视觉测试数据。'},
].map(row => ({...row,source:'recorded',status:'completed'} as SessionStep));
document.documentElement.dataset.theme = new URLSearchParams(location.search).get('theme') ?? 'light';
function Fixture() {
 const [open, setOpen] = useState(true);
 // Large header-only stress cases use real snapshot array lengths, with the
 // prompt panel selected so no thousands of step DOM rows are mounted.
 const count = Number(new URLSearchParams(location.search).get('headerCount'));
 const headerOnly = new URLSearchParams(location.search).has('headerCount');
 const headerRows = headerOnly ? Array.from({ length: count }, (_, i) => ({ ...rows[0], id: `header-${i}` })) : rows;
 // Layout-only sparse array: exercises real index+1 rendering at selected
 // positions without mounting 99999 rows. Not a product snapshot/count fixture.
 const numberMax = Number(new URLSearchParams(location.search).get('numberMax'));
 const numberRows: SessionStep[] = [];
 if (numberMax) for (const n of [1, 99, 999, 1000, 1447, 99999, numberMax].filter(n => n <= numberMax)) {
   numberRows[n - 1] = { ...rows[(n - 1) % rows.length], id: `number-${n}` };
 }
 return <div className={`app-shell${open ? '' : ' details-collapsed'}`} style={{'--layout-inspector-width': open ? '380px' : '0px'} as React.CSSProperties}><main className="chat" style={{padding:32, gridColumn:2}}> Inspector · 隔离组件预览<button onClick={() => setOpen(true)}>打开审查器</button></main>{open && <><Inspector activeTab={headerOnly ? 'systemPrompt' : undefined} session={{id:'fixture'} as SessionRecord} entries={[]} onClearEvents={() => {}} onClose={() => setOpen(false)} steps={{sessionId:'fixture',projectionId:'p',revision:1,steps:numberMax ? numberRows : headerRows}} systemPrompt={{source:'creation_snapshot',prompt:'你是一个编码助手。\n此内容是创建时快照，不是实时运行值。'}} /></>}</div>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
