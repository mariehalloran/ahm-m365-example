import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { ConfigurationError } from "../../utils/src/configuration/config.js";
import { serviceExecution, selectTenant, type ProjectDocument } from "../../utils/src/configuration/project-config.js";
import { hasProviderSources, serviceProbes } from "../../utils/src/configuration/service-config.js";
import { probeServices, testTypes, type TestType } from "../../utils/src/contracts.js";
import { executionLanes, laneBudget, type ExecutionLane } from "../../utils/src/execution/execution-lanes.js";

const services = ["exchange", "teams", "onedrive", "sharepoint"] as const;
type ServiceType = (typeof services)[number];

export const dispatchSchema = z.object({
  tenant: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
  service: z.enum(services),
  lane: z.string().regex(/^[a-zA-Z0-9-]{1,40}$/),
  journey: z.string().regex(/^[a-z0-9-]{1,60}$/),
  provider: z.boolean().default(false),
  probeType: z.enum(testTypes).optional(),
  testId: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/).optional(),
  slot: z.number().int().nonnegative().safe(),
  configSha256: z.string().regex(/^[a-f0-9]{64}$/),
  attemptId: z.string().uuid(),
}).strict().superRefine((dispatch, context) => {
  if (dispatch.provider) {
    if (dispatch.journey !== "provider-context") {
      context.addIssue({ code: "custom", message: "Provider dispatch requires journey provider-context" });
    }
    if (dispatch.probeType !== undefined || dispatch.testId !== undefined) {
      context.addIssue({ code: "custom", message: "Provider dispatch must not include probe fields" });
    }
    return;
  }
  if (dispatch.probeType === undefined || dispatch.testId === undefined) {
    context.addIssue({ code: "custom", message: "Journey dispatch requires probeType and testId" });
    return;
  }
  if (probeServices[dispatch.probeType].journey !== dispatch.journey) {
    context.addIssue({ code: "custom", message: "Journey dispatch probeType does not match journey" });
  }
});
export type LaneDispatch = z.infer<typeof dispatchSchema>;

interface DispatchLaneBase extends ExecutionLane {
  tenant: string;
  service: ServiceType;
  lane: string;
  journey: string;
  configSha256: string;
  alignToInterval: true;
}
interface JourneyDispatchLane extends DispatchLaneBase {
  provider: false;
  probeType: TestType;
  testId: string;
}
interface ProviderDispatchLane extends DispatchLaneBase {
  provider: true;
  journey: "provider-context";
}
type DispatchLane = JourneyDispatchLane | ProviderDispatchLane;

interface SelectedLane {
  project: ReturnType<typeof selectTenant>;
  service: ReturnType<typeof serviceExecution>;
  lane: DispatchLane;
  provider: boolean;
}

/** Generates a stable compact lane key so one user-journey case owns one persistent journal blob. */
function caseLaneId(dispatch: {
  tenant: string;
  service: ServiceType;
  journey: string;
  probeType: TestType;
  testId: string;
}): string {
  return `case-${createHash("sha256").update([
    dispatch.tenant, dispatch.service, dispatch.journey, dispatch.probeType, dispatch.testId,
  ].join("\0")).digest("hex").slice(0, 35)}`;
}

/** Enumerates one dispatchable case per selected journey target, plus independent provider collection. */
function serviceDispatchLanes(
  document: ProjectDocument, tenantAlias: string, serviceType: ServiceType, configSha256: string,
): DispatchLane[] {
  const project = selectTenant(document, tenantAlias);
  const service = serviceExecution(project, serviceType);
  if (!service.enabled) return [];
  const selectedScenarios = project.services[serviceType].scenarios;
  const selectedJourneys = new Set(Object.entries(selectedScenarios)
    .flatMap(([journey, enabled]) => enabled ? [journey] : []));
  if (!selectedJourneys.size) return [];
  const probes = serviceProbes(service, selectedScenarios);
  const byJourney = new Map<string, typeof probes>();
  for (const probe of probes) {
    const journey = probeServices[probe.type].journey;
    if (!selectedJourneys.has(journey)) continue;
    const journeyProbes = byJourney.get(journey);
    if (journeyProbes) journeyProbes.push(probe);
    else byJourney.set(journey, [probe]);
  }
  const lanes: DispatchLane[] = [];
  for (const lane of executionLanes(service)) {
    for (const journey of lane.journeys.filter(item => selectedJourneys.has(item))) {
      for (const probe of byJourney.get(journey) ?? []) {
        lanes.push({
          name: `${tenantAlias}/${serviceType}/${journey}/${probe.id}`,
          tenant: tenantAlias,
          service: serviceType,
          lane: caseLaneId({ tenant: tenantAlias, service: serviceType, journey, probeType: probe.type, testId: probe.id }),
          journey,
          probeType: probe.type,
          testId: probe.id,
          intervalSeconds: lane.intervalSeconds,
          timeoutSeconds: lane.timeoutSeconds,
          journeys: [journey],
          provider: false,
          configSha256,
          alignToInterval: true,
        });
      }
    }
  }
  if (hasProviderSources(service)) {
    lanes.push({
      name: `${tenantAlias}/${serviceType}/provider-context`,
      tenant: tenantAlias,
      service: serviceType,
      lane: "provider-context",
      journey: "provider-context",
      intervalSeconds: service.providerIntervalSeconds,
      timeoutSeconds: service.providerIntervalSeconds - service.publicationTimeoutSeconds - service.slotMarginSeconds,
      journeys: [],
      provider: true,
      configSha256,
      alignToInterval: true,
    });
  }
  return lanes;
}

