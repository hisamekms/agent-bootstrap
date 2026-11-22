import { createHmac, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context,
  type Span,
  type SpanAttributes,
} from "@opentelemetry/api";
import {
  ExportResultCode,
  hrTime,
  parseTraceParent,
  type ExportResult,
} from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  LoggerProvider,
  SimpleLogRecordProcessor,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
} from "@opentelemetry/sdk-metrics";
import {
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
  TracerProvider,
  type SpanExporter,
} from "@opentelemetry/sdk-trace";
import type { ObservabilityConfig } from "./observability-config.ts";
import {
  createExportQueue,
  createOtlpFileExporters,
  writeTelemetryDiagnostic,
} from "./otlp-file-exporters.ts";
import {
  createResourceSampler,
  type ResourceSampler,
  type ResourceSamplingTimer,
} from "./resource-sampler.ts";
import type { ExecutionOutcome, RuntimeEvent } from "./runtime-events.ts";
import type {
  ResourceSample,
  SandboxHandle,
  SandboxRuntime,
} from "./sandbox-runtime.ts";
import { PROFILE_NAMES, ROLE_PROFILES } from "./sandbox-profiles.ts";
import type { HostObserver } from "./trusted-host.ts";

type TelemetryConfig = ObservabilityConfig["telemetry"];
type SamplingRuntime = Pick<SandboxRuntime, "sampleResources">;

export interface Telemetry extends HostObserver {
  observeFinalResourceSample(
    executionId: string,
    sandboxId: string,
    sample: ResourceSample,
  ): void;
  /** The composition layer supplies the real handle when it is available. */
  startResourceSampling(
    executionId: string,
    handle: SandboxHandle,
    runtime: SamplingRuntime,
  ): void;
  shutdown(): Promise<void>;
}

interface TelemetryOptions {
  readonly exporters?: {
    readonly traces: SpanExporter;
    readonly metrics: PushMetricExporter;
    readonly logs: LogRecordExporter;
  };
  readonly samplingTimer?: ResourceSamplingTimer;
}

interface Execution {
  readonly id: string;
  readonly span: Span;
  readonly context: Context;
  readonly startedAt: number;
  readonly labels: SpanAttributes;
  sandboxId?: string;
  active: boolean;
  process?: {
    readonly operationId: string | undefined;
    readonly startedAt: number;
  };
  processSeen: boolean;
  sampler?: ResourceSampler;
  finalSample?: ResourceSample;
}

const noopTelemetry: Telemetry = Object.freeze({
  observe() {},
  observeFinalResourceSample() {},
  startResourceSampling() {},
  async shutdown() {},
});

const executionIdKey = "agent_bootstrap.execution_id";
const sandboxIdKey = "agent_bootstrap.sandbox_id";

const resourceInstruments = [
  ["sandbox.cpu.time", "ns"],
  ["sandbox.memory.usage", "By"],
  ["sandbox.memory.peak", "By"],
  ["sandbox.memory.host_resident", "By"],
  ["sandbox.disk.read", "By"],
  ["sandbox.disk.write", "By"],
  ["sandbox.network.rx", "By"],
  ["sandbox.network.tx", "By"],
] as const;

function finishSpan(
  span: Span,
  outcome: ExecutionOutcome,
  endTime: number,
): void {
  span.setAttribute("outcome", outcome);
  span.setStatus({
    code:
      outcome === "succeeded"
        ? SpanStatusCode.OK
        : outcome === "unknown"
          ? SpanStatusCode.UNSET
          : SpanStatusCode.ERROR,
  });
  span.end(hrTime(endTime));
}

function labelsFor(
  payload: RuntimeEvent<"execution.started">["payload"],
): SpanAttributes {
  const labels: SpanAttributes = {};
  if (Object.hasOwn(ROLE_PROFILES, payload.role)) labels.role = payload.role;
  if (PROFILE_NAMES.includes(payload.profile)) labels.profile = payload.profile;
  if (payload.agentKind === "codex" || payload.agentKind === "claude")
    labels["agent.kind"] = payload.agentKind;
  if (payload.runtimeKind === "microsandbox")
    labels["runtime.kind"] = payload.runtimeKind;
  return labels;
}

interface Exporter<T> {
  export(data: T, callback: (result: ExportResult) => void): void;
  forceFlush?(): Promise<void>;
  shutdown(): Promise<void>;
}

