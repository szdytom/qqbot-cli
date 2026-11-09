export interface ErrorInfo {
  code: string;
  message: string;
  details?: unknown;
}

export class AppError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly exitCode: number;

  constructor(code: string, message: string, details?: unknown, exitCode = 1) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.details = details;
    this.exitCode = exitCode;
  }
}

export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  return { code: "INTERNAL", message: error instanceof Error ? error.message : String(error) };
}

export function usage(message: string): never {
  throw new AppError("USAGE", message, undefined, 2);
}

export function isErrno(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
