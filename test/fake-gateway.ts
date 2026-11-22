import { randomUUID } from "node:crypto";
import type { EgressGatewayOptions } from "../src/egress-gateway.ts";
import type { HostGateway } from "../src/trusted-host.ts";

export function fakeGateway(calls: string[]) {
  let quarantined = false;
  let quarantineOnClose = false;
  let opened: EgressGatewayOptions | undefined;
  const gateway: HostGateway = {
    socksPort: 40001,
    dnsPort: 40002,
    username: randomUUID(),
    password: "ab".repeat(32),
    get quarantined() {
      return quarantined;
    },
    async close() {
      calls.push("gateway.close");
      if (quarantineOnClose) quarantined = true;
    },
  };
  return {
    gateway,
    get opened() {
      return opened;
    },
    failAuditOnClose() {
      quarantineOnClose = true;
    },
    quarantine() {
      quarantined = true;
    },
    async open(options: EgressGatewayOptions) {
      calls.push("gateway.open");
      opened = options;
      return gateway;
    },
  };
}
