import { z } from "zod";

const subscription = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const resourceGroup = "[a-z0-9_().-]{1,90}";
const resourceId = (provider: string, type: string, name: string) => z.string().regex(
  new RegExp(`^/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/${provider}/${type}/${name}$`, "i"),
);
export const managedIdentityResourceId = resourceId("Microsoft\\.ManagedIdentity", "userAssignedIdentities", "[a-z0-9_-]{3,128}");
export const botResourceId = resourceId("Microsoft\\.BotService", "botServices", "[a-z0-9_.-]{2,64}");
export const applicationAccessSchema = z.object({
  m365TenantId: z.string().uuid().optional(),
  m365ClientId: z.string().uuid().optional(),
  m365CertificateSource: z.enum(["key-vault", "container-app"]).optional(),
  m365CertificateSecretUri: z.string().regex(
    /^https:\/\/[a-zA-Z0-9-]+\.vault\.azure\.net\/secrets\/[a-zA-Z0-9-]+(?:\/[a-zA-Z0-9]+)?$/,
  ).optional(),
  m365CertificateRevision: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  m365CertificateEnvironmentVariable: z.string().regex(/^[A-Z_][A-Z0-9_]{0,127}$/).optional(),
  m365CertificatePath: z.string().min(1).optional(),
}).strict();
export const teamsBotPairSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).max(30),
  botResourceId,
  identityResourceId: managedIdentityResourceId,
  botClientId: z.string().uuid().optional(),
  botPeerResourceId: botResourceId,
  botPeerManagedIdentityResourceId: managedIdentityResourceId,
  botPeerClientId: z.string().uuid().optional(),
}).strict();
export const workerSettingsSchema = z.object({
  appName: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).min(2).max(32),
  identityResourceId: managedIdentityResourceId.optional(),
  identityName: z.string().regex(/^[a-zA-Z0-9_-]{3,128}$/).optional(),
  identityClientId: z.string().uuid().optional(),
  cpu: z.number().min(0.25).max(4).multipleOf(0.25).default(0.25),
  memory: z.enum(["0.5Gi", "1Gi", "1.5Gi", "2Gi", "3Gi", "4Gi", "6Gi", "8Gi"]).default("0.5Gi"),
}).strict();
export const deploymentSettingsSchema = z.object({
  location: z.string().regex(/^[a-z][a-z0-9]{1,39}$/),
  configurationStorageAccount: z.string().regex(/^[a-z0-9]{3,24}$/),
  healthModelLocation: z.string().regex(/^[a-z][a-z0-9]{1,39}$/).optional(),
  azureTenantId: z.string().uuid(),
  stage: z.enum(["foundation", "workers"]).default("workers"),
  enableLiveProbes: z.boolean().default(false),
  enableBetaServiceActivity: z.boolean().default(false),
  foundation: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("existing"),
      environmentResourceId: resourceId("Microsoft\\.App", "managedEnvironments", "[a-z0-9-]{2,60}"),
      registryResourceId: resourceId("Microsoft\\.ContainerRegistry", "registries", "[a-z0-9]{5,50}"),
    }).strict(),
    z.object({
      mode: z.literal("create"),
      environmentName: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/).min(2).max(60),
      registryName: z.string().regex(/^[a-zA-Z0-9]{5,50}$/),
    }).strict(),
  ]),
  image: z.discriminatedUnion("mode", [
    z.object({
      mode: z.literal("existing"),
      reference: z.string().regex(/^[a-z0-9][a-z0-9.-]+(?::\d+)?\/[a-z0-9][a-z0-9/._-]*@sha256:[a-f0-9]{64}$/),
    }).strict(),
    z.object({
      mode: z.literal("build"),
      repository: z.string().regex(/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/),
      tag: z.string().regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,127}$/),
      platform: z.literal("linux/amd64").default("linux/amd64"),
    }).strict(),
  ]),
  workspaceName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{2,61}[a-zA-Z0-9]$/).optional(),
  applicationInsightsName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,258}[a-zA-Z0-9]$/).optional(),
  commandTimeoutSeconds: z.number().int().min(30).max(7200).default(1800),
  rolloutTimeoutSeconds: z.number().int().min(30).max(1800).default(300),
  retireEntities: z.array(z.object({
    service: z.enum(["exchange", "teams", "onedrive"]),
    entityName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{1,258}[a-zA-Z0-9]$/),
  }).strict()).max(100).default([]),
  stateDirectory: z.string().regex(/^\.[a-z][a-z0-9-]{0,60}$/).default(".monitoring-deployment"),
}).strict();
export type DeploymentSettings = z.infer<typeof deploymentSettingsSchema>;
export type ApplicationAccess = z.infer<typeof applicationAccessSchema>;
