/** Trusted host only. Keep this dependency outside the sandbox runtime. */
export interface CredentialProvider {
  /** Invoke the consumer with a currently valid access credential. */
  withAccessToken<T>(
    consume: (token: string) => Promise<T>,
    invocationId?: string,
  ): Promise<T>;
}

export function validKeychainService(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value) &&
    !/sk-[a-zA-Z0-9_-]{12,}/i.test(value)
  );
}
