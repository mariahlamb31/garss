import type { LoginResponse, SessionResponse } from "../types";

export type BootstrapAuthResult =
  | {
      status: "authenticated";
      authToken: string;
      shouldPersistToken: boolean;
    }
  | {
      status: "unauthenticated";
      authToken: "";
      error: string;
      shouldClearStoredToken: boolean;
    };

export async function bootstrapAuthSession({
  storedToken,
  accessCode,
  getSession,
  login,
  getErrorMessage,
}: {
  storedToken: string;
  accessCode: string;
  getSession: (token: string) => Promise<SessionResponse>;
  login: (accessCode: string) => Promise<LoginResponse>;
  getErrorMessage: (error: unknown) => string;
}): Promise<BootstrapAuthResult> {
  if (storedToken) {
    try {
      await getSession(storedToken);
      return {
        status: "authenticated",
        authToken: storedToken,
        shouldPersistToken: false,
      };
    } catch (sessionError) {
      if (!accessCode) {
        return {
          status: "unauthenticated",
          authToken: "",
          error: getErrorMessage(sessionError),
          shouldClearStoredToken: true,
        };
      }
    }
  }

  if (!accessCode) {
    return {
      status: "unauthenticated",
      authToken: "",
      error: "",
      shouldClearStoredToken: false,
    };
  }

  try {
    const response = await login(accessCode);
    return {
      status: "authenticated",
      authToken: response.token,
      shouldPersistToken: true,
    };
  } catch (loginError) {
    return {
      status: "unauthenticated",
      authToken: "",
      error: getErrorMessage(loginError),
      shouldClearStoredToken: Boolean(storedToken),
    };
  }
}
