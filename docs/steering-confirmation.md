# Steering consumption confirmation (rescue78)

## Contract and fix

`POST /v1/sessions/{id}/steer` accepts legacy `{text}` (empty HTTP 204) or correlated `{text, controlId, acknowledgementId, requestId, images?}` (empty HTTP 202). Correlated identity fields must be supplied together. Images retain their existing SDK input support; Web rejects non-image file steering and preserves the draft and attachment references.

HTTP admission does **not** confirm consumption. Previously `ApiClient.request` skipped JSON parsing only for 204, so an admitted empty 202 threw a JSON parse error and appeared as an unknown outcome. The explicit void-response mode is used only by `steer`; non-2xx errors still become `ApiError`. Message submission and other JSON operations still parse 202 response bodies, including throwing on an unexpectedly empty body.

Only session-scoped `steering_consumed` with the exact `controlId`, primary `requestId` and `acknowledgementId` consumes the pending control. This is a nonterminal acknowledgement: the primary run remains active. The SDK adapter associates the actual enqueued user-message object with its immutable identity, not its text or an image/content copy. Duplicate SDK events cannot acknowledge twice. Runtime admissions bind control identity and payload to the actor; another shared-session actor cannot replay or forge that admission. Private-session access remains owner-scoped.

The Web controller supports HTTP-before-SSE, SSE-before-HTTP and unknown-then-consumed. Wrong identities and events on another session do not clear inputs. Consumption clears only the original attachment IDs and clears text only when the draft revision is unchanged. Newly edited text and newly added attachments survive. The admitted-but-unconsumed status is explicitly `HTTP 已接收，等待消费确认`, not generic completion/waiting.

Public contract exports steering identity/input/consumption types and lists `steering_consumed` in `SSE_EVENT_TYPES`. OpenAPI source and generated `openapi/v1.json` include the request variants, empty 202/204 admission responses and the nonterminal SSE acknowledgement.

## Verification

All three typechecks passed:

```sh
pnpm exec tsc --noEmit -p tsconfig.json
pnpm exec tsc --noEmit -p tsconfig.client.json
pnpm --filter web exec tsc --noEmit -p tsconfig.json
```

`pnpm run generate:openapi` passed (full backend TypeScript generation followed by the artifact generator). Focused backend/client/contract verification: **10 files, 165 tests passed**:

```sh
pnpm exec vitest run tests/client tests/public-api tests/server/messages.test.ts tests/agent/pi-agent-adapter.test.ts tests/agent/steering-consumption.test.ts tests/agent/image-input.test.ts tests/runtime/session-runtime.test.ts tests/storage/native-session-index.test.ts
```

Related Web verification: **3 files, 80 tests passed**:

```sh
pnpm --filter web exec vitest run src/App.test.tsx src/components/Chat.test.tsx src/attachment-state.test.ts
```

Isolated real Chrome and SDK 1.0.4: **1 E2E passed**:

```sh
pnpm --filter web exec playwright test --config playwright.steering-local.config.ts
```

This fixture uses temporary database/resources/credentials and a synthetic model stream; browser and server fetch guards prohibit non-loopback network access. It uses only local ports 5268/5269, not live 8080/5173. HTTP evidence is 202, consumption occurs exactly once, no primary terminal event occurs, SDK remains streaming and the new draft remains. Artifacts:

- `/tmp/steering-confirmation/submitted-waiting-consumption.png`
- `/tmp/steering-confirmation/final.png` (actually read after capture; ongoing second tool and retained new draft visible)
- `/tmp/steering-confirmation/http-sse-evidence.json`

## Broader checks and delivery boundary

Broader backend checks (client/public-api/server/runtime/application plus relevant adapter/image tests): **652 passed, 5 skipped, 3 failed**. The failures are existing unrelated `tests/application/session-service.test.ts` project-create equality expectations missing `canCreateSession: true`.

Full Web: **318 passed, 6 failed**. All failures are unrelated `src/components/StatsBar.test.tsx` expectations without the spaces rendered between counts and units. Neither the relevant service implementation nor StatsBar was changed for this fix; these failures were reported rather than hidden or repaired outside scope. Therefore this delivery does not claim a globally green suite.

Logs are available at `/tmp/steering-contracts-final.log`, `/tmp/steering-web-final.log`, `/tmp/steering-backend-related-final.log`, `/tmp/steering-web-all-final.log`, and `/tmp/steering-chrome.log`. No real home database, auth/session/model files, online provider or live service was used. No git commit/reset or global configuration change was performed. Existing unrelated working-tree changes were preserved.
