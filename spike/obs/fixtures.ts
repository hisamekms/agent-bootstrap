import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createSocket } from "node:dgram";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer as httpsServer } from "node:https";
import { connect, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { EgressGateway } from "../../src/egress-gateway.ts";

export const runFile = promisify(execFile);
export const loopback = "127.0.0.1";
export const serviceIp = "192.0.2.40";
export const directIp = "203.0.113.76";
export const probeIp = "198.51.100.75";
export const probeV6 = "2001:db8::75";
export const providerIp = "192.0.2.44";
export const providerName = "obs-provider.test";
export const secretEnv = "OBS_FIXTURE_TOKEN";
export const canary = "obs10-local-canary";

export async function until(check: () => boolean, message: string) {
  const deadline = performance.now() + 20_000;
  while (!check()) {
    assert.ok(performance.now() < deadline, message);
    await delay(15);
  }
}

async function bind(server: Server, host = loopback) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "Missing fixture address");
  return address.port;
}

export async function tcpFixture(
  mode: "reply" | "hold",
  host = loopback,
  onAccept?: (socket: Socket) => void,
) {
  const sockets = new Set<Socket>();
  let connections = 0;
  let bytes = 0;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.on("data", (data) => {
      bytes += data.length;
    });
    socket.on("end", () => socket.end());
    socket.write(canary);
    if (mode === "reply") {
      socket.end();
      socket.once("end", () => socket.destroy());
    }
    connections++;
    onAccept?.(socket);
  });
  const port = await bind(server, host);
  return {
    port,
    get connections() {
      return connections;
    },
    get bytes() {
      return bytes;
    },
    get active() {
      return sockets.size;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export async function providerFixture(dir: string) {
  const token = randomBytes(32).toString("hex");
  const ca = join(dir, "ca.pem");
  const caKey = join(dir, "ca.key");
  const key = join(dir, "server.key");
  const csr = join(dir, "server.csr");
  const cert = join(dir, "server.pem");
  const ext = join(dir, "server.ext");
  const caConfig = join(dir, "ca.conf");
  await writeFile(
    caConfig,
    [
      "[req]",
      "prompt=no",
      "distinguished_name=dn",
      "x509_extensions=v3",
      "[dn]",
      "CN=OBS-10 fixture CA",
      "[v3]",
      "basicConstraints=critical,CA:true",
      "keyUsage=critical,keyCertSign,cRLSign",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    ext,
    `subjectAltName=DNS:${providerName}\nextendedKeyUsage=serverAuth\n`,
    { mode: 0o600 },
  );
  const openssl = (args: string[]) =>
    runFile("/usr/bin/openssl", args, {
      cwd: dir,
      env: { PATH: "/usr/bin:/bin" },
      timeout: 15_000,
    });
  await openssl([
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-config",
    caConfig,
    "-keyout",
    caKey,
    "-out",
    ca,
  ]);
  await openssl([
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${providerName}`,
    "-keyout",
    key,
    "-out",
    csr,
  ]);
  await openssl([
    "x509",
    "-req",
    "-in",
    csr,
    "-CA",
    ca,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    ext,
    "-out",
    cert,
  ]);
  let hits = 0;
  let correct = 0;
  const sockets = new Set<Duplex>();
  const server = httpsServer(
    { key: await readFile(key), cert: await readFile(cert) },
    (request, response) => {
      hits++;
      if (request.headers.authorization === `Bearer ${token}`) correct++;
      response.writeHead(200, { Connection: "close" }).end(canary);
    },
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await Promise.all([caKey, key].map((path) => rm(path)));
  const port = await bind(server);
  return {
    port,
    token,
    ca,
    get hits() {
      return hits;
    },
    get correct() {
      return correct;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function dnsQuestion(name: string, id: number) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);
  return Buffer.concat([
    header,
    ...name
      .split(".")
      .map((label) =>
        Buffer.concat([Buffer.of(label.length), Buffer.from(label)]),
      ),
    Buffer.of(0, 0, 1, 0, 1),
  ]);
}

export async function dnsClient() {
  const socket = createSocket("udp4");
  const pending = new Map<number, (rcode: number | undefined) => void>();
  socket.on("message", (message, remote) => {
    if (remote.address === loopback && message.length >= 12)
      pending.get(message.readUInt16BE())?.(message[3]! & 15);
  });
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(0, loopback, resolve);
  });
  let nextId = 0;
  return {
    query(port: number, name: string, timeout = 750) {
      const id = ++nextId;
      return new Promise<number | undefined>((resolve) => {
        const finish = (rcode?: number) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(rcode);
        };
        const timer = setTimeout(finish, timeout);
        pending.set(id, finish);
        socket.send(dnsQuestion(name, id), port, loopback, (error) => {
          if (error) finish();
        });
      });
    },
    close() {
      socket.close();
    },
  };
}

/** Supply the other gateway's identity only from the trusted host. */
export async function socksAuth(port: number, identity: EgressGateway) {
  const socket = connect(port, loopback);
  socket.setTimeout(1500, () => socket.destroy());
  try {
    let received = Buffer.alloc(0);
    socket.write(Buffer.of(5, 1, 2));
    for await (const chunk of socket) {
      received = Buffer.concat([received, chunk]);
      if (received.length < 2) continue;
      if (received[0] === 5) {
        assert.equal(received[1], 2, "Gateway did not select RFC 1929");
        const user = Buffer.from(identity.username);
        const pass = Buffer.from(identity.password);
        socket.write(
          Buffer.concat([
            Buffer.of(1, user.length),
            user,
            Buffer.of(pass.length),
            pass,
          ]),
        );
        received = Buffer.alloc(0);
      } else {
        return received[0] === 1 && received[1] === 0;
      }
    }
    return false;
  } catch (error) {
    if (
      ["ECONNREFUSED", "ECONNRESET"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      return false;
    throw error;
  } finally {
    socket.destroy();
  }
}

/** Addresses the guest probes that must never appear as a peer of any host
 * socket. All are non-routable or documentation ranges. */
const witnessedExtra = [
  "169.254.169.254",
  "10.22.33.44",
  "169.254.10.11",
  "172.31.254.249",
  "fd42:6d73:62:ffff::2",
  "198.51.100.75",
  "203.0.113.76",
  "2001:db8::75",
  "64:ff9b::c633:644b",
];

/** Rootless host-side witness for traffic that escapes before SOCKS.
 *
 * tcpdump needs root, so this polls `lsof -nP -i` (no root, ~30 ms) back to back and fails if
 * any host TCP/UDP socket has a witnessed address as its peer (a dial that
 * left the userspace netstack). Limits, recorded in phase1-evidence.md:
 * a connect refused or reset faster than the poll interval, and an
 * unconnected UDP datagram (sendto without a connected socket), leave no
 * socket row. Numeric TEST-NET destinations cannot contact a third party.
 * Calibration: a real loopback connection must be visible as a row. */
export async function captureBypasses(
  targets: string[] = [probeIp, probeV6, directIp, "64:ff9b::c633:644b"],
) {
  const watched = [...new Set([...targets, ...witnessedExtra])];
  const peer = (ip: string) =>
    new RegExp(`->\\[?${ip.replaceAll(".", "\\.")}\\]?:\\d+`, "i");
  const patterns = watched.map((ip) => [ip, peer(ip)] as const);
  const snapshot = async () =>
    (
      await runFile("/usr/sbin/lsof", ["-nP", "-i"], {
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;

  // Calibration: the witness must see a connected loopback socket.
  const calibration = createServer((socket) => socket.on("error", () => {}));
  await new Promise<void>((resolve) =>
    calibration.listen(0, loopback, resolve),
  );
  const calibrationPort = (calibration.address() as { port: number }).port;
  const client = connect({ host: loopback, port: calibrationPort });
  client.on("error", () => {});
  try {
    await new Promise<void>((resolve) => client.once("connect", resolve));
    assert.ok(
      (await snapshot())
        .split("\n")
        .some((line) => line.includes(`->127.0.0.1:${calibrationPort}`)),
      "Socket witness missed loopback calibration",
    );
  } finally {
    client.destroy();
    calibration.close();
  }

  let stopping = false;
  let polls = 0;
  const hits = new Set<string>();
  const loop = (async () => {
    while (!stopping) {
      const text = await snapshot();
      polls += 1;
      for (const line of text.split("\n")) {
        for (const [ip, pattern] of patterns) {
          if (pattern.test(line)) hits.add(`${ip}: ${line.trim()}`);
        }
      }
      await delay(20);
    }
  })();
  return Object.assign(
    async () => {
      await delay(1100);
      stopping = true;
      await loop;
      assert.ok(polls >= 10, "Socket witness barely polled");
      assert.deepEqual(
        [...hits],
        [],
        "A host socket reached a witnessed bypass destination",
      );
      return { polls };
    },
    { polls: () => polls },
  );
}

// The Debian profile includes Perl and OpenSSL. Use literal socket probes
// so an available shell utility or a local TCP handshake cannot imply egress.
export const guestPerl = String.raw`
use strict;
use warnings;
use Socket qw(:all);

sub address {
  my ($ip, $port) = @_;
  return $ip =~ /:/
    ? (AF_INET6, pack_sockaddr_in6($port, inet_pton(AF_INET6, $ip)))
    : (AF_INET, pack_sockaddr_in($port, inet_pton(AF_INET, $ip)));
}
sub dial {
  my ($ip, $port, $type) = @_;
  my ($af, $addr) = address($ip, $port);
  socket(my $s, $af, $type, ($type == SOCK_STREAM ? IPPROTO_TCP : IPPROTO_UDP))
    or die "socket: $!";
  return connect($s, $addr) ? $s : undef;
}
sub bounded {
  my ($seconds, $attempt) = @_;
  my $result;
  eval {
    local $SIG{ALRM} = sub { die "probe-timeout\n" };
    alarm $seconds;
    $result = $attempt->();
  };
  my $error = $@;
  alarm 0;
  die $error if $error && $error ne "probe-timeout\n";
  return $result;
}
sub read_n {
  my ($s, $n) = @_;
  my $body = "";
  while (length($body) < $n) {
    my $count = sysread($s, my $chunk, $n - length($body));
    last unless $count;
    $body .= $chunk;
  }
  return $body;
}
sub tcp {
  my ($ip, $port) = @_;
  return bounded(2, sub {
    my $s = dial($ip, $port, SOCK_STREAM) or return;
    my $body = read_n($s, length("${canary}"));
    close $s;
    return $body;
  }) // "";
}
sub dns {
  my ($ip, $transport, $name, $port) = @_;
  $port //= 53;
  return bounded(2, sub {
    my $s = dial($ip, $port, $transport eq "tcp" ? SOCK_STREAM : SOCK_DGRAM) or return;
    my $packet = pack("n6", 42, 256, 1, 0, 0, 0)
      . join("", map { pack("C", length($_)) . $_ } split /\./, $name)
      . pack("Cnn", 0, 1, 1);
    my $reply;
    if ($transport eq "tcp") {
      syswrite($s, pack("n", length($packet)) . $packet) or return;
      my $size = read_n($s, 2);
      return unless length($size) == 2;
      $reply = read_n($s, unpack("n", $size));
    } else {
      send($s, $packet, 0) or return;
      recv($s, $reply, 4096, 0) or return;
    }
    close $s;
    return unless length($reply) >= 12 && unpack("n", $reply) == 42;
    my ($rcode, $answers) = (ord(substr($reply,3,1)) & 15, unpack("n", substr($reply, 6, 2)));
    return "$rcode/$answers";
  }) // "none";
}
sub socks_visible {
  my ($ip, $port) = @_;
  return bounded(2, sub {
    my $s = dial($ip, $port, SOCK_STREAM) or return;
    syswrite($s, pack("CCC", 5, 1, 2)) or return;
    return read_n($s, 2);
  }) // "";
}
sub gateway {
  open my $routes, "<", "/proc/net/route" or die "IPv4 route table missing";
  while (<$routes>) {
    my (undef, $destination, $via) = split;
    return inet_ntop(AF_INET, pack("V", hex($via))) if defined($destination) && $destination eq "00000000";
  }
  die "IPv4 default route missing";
}
sub gateway6 {
  open my $routes, "<", "/proc/net/ipv6_route" or die "IPv6 route table missing";
  while (<$routes>) {
    my ($destination, $prefix, undef, undef, $via) = split;
    return inet_ntop(AF_INET6, pack("H*", $via))
      if $prefix eq "00" && $via ne ("0" x 32);
  }
  die "IPv6 default gateway missing";
}
sub nat64 {
  my ($ip) = @_;
  return inet_ntop(AF_INET6, inet_pton(AF_INET6, "64:ff9b::") =~ s/.{4}$/inet_pton(AF_INET,$ip)/esr);
}
sub check {
  my ($ok, $case) = @_;
  if (!$ok) { print STDERR "$case failed\n"; exit 47; }
}
`;

export const bypassGuest =
  guestPerl +
  String.raw`
my ($port, $hostport, $host6port, $socks, $dnsport, $tunnel, $target, $v6) = @ARGV;
my $gw = gateway();
my $gw6 = gateway6();
my $marker = "${canary}";
my $pid = $$;
check($> == 0, "root");
for my $ip ($target, $v6, "${directIp}", nat64($target), "169.254.169.254", "10.22.33.44",
             "169.254.10.11", "172.31.254.249", "fd42:6d73:62:ffff::2") {
  check(tcp($ip, $port) ne $marker, "gateway-denial");
}
my $neighbor6 = inet_pton(AF_INET6, $gw6);
substr($neighbor6, 14, 2, pack("n", 0x4242));
$neighbor6 = inet_ntop(AF_INET6, $neighbor6);
for my $ip ($gw, $gw6, "::ffff:$gw", nat64($gw), "0.0.0.0", "::1", $neighbor6) {
  my $listener_port = $ip eq $gw6 || $ip eq "::1" || $ip eq $neighbor6 ? $host6port : $hostport;
  check(tcp($ip, $listener_port) ne $marker, "N-07/N-17");
}
my @host = gethostbyname("host.microsandbox.internal");
check(tcp(inet_ntop(AF_INET,$host[4]), $hostport) ne $marker, "N-07-name") if $host[4];
for my $transport ("udp", "tcp") {
  check(dns($gw, $transport, $tunnel) eq "3/0", "N-09-tunnel");
  check(dns($gw, $transport, "host-service.agent-bootstrap.internal") eq "0/1", "N-09-allow");
  for my $resolver ($target, $v6) {
    my $result = dns($resolver, $transport, "$transport-$pid.refused.test");
    check($result eq "none" || $result eq "3/0" || $result eq "5/0", "N-10/N-11/N-12");
  }
}
check(tcp($target, 853) ne $marker && tcp($v6, 853) ne $marker, "N-13");
check(tcp($target, 443) ne $marker, "N-14");
for my $ip ($target, $v6) {
  for my $p (123, 443, 62501) {
    my $udp = dial($ip, $p, SOCK_DGRAM);
    send($udp, "obs10-udp", 0) if $udp;
  }
  my ($af, $addr) = address($ip, 0);
  my $protocol = $af == AF_INET ? IPPROTO_ICMP : IPPROTO_ICMPV6;
  socket(my $icmp, $af, SOCK_RAW, $protocol) or die "raw ICMP unavailable: $!";
  my $type = $af == AF_INET ? 8 : 128;
  my $checksum = $af == AF_INET ? (0xffff - 0x0800 - ($pid & 0xffff) - 1) & 0xffff : 0;
  send($icmp, pack("CCnnn", $type, 0, $checksum, $pid & 0xffff, 1), 0, $addr);
}
my (undef, $addr) = address($target, 0);
for my $proto (47, 132, 255) {
  socket(my $raw, AF_INET, SOCK_RAW, $proto) or die "raw protocol unavailable: $!";
  if ($proto == 255) {
    setsockopt($raw, IPPROTO_IP, 3, pack("i", 1)) or die "IP_HDRINCL unavailable: $!";
    send($raw, pack("CCnnnCCn", 0x45, 0, 20, 0, 0, 64, 47, 0)
      . inet_pton(AF_INET, "192.0.2.91") . inet_pton(AF_INET, $target), 0, $addr);
  } else {
    send($raw, "obs10-raw", 0, $addr);
  }
}
# Debian's browser profile can omit iproute2. The required mutation probe
# runs separately on Alpine, whose BusyBox includes ip.
check(socks_visible($gw, $socks) eq "" &&
  dns($gw, "tcp", $tunnel, $dnsport) eq "none" &&
  dns($gw, "udp", $tunnel, $dnsport) eq "none", "N-21");
`;

export const holdGuest =
  guestPerl +
  String.raw`
my ($ip, $port, $mode, $otherip) = @ARGV;
my $s = bounded(5, sub { dial($ip, $port, SOCK_STREAM) }) or die "held connect failed";
check(read_n($s, length("${canary}")) eq "${canary}", "active relay canary");
syswrite($s, "ack") == 3 or die "canary acknowledgement failed";
if ($mode eq "other") {
  check(dns(gateway(), "udp", "host-service.agent-bootstrap.internal") eq "0/1", "N-25 own DNS");
  check(tcp($otherip, $port) ne "${canary}", "N-25 cross policy");
  my $line = bounded(30, sub {
    my $line = "";
    while (length($line) < 32) {
      my $c = read_n($s, 1);
      last if $c eq "" || $c eq "\n";
      $line .= $c;
    }
    return $line;
  }) // "";
  check(scalar($line =~ /^([0-9]+) ([0-9]+)$/), "N-25 fixture barrier");
  my ($otherSocks, $otherDns) = ($1, $2);
  check(socks_visible(gateway(), $otherSocks) eq "" &&
    dns(gateway(), "tcp", "obs-cross.test", $otherDns) eq "none" &&
    dns(gateway(), "udp", "obs-cross.test", $otherDns) eq "none", "N-25 cross listener");
} elsif ($mode eq "fault") {
  my $attempt = fork();
  die "N-24 could not start concurrent guest probes" unless defined $attempt;
  if ($attempt == 0) {
    check(tcp($ip, $port) ne "${canary}", "N-24 new relay");
    exit 0;
  }
  check(dns(gateway(), "udp", "obs-fault.test") ne "3/0", "N-24 DNS escaped");
  waitpid($attempt, 0);
  check($? == 0, "N-24 post-fault TCP");
  sleep 20;
} elsif ($mode eq "down") {
  bounded(8, sub { read_n($s, 1); });
  check(tcp($ip, $port) ne "${canary}", "N-23 direct fallback");
  check(dns(gateway(), "udp", "host-service.agent-bootstrap.internal") ne "0/1", "N-23 DNS fallback");
} else {
  sleep 235;
}
close $s;
`;
