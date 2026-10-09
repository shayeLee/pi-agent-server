export class DuplicateProjectCwdError extends Error {
  readonly statusCode = 409;
  constructor() { super("project directory already registered"); }
}
export class InvalidProjectCwdError extends Error {
  readonly statusCode = 400;
  constructor() { super("project directory unavailable"); }
}
