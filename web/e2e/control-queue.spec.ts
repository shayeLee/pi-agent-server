import { test, expect } from '@playwright/test';
import { workspaceFixture } from './workspace.fixture';

test('isolated queue visual matrix and pointer/keyboard interactions', async ({ page }, info) => {
  let items = Array.from({ length: 14 }, (_, i) => ({ id: `q${i}`, kind: i % 3 ? 'followUp' : 'steer', text: i === 0 ? '顺便检查一下错误上报的日志。'.repeat(18) : `完成后帮我更新一下文档 ${i}` }));
  const calls: string[] = [];
  await page.route('**/v1/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    calls.push(`${method} ${url.pathname}`);
    const match = url.pathname.match(/control-queue\/(q\d+)(\/promote)?$/);
    if (match) items = match[2] ? items.map(item => item.id === match[1] ? {...item, kind:'steer'} : item) : items.filter(item => item.id !== match[1]);
    if (url.pathname.endsWith('/steer') || url.pathname.endsWith('/follow-ups')) {
      const { text } = route.request().postDataJSON();
      items.push({ id: `q${100 + calls.length}`, kind: url.pathname.endsWith('/steer') ? 'steer' : 'followUp', text });
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ requestId:'run', revision:calls.length, items }) });
  });
  await page.goto('/visual-fixtures/control-queue.html');
  await expect(page.getByTestId('control-queue-item')).toHaveCount(14);
  for (const viewport of [{width:1440,height:1000}, {width:390,height:844}, {width:740,height:420}, {width:390,height:420}]) {
    await page.setViewportSize(viewport);
    for (const theme of ['light','dark']) {
      if ((await page.locator('html').getAttribute('data-theme')) !== theme) await page.getByRole('button', {name:'切换主题'}).click();
      await expect(page.getByTestId('abort-button')).toHaveCount(0);
      await expect(page.locator('.composer-runtime-controls')).toHaveCount(0);
      await expect(page.getByTestId('send-button')).toBeInViewport();
      await expect(page.getByTestId('composer-input')).toBeInViewport();
      const sendBox = await page.getByTestId('send-button').boundingBox();
      expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({animations:'disabled',path:info.outputPath(`queue-${viewport.width}x${viewport.height}-${theme}.png`)});
    }
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button', {name:'删除：完成后帮我更新一下文档 1', exact:true}).click();
  await expect(page.getByTestId('control-queue-item')).toHaveCount(13);
  await page.getByRole('button', {name:'引导：完成后帮我更新一下文档 2', exact:true}).click();
  await expect(page.getByRole('region', {name:'引导队列'})).toContainText('完成后帮我更新一下文档 2');
  await page.getByTestId('composer-input').fill('键盘追加');
  await page.getByTestId('composer-input').press('Shift+Enter');
  expect(calls.some(call => call.endsWith('/steer'))).toBe(false);
  await page.getByTestId('composer-input').press('Enter');
  await expect.poll(() => calls.filter(call => call.endsWith('/follow-ups')).length).toBe(1);
  await expect(page.getByRole('group', {name:'运行时发送模式'})).toHaveCount(0);
  await expect(page.getByRole('button', {name:'完成后追加', exact:true})).toHaveCount(0);
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  await expect(page.getByTestId('send-button')).toBeDisabled();
  await page.getByTestId('composer-input').fill('点击追加');
  await page.getByTestId('send-button').click();
  await expect.poll(() => calls.filter(call => call.endsWith('/follow-ups')).length).toBe(2);
  expect(calls.filter(call => call.endsWith('/steer'))).toHaveLength(0);
  await page.getByTestId('composer-input').fill('');
  await expect(page.getByTestId('send-button')).toBeDisabled();
  await expect(page.getByTestId('abort-button')).toHaveCount(0);
  expect(calls.some(call => call.endsWith('/abort'))).toBe(false);
  items = [];
  await page.reload();
  await expect(page.getByTestId('control-queue-item')).toHaveCount(0);
  await expect(page.getByTestId('control-queue')).toHaveCount(0);
  await expect(page.getByText('正在同步队列…',{exact:true})).toHaveCount(0);
  await page.screenshot({path:info.outputPath('queue-empty.png')});
});

