import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TokenCredential } from "@azure/identity";
import { BlobServiceClient } from "@azure/storage-blob";
import { historySchema, type History } from "./policy.js";

export interface StateStore {
  load(): Promise<History>;
  save(history: History): Promise<void>;
}
export class MemoryStateStore implements StateStore {
  private state: History = {};
  async load(): Promise<History> { return structuredClone(this.state); }
  async save(history: History): Promise<void> { this.state = structuredClone(history); }
}
export class FileStateStore implements StateStore {
  constructor(private readonly file: string) {}
  async load(): Promise<History> {
    try { return historySchema.parse(JSON.parse(await readFile(this.file, "utf8"))); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
      throw error;
    }
  }
  async save(history: History): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(historySchema.parse(history)), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
export class BlobStateStore implements StateStore {
  private etag: string | undefined;
  private readonly container;
  private readonly blob;
  constructor(url: string, credential: TokenCredential) {
    const endpoint = new URL(url);
    if (endpoint.protocol !== "https:" || !endpoint.hostname.endsWith(".blob.core.windows.net") || endpoint.search) {
      throw new Error("State storage must use an Azure public-cloud blob endpoint without credentials");
    }
    this.container = new BlobServiceClient(url, credential).getContainerClient("synthetic-state");
    this.blob = this.container.getBlockBlobClient("aggregation.json");
  }
  async load(): Promise<History> {
    await this.container.createIfNotExists();
    try {
      const response = await this.blob.download();
      this.etag = response.etag;
      if (!response.readableStreamBody) throw new Error("State blob has no body");
      const parts: Buffer[] = [];
      for await (const part of response.readableStreamBody) parts.push(Buffer.from(part));
      return historySchema.parse(JSON.parse(Buffer.concat(parts).toString("utf8")));
    } catch (error) {
      if (error instanceof Error && "statusCode" in error && error.statusCode === 404) { this.etag = undefined; return {}; }
      throw error;
    }
  }
  async save(history: History): Promise<void> {
    const text = JSON.stringify(historySchema.parse(history));
    const response = await this.blob.upload(text, Buffer.byteLength(text), {
      conditions: this.etag ? { ifMatch: this.etag } : { ifNoneMatch: "*" },
      blobHTTPHeaders: { blobContentType: "application/json" },
    });
    this.etag = response.etag;
  }
}
