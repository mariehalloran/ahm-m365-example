import { reportedResult, resultSchema, type SyntheticResult, type Telemetry } from "./contracts.js";
import { providerLog, type ProviderDiagnostic } from "./provider-diagnostics.js";

export type ExecutionMode = "simulation" | "live";
export type Outcome = "success" | "failure" | "unexecutable";
export interface CycleResults { cycleId: string; results: SyntheticResult[]; signal?: AbortSignal }
export type CyclePublisher = (cycle: CycleResults) => Promise<void>;
export interface ResultContext {
  tenant: string;
  user?: string;
  peer?: string;
  groups: { id: string; displayName: string }[];
}
export interface ResultOutput {
  record(result: SyntheticResult, mode: ExecutionMode): void;
  recordDiagnostic(record: ProviderDiagnostic): void;
}

export function outcomeOf(result: SyntheticResult): Outcome {
  if (result.success) return "success";
  return [
    "authentication-failure", "permission-failure", "collector-failure", "configuration-failure",
    "malformed-response", "graph-throttling", "cancelled",
  ].includes(result.diagnosticCategory ?? "") ? "unexecutable" : "failure";
}

export function createResultOutput(output: Telemetry): ResultOutput {
  return {
    record(raw, mode) {
      const result = reportedResult(resultSchema.parse(raw));
      output.emit("synthetic-result", { mode, outcome: outcomeOf(result), result });
    },
    recordDiagnostic(record) {
      output.emit("provider-diagnostic", providerLog(record));
    },
  };
}