for (const admissionMode of ['accepted', 'queued', 'sse-queued', 'sse-first'] as const)
for (const editDuringAdmission of [false, true]) test(`new session slow admission preserves snapshot ownership (${admissionMode}, edited=${editDuringAdmission})`, async ({ page }, info) => {
  const unexpected = await workspaceFixture(page);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      if (!String(args[0]).includes('/events')) return original(...args);
      let sequence = 0;
      return new Response(new ReadableStream({ start(controller) {
        (window as any).__admissionEmit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`id: ${++sequence}\ndata: ${JSON.stringify(event)}\n\n`));
      } }), {headers:{'Content-Type':'text/event-stream'}});
    };
  });
  let admit!: () => void;
  const admission = new Promise<void>(resolve => { admit = resolve; });
  let queueReady!: () => void;
  const queueWait = new Promise<void>(resolve => { queueReady = resolve; });
  let requestId = '';
  const posts: string[] = [];
  const created = {id:'slow-new',projectId:'fixture-project',title:'慢准入隔离样例',createdAt:Date.now(),updatedAt:Date.now(),modelProvider:null,modelId:null,thinkingLevel:null,systemPrompt:null};
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (value: unknown) => route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
    if (method === 'POST') {
      posts.push(path);
      if (path === '/v1/sessions') return json(created);
      if (path.endsWith('/messages')) {
        requestId = route.request().postDataJSON().requestId;
        await admission;
        return route.fulfill({status:202,contentType:'application/json',body:JSON.stringify({status:admissionMode === 'accepted' || admissionMode === 'sse-queued' ? 'accepted' : 'queued',requestId})});
      }
    }
    if (path === '/v1/sessions/slow-new/control-queue') {
      await queueWait;
      return json({requestId:null,revision:1,items:[]});
    }
    return route.fallback();
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/');
  await page.getByTestId('new-session').click();
  const input = page.getByTestId('composer-input');
  await input.fill('Hi');
  await page.getByTestId('send-button').click();
  await expect.poll(() => posts.filter(path => path.endsWith('/messages')).length).toBe(1);
  await expect(input).toHaveValue('Hi');
  await expect(page.getByTestId('primary-submission-status')).toHaveCount(0);
  await expect(page.getByTestId('phase-queued')).toHaveCount(0);
  await expect(page.getByRole('group',{name:'运行时发送模式'})).toHaveCount(0);
  await expect(page.getByText('正在同步队列…',{exact:true})).toHaveCount(0);
  await expect(page.getByTestId('abort-button')).toHaveCount(0);
  await expect(page.getByTestId('send-button')).toBeDisabled();
  await input.press('Enter');
  expect(posts.filter(path => /messages|steer|follow-ups/.test(path))).toEqual(['/v1/sessions/slow-new/messages']);
  await page.screenshot({path:info.outputPath('new-primary-submitting.png')});
  if (editDuringAdmission) await input.fill('准入期间的新草稿');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__admissionEmit)).toBe('function');
  if (admissionMode === 'sse-queued') {
    await page.evaluate(id => (window as any).__admissionEmit({type:'queued',requestId:id}), requestId);
    await expect(page.getByTestId('phase-queued')).toContainText('消息正在排队');
    await expect(page.getByTestId('send-button')).toBeDisabled();
  }
  if (admissionMode === 'sse-first') {
    await page.evaluate(id => (window as any).__admissionEmit({type:'status',phase:'agent_start',requestId:id}), requestId);
    await expect(page.getByTestId('abort-button')).toBeVisible();
    await expect(input).toHaveValue(editDuringAdmission ? '准入期间的新草稿' : 'Hi');
    await input.press('Enter');
    expect(posts.filter(path => /messages|steer|follow-ups/.test(path))).toEqual(['/v1/sessions/slow-new/messages']);
    await page.screenshot({path:info.outputPath('new-primary-sse-before-http.png')});
  }
  admit();
  await expect(page.getByTestId('primary-submission-status')).toHaveCount(0);
  await expect(input).toHaveValue(editDuringAdmission ? '准入期间的新草稿' : '');
  if (admissionMode === 'queued' || admissionMode === 'sse-queued') await expect(page.getByTestId('phase-queued')).toContainText('消息正在排队');
  else await expect(page.getByTestId('phase-queued')).toHaveCount(0);
  await expect(page.getByRole('group',{name:'运行时发送模式'})).toHaveCount(0);
  await page.screenshot({path:info.outputPath(`new-primary-${admissionMode}.png`)});
  const queuedViewport = await page.getByTestId('chat-body').evaluate(el => el.clientHeight);
  if (!editDuringAdmission) await input.fill('准入后的新草稿');
  if (admissionMode !== 'sse-first') {
    await expect(page.getByTestId('send-button')).toBeDisabled();
    await input.press('Enter');
    expect(posts.filter(path => /messages|steer|follow-ups/.test(path))).toEqual(['/v1/sessions/slow-new/messages']);
  }
  queueReady();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__admissionEmit)).toBe('function');
  await page.evaluate(id => (window as any).__admissionEmit({type:'status',phase:'agent_start',requestId:id}), requestId);
  await expect(page.getByRole('group',{name:'运行时发送模式'})).toHaveCount(0);
  await expect(page.getByTestId('abort-button')).toBeVisible();
  await expect(page.locator('.composer-runtime-controls')).toHaveCount(0);
  await expect(page.getByTestId('control-queue')).toHaveCount(0);
  await expect(page.getByText('正在同步队列…',{exact:true})).toHaveCount(0);
  await expect(input).toHaveValue(editDuringAdmission ? '准入期间的新草稿' : '准入后的新草稿');
  await expect(page.getByTestId('abort-button')).toBeVisible();
  expect(await page.getByTestId('chat-body').evaluate(el => el.clientHeight)).toBe(queuedViewport);
  for (const viewport of [{width:1440,height:1000},{width:390,height:844},{width:740,height:420}]) {
    await page.setViewportSize(viewport);
    await expect(page.getByTestId('composer-input')).toBeInViewport();
    await expect(page.getByTestId('abort-button')).toBeInViewport();
    await page.screenshot({animations:'disabled',path:info.outputPath(`new-running-${viewport.width}.png`)});
  }
  expect(unexpected).toEqual([]);
});

