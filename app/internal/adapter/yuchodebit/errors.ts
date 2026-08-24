import { PrimaryCredentialRejectedError } from "../../port/authentication.ts";
import { AuthenticationRequiredError } from "../../port/source.ts";
import { YUCHO_DEBIT_PROVIDER_ID } from "./context.ts";

export class YuchoDebitError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`yucho-debit: ${message}`, options);
    this.name = new.target.name;
  }
}

export class UnexpectedPageError extends YuchoDebitError {}

export class TurnstileVerificationError extends YuchoDebitError {}

export class AuthenticationFailedError extends PrimaryCredentialRejectedError {
  constructor(message = "Yucho Debit rejected the user ID or password", options?: ErrorOptions) {
    super(YUCHO_DEBIT_PROVIDER_ID, message, options);
  }
}

export class UnauthenticatedError extends AuthenticationRequiredError {
  constructor() {
    super(YUCHO_DEBIT_PROVIDER_ID);
  }
}

export class PeriodUnavailableError extends YuchoDebitError {
  readonly availableFrom: Date;

  constructor(availableFrom: Date) {
    super(`statements are only available from ${availableFrom.toISOString()}`);
    this.availableFrom = new Date(availableFrom);
  }
}
