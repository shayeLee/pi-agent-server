/** Immutable acknowledgement identity, separate from the active primary request. */
export type SteeringIdentity = {
  controlId: string;
  acknowledgementId: string;
  requestId: string;
};
/** Safe projection of the actual persisted SDK user entry; absent on legacy servers. */
export type SteeringConsumed = SteeringIdentity & {
  message?: {
    sourceId: string;
    text: string;
    images?: readonly { mediaType: string; base64: string }[];
  };
};
export type SteeringInput = SteeringIdentity & {
  images?: { mediaType: string; base64: string }[];
};
