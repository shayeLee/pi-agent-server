/** Immutable acknowledgement identity, separate from the active primary request. */
export type SteeringIdentity = {
  controlId: string;
  acknowledgementId: string;
  requestId: string;
};
export type SteeringInput = SteeringIdentity & {
  images?: { mediaType: string; base64: string }[];
};
