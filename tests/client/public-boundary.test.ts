import { expect, expectTypeOf, test } from "vitest";
import type { SseEvent as ClientEvent } from "../../src/client/types.js";
import type { SseEvent as ServerEvent } from "../../src/agent/events.js";
import type { SessionRecord } from "../../src/application/ports/session-store-port.js";
import type { SubmitInput } from "../../src/application/ports/session-runtime-port.js";
import type { Session, MessageInput, SseEvent } from "../../src/public-api/contract.js";
import { TURN_ERROR_CODES } from "../../src/public-api/contract.js";
import { TURN_ERROR_CODES as RuntimeCodes } from "../../src/application/ports/session-runtime-port.js";

test("shared public DTOs preserve the existing server contracts", () => {
  expectTypeOf<ClientEvent>().toEqualTypeOf<ServerEvent>();
  expectTypeOf<SseEvent>().toEqualTypeOf<ServerEvent>();
  expectTypeOf<MessageInput>().toEqualTypeOf<Omit<SubmitInput, "userId">>();
  type PreviousSessionDto = Omit<SessionRecord, "agentKind" | "conversationFormat" | "conversationRef"> & { firstPrompt?: string | null };
  expectTypeOf<Session>().toExtend<PreviousSessionDto>();
  expectTypeOf<PreviousSessionDto>().toExtend<Session>();
  expect(TURN_ERROR_CODES).toBe(RuntimeCodes);
  expect(Object.isFrozen(TURN_ERROR_CODES)).toBe(true);
});
