/** Trusted host only. Keep this dependency outside the sandbox runtime. */
export interface CredentialProvider {
  /** Invoke the consumer with a currently valid access credential. */
  withAccessToken<T>(consume: (token: string) => Promise<T>): Promise<T>;
}
