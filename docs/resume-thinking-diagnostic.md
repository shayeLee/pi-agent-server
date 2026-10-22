# Resume thinking: isolated HTTP/browser diagnostic

## Scope and evidence

No user session/database/model was accessed. No live 8080/5173 access, build, deployment, service restart, or git commit. Existing dirty files and attachment/snapshot features were left unchanged. New tests use temporary SDK 1.0.4 JSONL, an in-memory SQLite fixture, production Fastify handlers at 8097, and Chrome/Vite at 5197. Temporary session files are removed and the fixture database/server closed.

Added:
- `web/e2e/resume-http-local.spec.ts`
- `web/playwright.resume-local.config.ts`

## Confirmed artifact mismatch

Both existing compiled artifacts predate the prior source fix:
- `dist/agent/session-export.js` has no thinking projection branch.
- `web/dist/assets/index-CWX3QSvI.js` has history message/tool mapping but no thinking mapping.

Independent new end-to-end reproductions:

```sh
RESUME_DIAGNOSTIC_BACKEND=dist volta run pnpm --filter web exec playwright test --config playwright.resume-local.config.ts --grep 'cold JSONL'
RESUME_DIAGNOSTIC_FRONTEND=dist volta run pnpm --filter web exec playwright test --config playwright.resume-local.config.ts --grep 'cold JSONL'
```

1. Existing compiled backend reader + source UI: HTTP 200, fields `messages,timeline,lastEventId`, timeline types `message,message`, cursor 0. Fails the payload thinking assertion (expected original thinking, received empty array).
2. Source backend + existing compiled UI served read-only by Vite preview: HTTP 200, timeline types `message,thinking,message`, cursor 0. Payload assertion passes; browser fails because the thinking expand button is absent.

These are real HTTP/browser failures with the unchanged old artifacts, not synthetic timeline fixtures. They prove two sufficient failure paths locally. They do **not** prove which artifacts the user's service actually serves. The repository has no regular chat static-file handler or bundle server configuration establishing that deployment; `package.json` bin points to `dist/main.js`, and Web `preview` uses existing `web/dist`. Actual launch command/static root and browser asset name remain missing evidence.

## Source-path comparison (not a new fix)

```sh
volta run pnpm --filter web exec playwright test --config playwright.resume-local.config.ts
```

Cold and resumed-runtime browser cases both passed all thinking payload/display assertions: initial expand shows original multiline text, switching to another session then returning preserves an expandable row, and browser reload/reselect restores it again. HTTP timeline types are `message,thinking,message`. SSE request `last-event-id` matches export cursor (cold 0, runtime 2). SDK header session ID deliberately differs from the Web/database ID; this does not cause loss when `conversationRef` points to the correct managed directory/file.

The run was **not fully green**: the final adapter-count assertion expected export-only counts (0/1), but actual counts were 2. Production `GET /events` intentionally lazily instantiates a runtime for each selected session for writable users (`src/server/app.ts:716`); export itself does not. The test assertion has been corrected to 2 based on that direct evidence, but was not rerun after the focused retry. Final file-unchanged assertion lies after that assertion and therefore has not yet been verified by this new test. First attempt also hit a sidebar action-overlay click interception; retry clicks the left edge normally (not forced).

No production code or compiled artifact was changed. There is no claim that the user's issue is fixed. A caller should run the corrected default test before accepting it as green; if further unexpected failures occur, delegate the harness investigation to `claude-worker` rather than keep retrying blindly.

## Actual path traced

- `src/client/api.ts:196`: `GET /v1/sessions/:id/export`.
- `src/server/app.ts:619`: ownership/access-gated handler delegates to session service.
- `src/application/session-service.ts:517`: existing registry runtime wins, exports adapter snapshot plus pre-export event cursor; otherwise `conversationRef` resolves through registered conversation storage with cursor 0. Null reference gives empty history; unreadable/unregistered/invalid reference fails closed with sanitized error.
- `src/agent/pi-agent-adapter.ts:237`: live export reads `session.messages` and current `sessionManager.getBranch()`.
- `src/agent/pi-jsonl-conversation-storage.ts:176,211`: cold export validates managed reference/JSONL v3, uses installed SDK parser and preloaded SessionManager branch, then the same snapshot projector. Existing tests cover selected branches and file read-only behavior; the new browser test additionally covers SDK-generated format and distinct header/Web IDs.
- `src/agent/pi-agent-session-factory.ts:106`: runtime restores the stored reference, not a browser-selected SDK header ID. No adapter listener was found translating an external Pi session switch into a new Web session record/reference.
- `web/src/hooks/useWebAppController.ts`: non-new sessions always export before subscribing. Uses non-empty `timeline`, falling back to `messages`. Restore is only on first load, when store identity remains unchanged and history is non-empty. Newly created sessions skip export. Subsequent selects export again but do not restore an already-ready store. Export errors are swallowed and session is still marked ready.
- `src/client/chat-state.ts`: SSE events append/update items and phases; status/completed do not reset the history timeline. Controller does not reset an existing store on reselection. Browser source cases did not lose restored thinking through SSE subscription.

## Remaining risks (code evidence, not user-cause confirmation)

- A first export failure/empty response is cached as ready: later successful export may not replace the empty baseline.
- On returning to an already-ready session, changed JSONL/history is fetched but not restored; subscription starts at the new export cursor. Events that occurred while away can therefore be skipped. This also matters if a Pi runtime externally changes its current branch/session without a new Web ID. The new test does not simulate an external Pi switch or concurrent model run.
- Runtime without a usable SessionManager branch yields empty timeline and legacy text-only fallback. Production SDK normally has a manager; no evidence that user's runtime lacks it.
- Wrong/null `conversationRef`, unavailable old JSONL version, wrong selected branch, provider thinking absent/redacted, stale browser cache, or a separately installed SDK version remain unconfirmed possibilities.

## Minimal user diagnostics needed

No full transcript, tokens, raw database, or thinking content needed:
1. Whether “resume” means sidebar reselection/page reload or Pi `/resume` switching to another SDK ID.
2. For one affected selection: actual export request pathname, HTTP status, response field names, `timeline` item-type counts, `messages.length`, and `lastEventId` only.
3. Following events request's `Last-Event-ID` and status; whether failure occurs on first selection or only after reselection.
4. Browser-loaded JS asset filename (and cache/service-worker indication if present), backend launch command (source vs compiled), static asset root, and installed SDK version. Redact private absolute paths.
5. Only if response has no thinking despite current artifacts: confirm selected JSONL branch contains a `message.content` block with `type: thinking` and string field `thinking`; report booleans/counts, not the text. Confirm Web ID-to-conversationRef points to the intended file, without sharing its contents.
