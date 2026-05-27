export class AppError extends Error {
  public readonly statusCode: number;
  public readonly publicMessage: string;

  constructor(publicMessage: string, statusCode = 500, cause?: unknown) {
    super(publicMessage);
    this.name = "AppError";
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400);
    this.name = "ValidationError";
  }
}

export class ConfigError extends AppError {
  constructor(message: string) {
    super(message, 500);
    this.name = "ConfigError";
  }
}

export class ClaudeError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(message, 502, cause);
    this.name = "ClaudeError";
  }
}
