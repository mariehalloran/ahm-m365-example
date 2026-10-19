import type { History } from "../../health-model/src/policy.js";
import type { StateStore } from "../src/state.js";

export class MemoryStateStore implements StateStore {
  private state: History = {};
  async load(): Promise<History> { return structuredClone(this.state); }
  async save(history: History): Promise<void> { this.state = structuredClone(history); }
}