/** Contain failures from injected exporters and discard their diagnostic text. */
function protectExporter<T>(exporter: Exporter<T>, dropped: () => void) {
  async function finish(action: () => Promise<void> | undefined) {
    try {
      await action();
    } catch {
      dropped();
    }
  }

  const queue = createExportQueue();
  let closing: Promise<void> | undefined;
  const failed = { code: ExportResultCode.FAILED } as const;

  return {
    export(data: T, callback: (result: ExportResult) => void): void {
      if (
        !closing &&
        queue.enqueue(async () => {
          const result = await new Promise<ExportResult>((resolve) => {
            try {
              exporter.export(data, (result) => resolve({ code: result.code }));
            } catch {
              resolve(failed);
            }
          });
          if (result.code !== ExportResultCode.SUCCESS) dropped();
          callback(result);
        })
      )
        return;
      dropped();
      callback(failed);
    },
    forceFlush: () =>
      queue.afterPending(() => finish(() => exporter.forceFlush?.())),
    shutdown: () =>
      (closing ??= queue.afterPending(() => finish(() => exporter.shutdown()))),
  };
}

/** Creates local SDK providers and instruments trusted host runtime events. */
export function createTelemetry(
  config: TelemetryConfig,
  dir: string,
  options: TelemetryOptions = {},
): Telemetry {
  if (!config.enabled) return noopTelemetry;

  let dropped = 0;
  let lastDiagnostic = -Infinity;
  function reportDrop(count = 1): void {
    dropped += count;
    const now = performance.now();
    if (now - lastDiagnostic < 60_000) return;
    lastDiagnostic = now;
    try {
      writeTelemetryDiagnostic("obs.telemetry.dropped kind=instrumentation\n");
    } catch {
      // Diagnostics are best effort.
    }
  }

  const injected = options.exporters;
  const files = createOtlpFileExporters(dir, {
    ...(config.maxTotalBytes !== undefined && {
      maxTotalBytes: config.maxTotalBytes,
    }),
  });
  const traces = injected
    ? protectExporter(injected.traces, reportDrop)
    : files.traces;
  const logs = injected
    ? protectExporter(injected.logs, reportDrop)
    : files.logs;
  const metricExporter = injected?.metrics;
  const metrics: PushMetricExporter = metricExporter
    ? {
        ...protectExporter(metricExporter, reportDrop),
        ...(metricExporter.selectAggregationTemporality && {
          selectAggregationTemporality:
            metricExporter.selectAggregationTemporality.bind(metricExporter),
        }),
        ...(metricExporter.selectAggregation && {
          selectAggregation:
            metricExporter.selectAggregation.bind(metricExporter),
        }),
      }
    : files.metrics;

  const resource = resourceFromAttributes({
    "service.name": "agent-bootstrap",
  });
  const ratio = new TraceIdRatioBasedSampler(config.traceSamplingRatio);
  const tracerProvider = new TracerProvider({
    resource,
    // Apply the configured ratio to local executions, including executions
    // with a remote parent. Children inherit the local sampling decision.
    sampler: new ParentBasedSampler({
      root: ratio,
      remoteParentSampled: ratio,
      remoteParentNotSampled: ratio,
    }),
    spanProcessors: [new SimpleSpanProcessor({ exporter: traces })],
  });
  const loggerProvider = new LoggerProvider({
    resource,
    processors: [new SimpleLogRecordProcessor({ exporter: logs })],
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [new PeriodicExportingMetricReader({ exporter: metrics })],
  });
  const tracer = tracerProvider.getTracer("agent-bootstrap");
  const logger = loggerProvider.getLogger("agent-bootstrap");
  const meter = meterProvider.getMeter("agent-bootstrap");
  const executionDuration = meter.createHistogram("execution.duration", {
    unit: "ms",
  });
  const startupDuration = meter.createHistogram("sandbox.startup.duration", {
    unit: "ms",
  });
  const processDuration = meter.createHistogram("process.duration", {
    unit: "ms",
  });
  const activeSandboxes = meter.createUpDownCounter("sandbox.active", {
    unit: "{sandbox}",
  });
  const resources = resourceInstruments.map(([name, unit]) => ({
    name,
    histogram: meter.createHistogram(name, { unit }),
  }));
  meter
    .createObservableCounter("obs.telemetry.dropped")
    .addCallback((result) => result.observe(dropped + files.dropped));

  const executions = new Map<string, Execution>();
  const dnsKey = randomBytes(32);
  let closing: Promise<void> | undefined;
  let closed = false;

  async function safely(action: () => void | Promise<void>): Promise<void> {
    try {
      await action();
    } catch {
      reportDrop();
    }
  }

  function spanFor(
    execution: Execution,
    name: string,
    startTime: number,
    sandboxId: string | undefined,
    extra: SpanAttributes = {},
  ): Span {
    return tracer.startSpan(
      name,
      {
        startTime: hrTime(startTime),
        attributes: {
          ...execution.labels,
          [executionIdKey]: execution.id,
          [sandboxIdKey]: sandboxId,
          ...extra,
        },
      },
      execution.context,
    );
  }

  function samplerFor(
    execution: Execution,
    handle: SandboxHandle,
    runtime: SamplingRuntime,
  ): ResourceSampler {
    return createResourceSampler(
      {
        ...(runtime.sampleResources && {
          sampleResources: runtime.sampleResources.bind(runtime),
        }),
        // The host reads the adapter's terminal sample once and forwards it.
        finalResourceSample: () => execution.finalSample ?? null,
      },
      handle,
      config.resourceSamplingIntervalMs,
      options.samplingTimer,
    );
  }

  function finishResources(execution: Execution): void {
    const sandboxId = execution.sandboxId;
    if (sandboxId === undefined) return;
    const sampler =
      execution.sampler ?? samplerFor(execution, { id: sandboxId }, {});
    const summary = sampler.finish();
    execution.span.setAttribute("resource.sampling.status", summary.status);
    execution.span.setAttribute(
      "resource.sampling.skipped",
      summary.skippedTicks,
    );
    if (summary.failures) reportDrop(summary.failures);

    const sample = summary.lastSample;
    const values = [
      summary.lastVcpuTimeNs,
      sample?.memoryBytes,
      summary.sampledPeakMemoryBytes,
      sample?.memoryHostResidentBytes,
      summary.deltas.diskReadBytes,
      summary.deltas.diskWriteBytes,
      summary.deltas.netRxBytes,
      summary.deltas.netTxBytes,
    ];
    for (const [index, { name, histogram }] of resources.entries()) {
      const value = values[index];
      if (value === undefined) continue;
      histogram.record(value, execution.labels);
      execution.span.setAttribute(name, value);
    }
  }

  function releaseSandbox(execution: Execution): void {
    if (!execution.active) return;
    execution.active = false;
    // Release the observed lifecycle even when physical cleanup is unknown.
    activeSandboxes.add(-1, execution.labels);
    finishResources(execution);
  }

  function logNetwork(
    event: RuntimeEvent<"network.connect.decided" | "network.dns.query">,
    context: Context,
  ): void {
    const attributes: SpanAttributes = {
      [executionIdKey]: event.executionId,
      [sandboxIdKey]: event.sandboxId,
      "network.protocol": event.payload.protocol,
      "network.decision": event.payload.decision,
      "network.reason": event.payload.reasonCode,
    };
    if (event.eventType === "network.dns.query") {
      const { qname, qtype, decision, queryId } = event.payload;
      attributes["network.query_id"] = queryId;
      attributes["dns.qtype"] = qtype;
      if (decision === "allow") attributes["dns.qname"] = qname;
      else {
        // Denied labels are guest-controlled and can themselves be payload.
        attributes["dns.qname_hash"] = createHmac("sha256", dnsKey)
          .update(qname)
          .digest("hex");
      }
    } else {
      const {
        connectionId,
        destinationIp,
        destinationPort,
        hostname,
        decision,
        channel,
      } = event.payload;
      attributes["network.connection_id"] = connectionId;
      attributes["network.channel"] = channel;
      attributes["destination.port"] = destinationPort;
      if (destinationIp && isIP(destinationIp) && !destinationIp.includes("%"))
        attributes["destination.address"] = destinationIp;
      if (decision === "allow") attributes["destination.hostname"] = hostname;
    }
    const { policyId } = event.payload;
    if (/^[a-f0-9]{64}$/.test(policyId))
      attributes["network.policy_id"] = policyId;
    logger.emit({
      body: event.eventType,
      attributes,
      context,
      timestamp: new Date(event.occurredAt),
    });
  }

  function observe(event: RuntimeEvent): void {
    const id = event.executionId;
    const execution = id === undefined ? undefined : executions.get(id);
    if (
      event.eventType === "network.connect.decided" ||
      event.eventType === "network.dns.query"
    ) {
      logNetwork(event, execution?.context ?? ROOT_CONTEXT);
      return;
    }
    if (id === undefined) return;
    const now = performance.now();
    if (event.eventType === "execution.started") {
      if (execution || event.payload.context.executionId !== id) return;
      const parent = event.payload.context.traceContext?.traceparent;
      const remote = parent && parseTraceParent(parent);
      const parentContext = remote
        ? trace.setSpanContext(ROOT_CONTEXT, { ...remote, isRemote: true })
        : ROOT_CONTEXT;
      const labels = labelsFor(event.payload);
      const span = tracer.startSpan(
        "execution",
        {
          startTime: hrTime(now),
          attributes: { ...labels, [executionIdKey]: id },
        },
        parentContext,
      );
      executions.set(id, {
        id,
        span,
        context: trace.setSpan(ROOT_CONTEXT, span),
        startedAt: now,
        labels,
        active: false,
        processSeen: false,
      });
      return;
    }
    if (!execution) return;

    switch (event.eventType) {
      case "sandbox.created": {
        const { outcome, durationMs } = event.payload;
        const span = spanFor(
          execution,
          "sandbox.create",
          now - durationMs,
          event.sandboxId,
        );
        finishSpan(span, outcome, now);
        startupDuration.record(durationMs, { ...execution.labels, outcome });
        if (event.sandboxId !== undefined) {
          execution.sandboxId = event.sandboxId;
          execution.span.setAttribute(sandboxIdKey, event.sandboxId);
        }
        if (outcome === "succeeded" && !execution.active) {
          execution.active = true;
          activeSandboxes.add(1, execution.labels);
        }
        break;
      }
      case "process.started": {
        if (!execution.processSeen) {
          execution.processSeen = true;
          // The event has no startup delta. Record this milestone as a point.
          const span = spanFor(execution, "agent.start", now, event.sandboxId);
          finishSpan(
            span,
            event.payload.outcome === "started" ? "succeeded" : "failed",
            now,
          );
        }
        execution.process = { operationId: event.operationId, startedAt: now };
        break;
      }
      case "process.exited": {
        const { durationMs, outcome, exitCode, guestReported } = event.payload;
        const span = spanFor(
          execution,
          execution.labels["agent.kind"] ? "agent.run" : "process.exec",
          now - durationMs,
          event.sandboxId,
          {
            "process.exit_code": exitCode ?? undefined,
            "process.guest_reported": guestReported,
          },
        );
        finishSpan(span, outcome, now);
        processDuration.record(durationMs, { ...execution.labels, outcome });
        if (execution.process?.operationId === event.operationId)
          delete execution.process;
        break;
      }
      case "resource.limit_exceeded":
        execution.span.addEvent(
          event.eventType,
          { "resource.kind": event.payload.kind },
          hrTime(now),
        );
        break;
      case "sandbox.destroyed": {
        const { durationMs, outcome } = event.payload;
        const span = spanFor(
          execution,
          "sandbox.destroy",
          now - durationMs,
          event.sandboxId,
        );
        finishSpan(span, outcome, now);
        releaseSandbox(execution);
        break;
      }
      case "execution.finished": {
        executions.delete(id);
        const { outcome, durationMs } = event.payload;
        endExecution(execution, outcome, execution.startedAt + durationMs);
        executionDuration.record(durationMs, { ...execution.labels, outcome });
        break;
      }
    }
  }

  function endExecution(
    execution: Execution,
    outcome: ExecutionOutcome,
    endTime: number,
  ): void {
    releaseSandbox(execution);
    execution.sampler?.stop();
    if (execution.process) {
      const span = spanFor(
        execution,
        execution.labels["agent.kind"] ? "agent.run" : "process.exec",
        Math.min(execution.process.startedAt, endTime),
        execution.sandboxId,
      );
      finishSpan(span, "unknown", endTime);
    }
    finishSpan(execution.span, outcome, endTime);
  }

  return {
    observe(event) {
      if (closed) return;
      try {
        observe(event);
      } catch {
        reportDrop();
      }
    },
    observeFinalResourceSample(executionId, sandboxId, sample) {
      if (closed) return;
      const execution = executions.get(executionId);
      if (execution?.active && execution.sandboxId === sandboxId) {
        execution.finalSample = sample;
        execution.sampler?.stop();
      }
    },
    startResourceSampling(executionId, handle, runtime) {
      if (closed) return;
      const execution = executions.get(executionId);
      if (
        !execution ||
        execution.sampler ||
        (execution.sandboxId !== undefined &&
          (!execution.active || execution.sandboxId !== handle.id))
      )
        return;
      try {
        execution.sampler = samplerFor(execution, handle, runtime);
      } catch {
        reportDrop();
      }
    },
    shutdown() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        for (const execution of executions.values())
          await safely(() =>
            endExecution(execution, "unknown", performance.now()),
          );
        executions.clear();
        // Export failures were counted by the file or injected exporters.
        // The span processor can propagate the same error again on flush.
        await Promise.allSettled([
          tracerProvider.forceFlush(),
          loggerProvider.forceFlush(),
        ]);
        await Promise.all([
          safely(() => tracerProvider.shutdown()),
          safely(() => loggerProvider.shutdown()),
        ]);
        await safely(() => meterProvider.shutdown());
      })();
      return closing;
    },
  };
}
