import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { SyntheticResult } from "../../../shared/src/contracts.js";
import { categoryOf, IntegrationError } from "../../../shared/src/http.js";
import { baseResult, type ProbeHandler } from "../../../shared/src/probes.js";

const messageSchema = z.object({ id: z.string().min(1) });
const messageListSchema = z.object({
  value: z.array(messageSchema),
  "@odata.nextLink": z.string().optional(),
});

export const exchangeProbe: ProbeHandler = async (probe, context) => {
  if (!context.graph || !probe.mailbox) {
    throw new IntegrationError("collector-failure");
  }

  const { graph, config, signal, telemetry, now = Date.now } = context;
  const sleep = context.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }));
  const startedAt = now();
  const result = baseResult(probe, startedAt);
  const subject = `AHM synthetic ${result.correlationId}`;
  const messageQuery = new URLSearchParams({
    "$filter": `subject eq '${subject}'`,
    "$select": "id",
    "$top": "100",
  });
  const mailboxPath = `/users/${encodeURIComponent(probe.mailbox)}`;
  const messagesPath = `${mailboxPath}/messages`;
  const inboxSearchPath = `${mailboxPath}/mailFolders/inbox/messages?${messageQuery}`;
  const ownedMessagesSearchPath = `${messagesPath}?${messageQuery}`;
  const ownedMessageIds = new Set<string>();

  let sendSubmitted = false;
  let mailboxMutationAttempted = false;
  let stage: NonNullable<SyntheticResult["diagnosticContext"]["testStage"]> = "authentication";

  try {
    await graph.authenticate(signal);
    result.diagnosticContext.authenticationDurationMs = Math.max(0, now() - startedAt);

    stage = "send";
    mailboxMutationAttempted = true;
    const draft = await graph.json(messagesPath, messageSchema, signal, "POST", {
      subject,
      body: { contentType: "Text", content: "Dedicated synthetic probe. Safe to delete." },
      toRecipients: [{ emailAddress: { address: probe.mailbox } }],
      internetMessageHeaders: [{ name: "x-ahm-correlation-id", value: result.correlationId }],
    }, false);
    ownedMessageIds.add(draft.id);

    const sendPath = `${messagesPath}/${encodeURIComponent(draft.id)}/send`;
    const sendStartedAt = now();
    await graph.request(sendPath, signal, "POST", undefined, false);
    sendSubmitted = true;

    stage = "poll";
    while (!signal.aborted && now() - startedAt < config.PROBE_TIMEOUT_MS) {
      const inbox = await graph.json(inboxSearchPath, messageListSchema, signal);
      for (const message of inbox.value) {
        ownedMessageIds.add(message.id);
      }

      if (inbox.value.length > 0) {
        result.success = true;
        result.deliveryDurationMs = Math.max(0, now() - sendStartedAt);
        stage = "delivery-confirmed";
        break;
      }

      await sleep(config.POLL_INTERVAL_MS, signal);
    }

    if (!result.success) {
      result.diagnosticCategory = "delivery-timeout";
    }
  } catch (error) {
    const category = categoryOf(error);
    if (category === "cancelled" && sendSubmitted) {
      result.diagnosticCategory = "delivery-timeout";
    } else if (category === "graph-unavailable") {
      result.diagnosticCategory = stage === "send" ? "send-failure" : "read-failure";
    } else {
      result.diagnosticCategory = category;
    }

    if (error instanceof IntegrationError && error.status) {
      result.diagnosticContext.httpStatus = error.status;
    }
    telemetry.emit("probe-stage-failed", {
      testId: probe.id,
      correlationId: result.correlationId,
      stage,
      category: result.diagnosticCategory,
    });
  } finally {
    const cleanupSignal = AbortSignal.timeout(10000);
    try {
      if (!mailboxMutationAttempted) {
        result.diagnosticContext.cleanupSucceeded = true;
      } else {
        // Query only this run's unguessable subject, including a sent copy whose ID may have changed.
        const copies = await graph.json(ownedMessagesSearchPath, messageListSchema, cleanupSignal);
        if (copies["@odata.nextLink"]) {
          throw new IntegrationError("cleanup-failure");
        }
        for (const message of copies.value) {
          ownedMessageIds.add(message.id);
        }
        for (const messageId of ownedMessageIds) {
          const deletePath = `${messagesPath}/${encodeURIComponent(messageId)}`;
          await graph.request(deletePath, cleanupSignal, "DELETE");
        }
        result.diagnosticContext.cleanupSucceeded = true;
      }
    } catch (error) {
      telemetry.emit("probe-cleanup-failed", {
        testId: probe.id,
        correlationId: result.correlationId,
        category: categoryOf(error),
      });
      result.diagnosticContext.cleanupSucceeded = false;
      if (result.success) {
        result.success = false;
        result.diagnosticCategory = "cleanup-failure";
      }
    }
  }

  result.observedAt = new Date(now()).toISOString();
  result.durationMs = Math.max(0, now() - startedAt);
  result.diagnosticContext.testStage = stage;
  return result;
};
