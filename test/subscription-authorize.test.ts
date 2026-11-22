import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import {
  acceptCallback,
  verifyIdentity,
} from "../spike/m1/subscription-authorize.ts";

test("consent callback checks state and binds the issued app client", () => {
  const url = new URL("http://127.0.0.1/auth/callback");
  url.search = "?state=state&code=code&client_id=oaiapp_fixture";
  assert.equal(acceptCallback(url, "other"), null);
  assert.throws(() => acceptCallback(url, "state", "oaiapp_other"));
  assert.deepEqual(acceptCallback(url, "state"), {
    code: "code",
    clientId: "oaiapp_fixture",
  });
  url.searchParams.delete("client_id");
  assert.deepEqual(acceptCallback(url, "state", "oaiapp_fixture"), {
    code: "code",
    clientId: "oaiapp_fixture",
  });
});

test("consent callback rejects duplicate fields and provider errors", () => {
  const url = new URL("http://127.0.0.1/auth/callback");
  url.search = "?state=state&state=state&code=code";
  assert.equal(acceptCallback(url, "state", "oaiapp_fixture"), null);
  url.search = "?state=state&code=code&code=other";
  assert.throws(() => acceptCallback(url, "state", "oaiapp_fixture"));
  url.search = "?state=state&error=access_denied";
  assert.throws(() => acceptCallback(url, "state", "oaiapp_fixture"));
});

test("identity requires the provider signature and the expected claims", () => {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const keys = [
    { ...pair.publicKey.export({ format: "jwk" }), kid: "fixture" },
  ];
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: "https://auth.openai.com",
    aud: "oaiapp_fixture",
    nonce: "nonce",
    sub: "fixture_user",
    exp: now + 60,
  };
  const header = encode({ alg: "RS256", kid: "fixture" });
  const token = (payload: object) => {
    const data = `${header}.${encode(payload)}`;
    return `${data}.${sign("RSA-SHA256", Buffer.from(data), pair.privateKey).toString("base64url")}`;
  };
  const verify = (value: string) =>
    verifyIdentity(value, keys, "oaiapp_fixture", "nonce");
  assert.equal(verify(token(claims)), "fixture_user");
  for (const replacement of [
    { iss: "https://example.test" },
    { aud: "oaiapp_other" },
    { aud: ["oaiapp_fixture", "oaiapp_other"] },
    { azp: "oaiapp_other" },
    { nonce: "other" },
    { exp: now - 1 },
  ]) {
    assert.throws(() => verify(token({ ...claims, ...replacement })));
  }
  const signature = token(claims).split(".")[2];
  assert.throws(() =>
    verify(`${header}.${encode({ ...claims, sub: "other" })}.${signature}`),
  );
});
