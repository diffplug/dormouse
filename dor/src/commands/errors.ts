/** Stable first-party CLI error categories. Host messages remain explanatory text. */
export type CliErrorCode = 'INVALID_ARGUMENT' | 'COMMAND_FAILED' | 'CONTROL_UNAVAILABLE' | 'TIMEOUT' | 'SURFACE_DIED' | 'CANCELLED';

export interface CliFailure {
  code: CliErrorCode;
  message: string;
}

export class CliError extends Error {
  constructor(readonly code: CliErrorCode, message: string) { super(message); }
}

/** A caught value as a command's returned error. An `Error` passes through
 *  unchanged, so a `CliError` keeps its code. */
export function commandError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** The code a command's failure reports: a `CliError`'s own, else `COMMAND_FAILED`. */
export function errorCode(error: unknown): CliErrorCode {
  return error instanceof CliError ? error.code : 'COMMAND_FAILED';
}