/** Identifies one execution owner independently of configuration changes and schedule slots. */
export function laneInstanceId(dispatch: Pick<LaneDispatch, "tenant" | "service" | "lane">): string {
  return `lane-${createHash("sha256").update([dispatch.tenant, dispatch.service, dispatch.lane].join("\0")).digest("hex").slice(0, 40)}`;
}

/** Gives duplicate deliveries of one configured slot the same result/observation correlation. */
export function dispatchRunId(dispatch: LaneDispatch): string {
  const bytes = createHash("sha256").update([
    dispatch.tenant, dispatch.service, dispatch.lane, dispatch.slot, dispatch.configSha256,
  ].join("\0")).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Rejects mismatched configuration, disabled lanes, unaligned slots and startup-capacity shortfalls. */
export function selectDispatch(
  document: ProjectDocument, dispatch: LaneDispatch, expectedConfigSha256: string, now = Date.now(),
): SelectedLane {
  if (dispatch.configSha256 !== expectedConfigSha256) throw new ConfigurationError("Dispatch configuration does not match the deployed snapshot");
  const project = selectTenant(document, dispatch.tenant);
  const service = serviceExecution(project, dispatch.service);
  if (!service.enabled) throw new ConfigurationError("Dispatch service is disabled");
  const lane = serviceDispatchLanes(document, dispatch.tenant, dispatch.service, expectedConfigSha256)
    .find(candidate => candidate.lane === dispatch.lane &&
      candidate.journey === dispatch.journey &&
      candidate.provider === dispatch.provider &&
      (candidate.provider || candidate.probeType === dispatch.probeType && candidate.testId === dispatch.testId));
  if (!lane) throw new ConfigurationError("Dispatch lane is not selected");
  if (dispatch.slot % (lane.intervalSeconds * 1000) !== 0 || dispatch.slot > now) {
    throw new ConfigurationError("Dispatch slot is not aligned or is in the future");
  }
  if (lane.provider) {
    if (now >= dispatch.slot + lane.timeoutSeconds * 1000) throw new ConfigurationError("Provider dispatch is stale");
  } else laneBudget(service, lane, dispatch.slot, now);
  return { project, service, lane, provider: lane.provider };
}

/** Enumerates only root-selected synthetic and independent provider schedules for the coordinator. */
export function dispatchInventory(document: ProjectDocument, configSha256: string) {
  return document.tenants.flatMap(tenant =>
    services.flatMap(service => serviceDispatchLanes(document, tenant.id, service, configSha256)));
}

/** Allows two schedule slots and three watchdog checks for execution and ingestion before alerting. */
export function laneFreshnessSeconds(document: ProjectDocument, lane: Pick<ExecutionLane, "intervalSeconds">): number {
  if (!document.deployment) throw new ConfigurationError("Lane freshness requires root deployment settings");
  return 2 * lane.intervalSeconds + 3 * document.deployment.functions.watchdogIntervalSeconds;
}

/** Constructs one bounded, root-correlated start request, never an execution payload or result channel. */
export function createDispatch(
  lane: ReturnType<typeof dispatchInventory>[number], now = Date.now(),
): LaneDispatch {
  const base = {
    tenant: lane.tenant, service: lane.service, lane: lane.lane, configSha256: lane.configSha256,
    slot: Math.floor(now / (lane.intervalSeconds * 1000)) * lane.intervalSeconds * 1000,
    attemptId: randomUUID(),
  };
  return lane.provider ? { ...base, provider: true, journey: lane.journey } : {
    ...base, provider: false, journey: lane.journey, probeType: lane.probeType, testId: lane.testId,
  };
}
