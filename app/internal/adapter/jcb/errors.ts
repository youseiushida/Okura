import { PrimaryCredentialRejectedError } from "../../port/authentication.ts";
import { AuthenticationRequiredError } from "../../port/source.ts";

export class JCBError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`jcb: ${message}`, options);
    this.name = new.target.name;
  }
}

export class UnauthenticatedError extends AuthenticationRequiredError {
  override name = "JCBUnauthenticatedError";

  constructor() {
    super("jcb", "jcb: unauthenticated MyJCB session");
  }
}

export class PeriodUnavailableError extends JCBError {
  constructor(oldest: Date) {
    super(
      `period is outside MyJCB's available statements: oldest available date is ${
        formatJSTDate(oldest)
      }`,
    );
  }
}

export class UnexpectedPageError extends JCBError {
  constructor(detail = "unexpected debit-detail page", options?: ErrorOptions) {
    super(
      detail === "" ? "unexpected debit-detail page" : `unexpected debit-detail page: ${detail}`,
      options,
    );
  }
}

export class AuthenticationFailedError extends PrimaryCredentialRejectedError {
  constructor(status: number, landingPath: string) {
    super(
      "jcb",
      `MyJCB authentication failed: status ${status}, landing path ${JSON.stringify(landingPath)}`,
    );
  }
}

function formatJSTDate(value: Date): string {
  const shifted = new Date(value.getTime() + 9 * 60 * 60 * 1000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