test('full App uses authoritative queue, CRUD identity, drain removal and accepted draft clearing', async ({ page }, info) => {
  const unexpected = await workspaceFixture(page);
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      if (!String(args[0]).includes('/events')) return original(...args);
      let sequence = 0;
      const stream = new ReadableStream({ start(controller) {
        (window as any).__queueEmit = (event: unknown) => controller.enqueue(new TextEncoder().encode(`id: ${++sequence}\ndata: ${JSON.stringify(event)}\n\n`));
        (window as any).__queueEmit({type:'status',phase:'agent_start',requestId:'run'});
      } });
      return new Response(stream, {headers:{'Content-Type':'text/event-stream'}});
    };
  });
  let revision = 1;
  let items = [
    {id:'steer-one',kind:'steer',text:'顺便检查一下错误上报的日志',hasImages:false,status:'queued',acknowledgementId:'ack-s'},
    {id:'follow-one',kind:'followUp',text:'完成后帮我更新一下文档',hasImages:false,status:'queued',acknowledgementId:'ack-f'},
  ];
  const snapshot = () => ({requestId:'run',revision,items});
  const admissions: any[] = [];
  const mutations: any[] = [];
  let mutationFailure = 0;
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const method = route.request().method();
    const json = (value: unknown, status = 200) => route.fulfill({status,contentType:'application/json',body:JSON.stringify(value)});
    if (path.endsWith('/control-queue') && method === 'GET') return json(snapshot());
    if (path.includes('/control-queue/')) {
      const id = path.split('/control-queue/')[1]!.split('/')[0];
      mutations.push(route.request().postDataJSON());
      if (mutationFailure) {
        const status = mutationFailure; mutationFailure = 0;
        if (status === 409) { items = items.filter(item => item.id !== id); revision++; }
        return json({error: status === 409 ? 'already consumed' : 'uncertain result'}, status);
      }
      items = path.endsWith('/promote') ? items.map(item => item.id === id ? {...item,kind:'steer'} : item) : items.filter(item => item.id !== id);
      revision++; return json(snapshot());
    }
    if (path.endsWith('/steer') || path.endsWith('/follow-ups')) {
      const body = route.request().postDataJSON(); admissions.push(body);
      items.push({id:body.controlId,kind:path.endsWith('/steer')?'steer':'followUp',text:body.text,hasImages:false,status:'queued',acknowledgementId:body.acknowledgementId});
      revision++; return route.fulfill({status:202,body:''});
    }
    return route.fallback();
  });
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/');
  await page.getByTestId('session-fixture-0').click();
  await expect(page.getByTestId('control-queue-item')).toHaveCount(2);
  await expect(page.getByTestId('abort-button')).toBeVisible();
  await expect(page.locator('.composer-runtime-controls')).toHaveCount(0);
  await page.screenshot({path:info.outputPath('app-reference-desktop-light.png')});
  await page.getByTestId('theme-toggle').click();
  await page.getByRole('menuitemradio', { name: '深色', exact: true }).click();
  await page.screenshot({path:info.outputPath('app-reference-desktop-dark.png')});
  await page.setViewportSize({width:390,height:844});
  await page.waitForTimeout(250); // finish responsive drawer/layout transition before visual capture
  await expect(page.getByTestId('abort-button')).toBeVisible();
  await expect(page.getByTestId('abort-button')).toBeInViewport({ ratio: 1 });
  await page.screenshot({animations:'disabled',path:info.outputPath('app-reference-mobile-dark.png')});
  await page.getByRole('button',{name:'打开工作区导航'}).click();
  await page.getByTestId('theme-toggle').click();
  await page.getByRole('menuitemradio', { name: '浅色', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  await page.screenshot({animations:'disabled',path:info.outputPath('app-reference-mobile-light.png')});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'引导：完成后帮我更新一下文档',exact:true}).click();
  await expect(page.getByRole('region',{name:'追加队列'})).toHaveCount(0);
  expect(mutations[0]).toMatchObject({requestId:'run',acknowledgementId:'ack-f'});
  await page.getByRole('button',{name:'删除：顺便检查一下错误上报的日志',exact:true}).click();
  await expect(page.getByTestId('control-queue-item')).toHaveCount(1);
  expect(mutations[1]).toMatchObject({requestId:'run',acknowledgementId:'ack-s'});
  // SDK dequeue is independent from steering_consumed: remove the row immediately.
  items = []; revision++;
  await page.evaluate(value => (window as any).__queueEmit({type:'control_queue',...value}), snapshot());
  await expect(page.getByTestId('control-queue-item')).toHaveCount(0);
  await expect(page.getByTestId('control-queue')).toHaveCount(0);
  await expect(page.getByRole('group',{name:'运行时发送模式'})).toHaveCount(0);
  await page.getByTestId('composer-input').fill('准入后清除追加草稿');
  // While running, Enter queues a follow-up; the primary button is the stop button.
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  await expect(page.getByTestId('control-queue-item')).toHaveCount(1);
  expect(admissions[0]).toMatchObject({text:'准入后清除追加草稿',requestId:'run'});
  expect(items[0].kind).toBe('followUp');
  await expect(page.getByRole('region',{name:'追加队列'})).toContainText('准入后清除追加草稿');
  await page.screenshot({path:info.outputPath('app-default-followUp.png')});
  await page.getByRole('button',{name:'引导：准入后清除追加草稿',exact:true}).click();
  await expect(page.getByRole('region',{name:'追加队列'})).toHaveCount(0);
  await expect(page.getByRole('region',{name:'引导队列'})).toContainText('准入后清除追加草稿');
  await page.screenshot({path:info.outputPath('app-default-promoted.png')});
  await page.evaluate(body => (window as any).__queueEmit({type:'steering_consumed',controlId:body.controlId,requestId:'run',acknowledgementId:body.acknowledgementId,message:{sourceId:'consumed-first',text:body.text}}), admissions[0]);
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  await page.getByTestId('composer-input').fill('追加原稿等待准入');
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('control-queue-item')).toHaveCount(2);
  await expect(page.getByTestId('composer-input')).toHaveValue('');
  await page.getByTestId('composer-input').fill('出队不能清掉的新草稿');
  items = items.filter(item => item.id !== admissions[1].controlId); revision++;
  await page.evaluate(value => (window as any).__queueEmit({type:'control_queue',...value}), snapshot());
  await expect(page.getByTestId('control-queue-item')).toHaveCount(1);
  await expect(page.getByTestId('composer-input')).toHaveValue('出队不能清掉的新草稿');
  // An unknown mutation is never resent; explicit refresh reconciles an SDK drain.
  mutationFailure = 500;
  await page.getByRole('button',{name:'删除：准入后清除追加草稿',exact:true}).click();
  await expect(page.getByText('结果未知，请刷新确认；不会自动重试')).toBeVisible();
  // While a control result is unknown, Enter must not submit another control.
  const admissionsBefore = admissions.length;
  await page.getByTestId('composer-input').press('Enter');
  await expect(page.getByTestId('composer-input')).toHaveValue('出队不能清掉的新草稿');
  expect(admissions).toHaveLength(admissionsBefore);
  await page.screenshot({animations:'disabled',path:info.outputPath('app-operation-unknown.png')});
  const mutationCount = mutations.length;
  items = []; revision++;
  await page.getByRole('button',{name:'刷新队列确认结果'}).click();
  await expect(page.getByTestId('control-queue-item')).toHaveCount(0);
  expect(mutations).toHaveLength(mutationCount);
  // A consumed-delete 409 refreshes and removes the row instead of reviving it.
  items = [{id:'already-consumed',kind:'followUp',text:'已排出冲突样例',hasImages:false,status:'queued',acknowledgementId:'ack-conflict'}]; revision++;
  await page.evaluate(value => (window as any).__queueEmit({type:'control_queue',...value}), snapshot());
  mutationFailure = 409;
  await page.getByRole('button',{name:'删除：已排出冲突样例',exact:true}).click();
  await expect(page.getByTestId('control-queue-item')).toHaveCount(0);
  expect(unexpected).toEqual([]);
});
