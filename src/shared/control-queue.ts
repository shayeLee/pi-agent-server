import type { SteeringIdentity } from "./steering.js";

export type ControlIdentity = SteeringIdentity;
export type ControlQueueItem = {
  id: string;
  kind: "steer" | "followUp";
  text: string;
  hasImages: boolean;
  status: "queued";
  acknowledgementId: string;
};
export type ControlQueueSnapshot = {
  requestId: string | null;
  revision: number;
  items: ControlQueueItem[];
};
export type ControlQueueMutation = { kind: "ok"; snapshot: ControlQueueSnapshot } | { kind: "conflict" };
