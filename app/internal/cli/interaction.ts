import type { EnsureAuthenticationResult } from "../application/authentication.ts";
import type { ProviderConnection } from "../model/connection.ts";
import type { AuthInteraction } from "../port/auth_interaction.ts";
import type { CLIIO } from "./runtime.ts";

export function createAuthInteraction(io: CLIIO): AuthInteraction {
  return {
    otp: {
      request: async (challenge) => ({
        action: "submit",
        code: await io.askText(
          `${challenge.provider} verification code (${challenge.channel}): `,
        ),
      }),
    },
    progress: {
      publish: (event) => {
        if (event.kind === "external-approval" && event.state === "required") {
          io.warn(
            event.message ??
              `${event.provider}: external approval is required (${event.method})`,
          );
        }
        return Promise.resolve();
      },
    },
  };
}

export function reportAuthentication(
  result: EnsureAuthenticationResult,
  connection: ProviderConnection,
  io: CLIIO,
): void {
  const sessionDescription = result.session === "reused" ? "saved session" : "new login";
  io.warn(`Using connection ${connection.id} (${sessionDescription}).`);

  if (result.recovery !== undefined) {
    io.warn(
      `Saved ${result.recovery.reason} session was ${result.recovery.storedSnapshot}; logged in again.`,
    );
  }
  if (result.persistence.status === "failed") {
    io.warn(
      `Authenticated, but the session could not be saved: ${
        errorMessage(result.persistence.error)
      }`,
    );
  }
  if (result.credentials.persistence.status === "skipped") {
    io.warn(
      "Credentials were not saved because an existing session was reused; " +
        "run with --reauth --save-credentials to perform a new login.",
    );
  } else if (result.credentials.persistence.status === "saved") {
    io.warn(`Saved credentials for connection ${connection.id} in the OS credential store.`);
  } else if (result.credentials.persistence.status === "failed") {
    io.warn(
      `Authenticated, but the credentials could not be saved: ${
        errorMessage(result.credentials.persistence.error)
      }`,
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
