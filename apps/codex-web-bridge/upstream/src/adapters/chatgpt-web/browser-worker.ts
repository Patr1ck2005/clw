import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { skillFileTokens, validateSkillFiles } from "./skill-attachments";
import { chatGptUsageModelFromAnnouncements, detectChatGptLimitsPlan, readChatGptUsageAccount, readChatGptUsageModel, supportsChatGptUsageTracking, type ChatGptUsageModel } from "./limits";
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request, type Response } from "playwright-core";
import {
  atomicWriteFile,
  CHATGPT_CONNECTOR_NAME,
  defaultChromeExecutable,
  DEV_CHATGPT_CONNECTOR_NAME,
  expandUserPath,
  getConfigDir,
  isLegacyChatGptConnectorName,
  legacyChatGptConnectorMigrationMessage,
  LEGACY_CHATGPT_CONNECTOR_NAMES,
} from "../../config";
import { estimateTokens } from "../../lib/token-estimate";
import { CHATGPT_STOPPED_THINKING_LABELS } from "./ui-labels";
import type { CodexProviderConfig } from "../../types";
import { parseDataUrl } from "../image";
import {
  ChatGptMarkdownBuffer,
  ChatGptMarkdownConsistencyError,
  type ChatGptMarkdownSegment,
} from "./markdown";
import {
  CHATGPT_WEB_LUNA_MODEL_ID,
  CHATGPT_WEB_MODEL_ID,
  resolveChatGptWebModelMode,
  type ChatGptWebCapabilities,
  type ChatGptWebModelMode,
} from "./model";
import {
  CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET,
  compiledChatGptWebMaxMessageChars,
  estimateChatGptWebImageTokens,
  estimateCompiledChatGptWebMessageTokens,
} from "./input-tokens";
import {
  CHATGPT_MAX_INPUT_IMAGES,
  formatChatGptWebMultipartCommit,
  formatChatGptWebMultipartStage,
  isChatGptWebMultipartPartCount,
  type CompiledChatGptWebPrompt,
  type ChatGptWebPromptImage,
  type ChatGptWebMultipartStage,
} from "./prompt";
import { estimateCompiledChatGptWebInputTokens } from "./input-tokens";
import {
  assertAuthenticatedChatGptPage,
  assertNewChatPage,
  chatGptNewChatUrl,
  chatGptAssistantTurnSelector,
  CHATGPT_ASSISTANT_TURN_SELECTOR,
  CHATGPT_COMPLETION_ACTION_SELECTOR,
  CHATGPT_COMPOSER_SELECTOR,
  CHATGPT_EFFORT_CONTROL_SELECTOR,
  CHATGPT_EFFORT_ITEM_SELECTOR,
  CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
  CHATGPT_STOP_BUTTON_SELECTOR,
  CHATGPT_SEND_BUTTON_SELECTOR,
  CHATGPT_USER_TURN_SELECTOR,
  activateChatGptEffortMenu,
  detectChatGptAccountCapabilities,
  readChatGptEffortSnapshot,
  parseChatGptEffortSliderState,
} from "../../chatgpt-session";
import { loginVerificationMarkerPath } from "../../browser-login";
import {
  connectLauncherBrowserHost,
  LauncherBrowserTurnCancelledError,
  LauncherRetainedConversationUnavailableError,
  LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS,
  LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS,
  notifyLauncherTurn,
} from "../../launcher-browser-host";
import {
  CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER,
  resolveChatGptWebContextLimits,
  resolveChatGptWebMessageTokenBudget,
  resolveChatGptWebTransportLimits,
} from "../../chatgpt-web-models";
import { LauncherBrowserHelperClient } from "./launcher-helper-client";
import { assertChatGptModelFamily, chatGptModelFamilyMatches, selectChatGptModelFamily } from "./model-selection";
import { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";
import {
  ChatGptCompactionHandoffAccepted,
  ChatGptWebAdapterError,
  chatGptBrowserTabClosedError,
  chatGptRetainedConversationUnavailableError,
  chatGptStoppedThinkingError,
} from "./adapter-error";
import {
  ChatGptLunaCheckpointStream,
  type CapturedChatGptLunaCheckpoint,
} from "./rolling-checkpoint";
import {
  chatGptExternalProgressIsLive,
  chatGptExternalToolCallsAreInFlight,
} from "./turn-progress";
import type {
  ChatGptExternalTurnProgressSnapshot,
  ChatGptTurnProgressReader,
} from "./turn-progress";

export { MAX_CHATGPT_BROWSER_TABS } from "./concurrency";

const workers = new Map<string, ChatGptBrowserWorker>();

export async function closeChatGptBrowserWorkers(): Promise<void> {
  const active = [...workers.values()];
  workers.clear();
  const results = await Promise.allSettled(active.map(worker => worker.close()));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map(result => result.reason);
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} ChatGPT browser worker(s) failed to close`);
  }
}

export const CHATGPT_RESPONSE_DOM_GRACE_MS = 60_000;
/**
 * How long a staged Bigger Context part may take to produce its assistant turn. A staged part is two
 * orders of magnitude larger than an ordinary prompt and ChatGPT reads all of it before answering.
 * No MCP activity exists while that inert part is being ingested, so the response grace matches
 * the bounded staged-send budget.
 */
export const CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS = 180_000;
export const CHATGPT_EMPTY_RESPONSE_GRACE_MS = 10_000;
export const CHATGPT_COMPLETION_ACTION_GRACE_MS = 60_000;
export const CHATGPT_COMPLETION_SETTLE_MS = 2_000;
export const CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS = 60_000;
export const MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS = 3;
const CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS = 10_000;
const CHATGPT_SMOKE_TEXT = "Reply with exactly: CODEX WEB GPT READY";
const CHATGPT_SMOKE_EXPECTED = "CODEX WEB GPT READY";
/**
 * ChatGPT applies composer state asynchronously, and a fast host can reach the next step before the
 * editor has taken the previous one. This is headroom for that, not a readiness check.
 */
export const CHATGPT_UI_SETTLE_MS = 250;
export const CHATGPT_SEND_ENABLE_GRACE_MS = 5_000;

const CHATGPT_DOM_REVISION_ATTRIBUTES = [
  "aria-hidden",
  "aria-label",
  "aria-busy",
  "aria-disabled",
  "aria-expanded",
  "class",
  "data-item-anchor",
  "data-is-last-node",
  "data-message-author-role",
  "data-state",
  "data-streaming-response-status",
  "data-testid",
  "data-turn",
  "data-turn-id",
  "data-turn-id-container",
  "data-turn-key",
  "data-conversation-role",
  "data-chatgpt-agent-turn-start",
  "data-content-search-unit-key",
  "data-user-message-bubble",
  "data-markdown-text-style",
  "data-markdown-text-tone",
  "disabled",
  "hidden",
  "inert",
  "open",
  "role",
  "start",
  "style",
] as const;

const settleChatGptUi = (): Promise<void> => (
  new Promise(resolveSettle => setTimeout(resolveSettle, CHATGPT_UI_SETTLE_MS))
);

class ChatGptConnectorCatalogStaleError extends Error {
  constructor(
    readonly appName: string,
    readonly triggerAttempts: number,
  ) {
    super(`ChatGPT connector catalog is missing ${JSON.stringify(appName)}`);
    this.name = "ChatGptConnectorCatalogStaleError";
  }
}

interface ChatGptConnectorAttemptBudget {
  triggerAttempts: number;
}

function chatGptConnectorUnavailableError(message: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(message, {
    status: 424,
    errorType: "connector_error",
    code: "connector_not_found",
    retryable: false,
  });
}

const CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE = "ChatGPT model controls are unavailable. Reload ChatGPT and retry the task.";

function chatGptModelControlUnavailableError(diagnostic: string): Error {
  return new Error(CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE, { cause: new Error(diagnostic) });
}

function chatGptModelControlUnavailableAdapterError(diagnostic: string, detail?: string): ChatGptWebAdapterError {
  return new ChatGptWebAdapterError(
    detail ? `${CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE} ChatGPT: ${detail}` : CHATGPT_MODEL_CONTROL_UNAVAILABLE_MESSAGE,
    {
      status: 502,
      errorType: "server_error",
      code: "upstream_server_error",
      retryable: false,
      cause: new Error(diagnostic),
    },
  );
}

export async function chatGptUnavailableProDetail(menu: Locator): Promise<string | undefined> {
  // Pro is the product label in the picker. Its linked tooltip supplies the site's own
  // localized explanation/date; do not search the conversation or infer a reset time.
  const rows = menu.getByRole("menuitemradio", { name: "Pro", exact: true }).filter({ visible: true });
  try {
    if (await rows.count() !== 1 || await rows.getAttribute("aria-disabled") !== "true") return undefined;
    await rows.hover({ timeout: 1_500 });
    return await rows.evaluate(async element => {
      const deadline = Date.now() + 1_000;
      do {
        const ids = element.getAttribute("aria-describedby")?.trim().split(/\s+/).filter(Boolean) ?? [];
        const tooltips = ids.map(id => document.getElementById(id))
          .filter((node): node is HTMLElement => node instanceof HTMLElement && node.getAttribute("role") === "tooltip");
        const visible = tooltips.filter(node => {
          for (let current: HTMLElement | null = node; current; current = current.parentElement) {
            const style = getComputedStyle(current);
            if (!current.isConnected || current.hidden || current.getAttribute("aria-hidden") === "true"
              || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
          }
          return true;
        });
        if (visible.length === 1) {
          const text = visible[0]!.textContent?.replace(/\s+/g, " ").trim();
          if (text && text.length <= 512) return text;
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      return undefined;
    }, undefined, { timeout: 1_500 });
  } catch {
    // Optional UI detail must not replace the existing model-unavailable error.
    return undefined;
  }
}

export type ChatGptPersonalizationPreflight = "already-personalized" | "enabled";

const CHATGPT_PERSONALIZATION_CONTROL_SELECTOR = [
  '[data-testid="thread-header-right-actions"] [aria-haspopup="menu"]',
  '#conversation-header-actions [aria-haspopup="menu"]',
  '[data-content-sheet-root] > button[aria-expanded][aria-controls]',
].join(", ");
const CHATGPT_PERSONALIZATION_CHOICE_SELECTOR = '[role="menuitemradio"], [role="radio"]';
const CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS = 30_000;
const CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS = 30_000;

class ChatGptPersonalizationDeadlineError extends Error {
  constructor() {
    super("ChatGPT personalization preflight exceeded its readiness deadline");
    this.name = "ChatGptPersonalizationDeadlineError";
  }
}

class ChatGptPersistentBrowserStateError extends AggregateError {
  constructor(errors: Iterable<unknown>, message: string) {
    super(errors, message);
    this.name = "ChatGptPersistentBrowserStateError";
  }
}

function remainingChatGptPersonalizationMs(deadline: number, signal?: AbortSignal): number {
  if (signal?.aborted) throw new DOMException("ChatGPT personalization preflight aborted", "AbortError");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ChatGptPersonalizationDeadlineError();
  return remaining;
}

async function runChatGptPersonalizationStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal?: AbortSignal,
): Promise<T> {
  const timeoutMs = remainingChatGptPersonalizationMs(deadline, signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await withBrowserTurnAbort(Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptPersonalizationDeadlineError()), timeoutMs);
      }),
    ]), signal);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Mutating personalization work owns its AbortSignal and must settle its cleanup before the caller
 * can observe cancellation. Unlike observation races, returning early here could release the page
 * while a rollback or composer clear was still running against the persistent browser profile.
 */
async function runChatGptPersonalizationOwnedStep<T>(
  operation: () => Promise<T>,
  deadline: number,
  signal: AbortSignal,
): Promise<T> {
  remainingChatGptPersonalizationMs(deadline, signal);
  const result = await operation();
  remainingChatGptPersonalizationMs(deadline, signal);
  return result;
}

async function waitForChatGptPersonalizationPoll(
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await new Promise(resolve => setTimeout(resolve, timeoutMs));
    return;
  }
  if (signal.aborted) throw new DOMException("ChatGPT personalization preflight aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, timeoutMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new DOMException("ChatGPT personalization preflight aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runChatGptPersonalizationCleanup<T>(
  operation: (deadline: number, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const deadline = Date.now() + CHATGPT_PERSONALIZATION_CLEANUP_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  timer.unref?.();
  try {
    return await operation(deadline, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function pressChatGptPersonalizationEscape(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<void> {
  await page.locator("body").press("Escape", {
    timeout: remainingChatGptPersonalizationMs(deadline, signal),
    signal,
  });
}

async function dismissChatGptPersonalizationMenu(page: Page): Promise<void> {
  await runChatGptPersonalizationCleanup((deadline, signal) => (
    pressChatGptPersonalizationEscape(page, deadline, signal)
  ));
}

async function waitForChatGptOwnedPersonalizationMenu(
  page: Page,
  control: Locator,
  deadline: number,
  signal?: AbortSignal,
): Promise<Locator> {
  let menuId: string | null = null;
  while (!menuId) {
    const remaining = remainingChatGptPersonalizationMs(deadline, signal);
    menuId = await control.getAttribute("aria-controls", { timeout: remaining, signal });
    if (!menuId) await waitForChatGptPersonalizationPoll(Math.min(50, remaining), signal);
  }
  const menu = page.locator(`[id=${JSON.stringify(menuId)}]`);
  try {
    await menu.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization control did not expose its owned menu before the readiness deadline",
    );
  }
  return menu;
}

type ChatGptPersonalizationChoiceIndex = 0 | 1;

interface ChatGptPersonalizationState {
  menu: Locator;
  choices: Locator;
  checkedIndex: ChatGptPersonalizationChoiceIndex;
}

interface ChatGptPersonalizationToggleReceipt {
  originalIndex: ChatGptPersonalizationChoiceIndex;
}

async function readChatGptPersonalizationCheckedIndex(
  choices: Locator,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationChoiceIndex> {
  const checked: boolean[] = [];
  for (let index = 0; index < 2; index += 1) {
    const choice = choices.nth(index);
    const ariaChecked = await choice.getAttribute("aria-checked", {
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    const dataState = await choice.getAttribute("data-state", {
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    checked.push(ariaChecked === "true" || dataState === "checked");
  }
  if (checked.filter(Boolean).length !== 1) {
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization menu did not expose one checked state",
    );
  }
  return checked[0] ? 0 : 1;
}

async function openChatGptStructuralPersonalizationState(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationState> {
  const controls = page.locator(CHATGPT_PERSONALIZATION_CONTROL_SELECTOR).filter({ visible: true });
  const control = controls.first();
  try {
    await control.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT Temporary Chat did not expose a structural personalization control before the readiness deadline",
    );
  }
  const controlCount = await runChatGptPersonalizationStep(() => controls.count(), deadline, signal);
  if (controlCount !== 1) {
    throw chatGptConnectorUnavailableError(
      `ChatGPT Temporary Chat exposed ${controlCount} structural personalization controls; expected exactly one`,
    );
  }
  await control.click({
    timeout: remainingChatGptPersonalizationMs(deadline, signal),
    signal,
  });
  const menu = await waitForChatGptOwnedPersonalizationMenu(page, control, deadline, signal);
  const choices = menu.locator(CHATGPT_PERSONALIZATION_CHOICE_SELECTOR).filter({ visible: true });
  if (await runChatGptPersonalizationStep(() => choices.count(), deadline, signal) !== 2) {
    throw chatGptConnectorUnavailableError(
      "ChatGPT personalization menu did not expose exactly two checkable states",
    );
  }
  return {
    menu,
    choices,
    checkedIndex: await readChatGptPersonalizationCheckedIndex(choices, deadline, signal),
  };
}

async function restoreChatGptPersonalizationChoice(
  page: Page,
  receipt: ChatGptPersonalizationToggleReceipt,
): Promise<void> {
  await runChatGptPersonalizationCleanup(async (deadline, signal) => {
    await pressChatGptPersonalizationEscape(page, deadline, signal);
    let state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    if (state.checkedIndex === receipt.originalIndex) {
      await pressChatGptPersonalizationEscape(page, deadline, signal);
      return;
    }
    await state.choices.nth(receipt.originalIndex).click({
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await state.menu.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);

    state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    if (state.checkedIndex !== receipt.originalIndex) {
      throw new Error("ChatGPT personalization rollback did not restore the original checked state");
    }
    await pressChatGptPersonalizationEscape(page, deadline, signal);
  });
}

async function toggleChatGptPersonalizationChoice(
  page: Page,
  deadline: number,
  signal: AbortSignal,
): Promise<ChatGptPersonalizationToggleReceipt> {
  let receipt: ChatGptPersonalizationToggleReceipt | undefined;
  try {
    const state = await openChatGptStructuralPersonalizationState(page, deadline, signal);
    receipt = { originalIndex: state.checkedIndex };
    const nextIndex: ChatGptPersonalizationChoiceIndex = state.checkedIndex === 0 ? 1 : 0;
    await state.choices.nth(nextIndex).click({
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await state.menu.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, signal),
      signal,
    });
    await runChatGptPersonalizationStep(settleChatGptUi, deadline, signal);
    return receipt;
  } catch (error) {
    try {
      if (receipt) await restoreChatGptPersonalizationChoice(page, receipt);
      else await dismissChatGptPersonalizationMenu(page);
    } catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT personalization change failed and its original state could not be restored",
      );
    }
    throw error;
  }
}

async function ensureChatGptPersonalizedConnectorAccessWithinDeadline(
  page: Page,
  deadline: number,
  abortSignal: AbortSignal,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConfiguredConnectorAccess?: (signal?: AbortSignal) => Promise<boolean>,
): Promise<ChatGptPersonalizationPreflight> {
  const capture = async (checkpoint: string): Promise<void> => {
    if (!captureDiagnostic) return;
    await runChatGptPersonalizationStep(() => captureDiagnostic(checkpoint), deadline, abortSignal);
  };
  const proveConnectorAccess = async (): Promise<boolean> => {
    if (!proveConfiguredConnectorAccess) return false;
    return runChatGptPersonalizationOwnedStep(
      () => proveConfiguredConnectorAccess(abortSignal),
      deadline,
      abortSignal,
    );
  };
  // The visible sheet can be aria-hidden during hydration. Include those controls in the role
  // query but still require visibility; never select a hidden duplicate or switch locator rules.
  const personalized = page
    .getByRole("button", { name: /^(?:Personalized|个性化)$/, exact: true, includeHidden: true })
    .filter({ visible: true });
  const unpersonalized = page
    .getByRole("button", { name: /^(?:Unpersonalized|非个性化)$/, exact: true, includeHidden: true })
    .filter({ visible: true });
  let personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);
  let unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);
  if (personalizedCount === 0 && unpersonalizedCount === 0) {
    await runChatGptPersonalizationStep(settleChatGptUi, deadline, abortSignal);
    personalizedCount = await runChatGptPersonalizationStep(() => personalized.count(), deadline, abortSignal);
    unpersonalizedCount = await runChatGptPersonalizationStep(() => unpersonalized.count(), deadline, abortSignal);
    if (personalizedCount === 0 && unpersonalizedCount === 0) {
      if (!proveConfiguredConnectorAccess) {
        await capture("personalization-control-missing");
        throw chatGptConnectorUnavailableError(
          "ChatGPT Temporary Chat did not expose a verifiable personalization control",
        );
      }
      if (await proveConnectorAccess()) {
        await capture("personalization-already-enabled");
        return "already-personalized";
      }
      await capture("personalization-unpersonalized");
      const toggleReceipt = await toggleChatGptPersonalizationChoice(page, deadline, abortSignal);
      try {
        if (await proveConnectorAccess()) {
          await capture("personalization-enabled");
          return "enabled";
        }
      } catch (error) {
        try {
          await restoreChatGptPersonalizationChoice(page, toggleReceipt);
        } catch (restoreError) {
          throw new ChatGptPersistentBrowserStateError(
            [error, restoreError],
            "ChatGPT personalization proof failed and the original state could not be restored",
          );
        }
        throw error;
      }
      try {
        await restoreChatGptPersonalizationChoice(page, toggleReceipt);
      } catch (restoreError) {
        throw new ChatGptPersistentBrowserStateError(
          [restoreError],
          "ChatGPT personalization changed but connector access was not proven and the original state could not be restored",
        );
      }
      throw chatGptConnectorUnavailableError(
        "The configured ChatGPT connector remained unavailable after the structural personalization state changed",
      );
    }
  }
  if (personalizedCount === 1 && unpersonalizedCount === 0) {
    await capture("personalization-already-enabled");
    return "already-personalized";
  }
  if (personalizedCount !== 0 || unpersonalizedCount !== 1) {
    throw chatGptConnectorUnavailableError(
      `ChatGPT exposed an invalid Temporary Chat personalization state`
      + ` (personalized=${personalizedCount}, unpersonalized=${unpersonalizedCount})`,
    );
  }

  await capture("personalization-unpersonalized");
  await unpersonalized.click({
    timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
    signal: abortSignal,
  });
  try {
    const menu = await waitForChatGptOwnedPersonalizationMenu(
      page,
      unpersonalized,
      deadline,
      abortSignal,
    );
    const choice = menu
      .locator(CHATGPT_PERSONALIZATION_CHOICE_SELECTOR)
      .filter({ hasText: /^(?:Personalized|个性化)/ });
    if (await runChatGptPersonalizationStep(() => choice.count(), deadline, abortSignal) !== 1) {
      throw chatGptConnectorUnavailableError(
        "ChatGPT personalization menu did not expose one exact Personalized choice",
      );
    }
    await choice.click({
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
    await personalized.waitFor({
      state: "visible",
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
    await unpersonalized.waitFor({
      state: "hidden",
      timeout: remainingChatGptPersonalizationMs(deadline, abortSignal),
      signal: abortSignal,
    });
  } catch (error) {
    try {
      await dismissChatGptPersonalizationMenu(page);
    } catch (cleanupError) {
      throw new ChatGptPersistentBrowserStateError(
        [error, cleanupError],
        "ChatGPT labeled personalization change failed and its opened menu could not be closed",
      );
    }
    if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
    throw chatGptConnectorUnavailableError(
      "ChatGPT did not confirm Personalized connector access for this Temporary Chat",
    );
  }
  await capture("personalization-enabled");
  return "enabled";
}

/** New Temporary Chats may suppress connectors until this exact browser conversation is Personalized. */
export async function ensureChatGptPersonalizedConnectorAccess(
  page: Page,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  proveConfiguredConnectorAccess?: (signal?: AbortSignal) => Promise<boolean>,
  abortSignal?: AbortSignal,
): Promise<ChatGptPersonalizationPreflight> {
  const deadline = Date.now() + CHATGPT_PERSONALIZATION_PREFLIGHT_TIMEOUT_MS;
  const deadlineController = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadlineController.abort(new ChatGptPersonalizationDeadlineError()),
    Math.max(1, deadline - Date.now()),
  );
  deadlineTimer.unref?.();
  const operationSignal = abortSignal
    ? AbortSignal.any([abortSignal, deadlineController.signal])
    : deadlineController.signal;
  try {
    return await ensureChatGptPersonalizedConnectorAccessWithinDeadline(
      page,
      deadline,
      operationSignal,
      captureDiagnostic,
      proveConfiguredConnectorAccess,
    );
  } catch (error) {
    if (error instanceof ChatGptPersistentBrowserStateError) throw error;
    if (!abortSignal?.aborted && (
      error instanceof ChatGptPersonalizationDeadlineError
      || deadlineController.signal.aborted
      || Date.now() >= deadline
    )) {
      throw chatGptConnectorUnavailableError("ChatGPT personalization preflight exceeded its readiness deadline");
    }
    throw error;
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export class ChatGptPromptAttachmentIntegrityError extends ChatGptWebAdapterError {
  constructor(message: string, cause?: unknown) {
    super(message, {
      status: 502,
      errorType: "server_error",
      code: "prompt_attachment_integrity",
      retryable: false,
      cause,
    });
    this.name = "ChatGptPromptAttachmentIntegrityError";
  }
}

const chatGptRateLimitDialog = (page: Page): Locator => page.locator('[role="dialog"]')
  .filter({ hasText: /Too many requests|太多要求|太多请求|リクエストが多すぎます|요청이 너무 많습니다|요청을 너무 빠르게|너무 많은 요청/i })
  .filter({ hasText: /making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます|요청을 너무 빠르게|요청이 너무 많습니다|너무 많은 요청/i })
  .last();

export async function throwIfChatGptRateLimitDialog(page: Page): Promise<void> {
  const dialog = chatGptRateLimitDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return;

  const acknowledge = dialog.getByRole("button", { name: /^(Got it|知道了|了解|알겠습니다|확인)$/ }).last();
  if (await acknowledge.isVisible().catch(() => false)) {
    try {
      await acknowledge.press("Enter");
    } catch (error) {
      throw new ChatGptWebAdapterError(
        `ChatGPT rate limit: too many requests, and the dialog could not be dismissed (${error instanceof Error ? error.message : String(error)}). Try again in a few minutes.`,
        { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false },
      );
    }
  }
  // Dismissing the modal does not prove the account cooldown has cleared. Keep this failure
  // replayable in the adapter so native reconnects cannot start more browser submissions.
  throw new ChatGptWebAdapterError(
    "ChatGPT rate limit: too many requests. Try again in a few minutes.",
    { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false },
  );
}

const chatGptTemporaryChatOnboardingDialog = (page: Page): Locator => page
  .locator('[role="dialog"]')
  .filter({ hasText: "Not in history" })
  .filter({ hasText: "No model training" })
  .filter({ hasText: "Memory off" })
  .last();

export async function dismissChatGptTemporaryChatOnboarding(page: Page): Promise<boolean> {
  const dialog = chatGptTemporaryChatOnboardingDialog(page);
  if (!await dialog.isVisible().catch(() => false)) return false;
  const continueButton = dialog.getByRole("button", { name: "Continue", exact: true }).last();
  if (!await continueButton.isVisible().catch(() => false)) {
    throw new Error("ChatGPT Temporary Chat onboarding is visible without its Continue action");
  }
  await continueButton.click({ force: true });
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

type ChatGptTextScope = Pick<Locator, "getByText" | "getByTestId">;

const chatGptSubscriptionFailureAlert = (page: Page): Locator => page
  .locator('[role="alert"]')
  .filter({ hasText: /Failed to load subscription/i })
  .last();

const chatGptExpiredSessionAlert = (page: Page): Locator => page
  .locator('[role="alert"], [role="dialog"]')
  .filter({ hasText: /Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i })
  .last();

export async function throwIfChatGptSessionFailureAlert(page: Page): Promise<void> {
  if (await chatGptExpiredSessionAlert(page).isVisible().catch(() => false)) {
    throw new ChatGptWebAdapterError(
      "The ChatGPT session has expired. Sign in again in Codex Web GPT.",
      { status: 401, errorType: "authentication_error", code: "chatgpt_session_expired", retryable: false },
    );
  }
  if (!await chatGptSubscriptionFailureAlert(page).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.",
    { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true },
  );
}

/** One same-page reload for the visible platform body failure; never resubmit. */
export async function recoverChatGptInvalidConversationBody(page: Pick<Page,'locator'|'url'|'reload'>,
  recovery: {reloaded:boolean}): Promise<boolean> {
  // textContent joins adjacent retry-button text without whitespace (body重试).
  const alert=page.locator('[role="alert"]').filter({hasText:/^Invalid conversation body/i}).filter({visible:true}).last();
  if(!await alert.isVisible().catch(()=>false))return false;
  if(recovery.reloaded)throw new ChatGptWebAdapterError(
    'ChatGPT still reports Invalid conversation body after reloading the original page. The original message was not resent.',
    {status:502,errorType:'server_error',code:'chatgpt_invalid_conversation_body',retryable:false});
  const url=page.url();
  if(!/^https:\/\/chatgpt\.com\/c\/[A-Za-z0-9-]+$/.test(url))throw new Error('Original conversation URL unavailable');
  recovery.reloaded=true;
  await page.reload({waitUntil:'domcontentloaded',timeout:15000});
  if(page.url()!==url)throw new Error('Original conversation changed during body-error recovery');
  return true;
}

const chatGptTerminalErrorAlert = (scope: ChatGptTextScope): Locator => scope
  .getByText(/Something went wrong[\s\S]*help\.openai\.com/i)
  .last();

// The current UI renders message_length_exceeds_limit as an ordinary response error.
// Observe only browser-issued submissions from this owned page after Send is activated;
// an old response, another tab, or a background endpoint cannot classify this turn.
export class ChatGptSubmissionRejectionObserver {
  private page?: Page;
  private readonly requests = new Set<Request>();
  private checks: Array<Promise<ChatGptWebAdapterError | undefined>> = [];

  private readonly onRequest = (request: Request): void => {
    if (!this.page || request.method() !== "POST"
      || request.url() !== "https://chatgpt.com/backend-api/f/conversation"
      || request.frame() !== this.page.mainFrame()) return;
    this.requests.add(request);
  };

  private readonly onResponse = (response: Response): void => {
    if (!this.requests.delete(response.request()) || response.status() !== 413
      || !response.headers()["content-type"]?.includes("application/json")) return;
    this.checks.push(withChatGptBrowserObservationTimeout(response.json(), 3_000)
      .then(body => body?.detail?.code === "message_length_exceeds_limit"
        ? new ChatGptWebAdapterError(
          "ChatGPT rejected this message because it exceeds the selected mode's input-size limit. Compact the task before retrying.",
          { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
        ) : undefined)
      // Unreadable or unfamiliar responses do not establish a size rejection. The normal
      // bound-response DOM error remains authoritative in that case.
      .catch(() => undefined));
  };

  begin(page: Page): void {
    this.dispose();
    this.checks = [];
    this.page = page;
    page.on("request", this.onRequest);
    page.on("response", this.onResponse);
  }

  async failure(): Promise<ChatGptWebAdapterError | undefined> {
    return (await Promise.all(this.checks)).find(error => error !== undefined);
  }

  dispose(): void {
    this.page?.off("request", this.onRequest);
    this.page?.off("response", this.onResponse);
    this.page = undefined;
    this.requests.clear();
  }
}

type SelectedChatGptWebModelMode = ChatGptWebModelMode & {
  modelFamily?: "5.6" | "6";
  selection?: { url: string; label: string };
  usageModel?: ChatGptUsageModel;
};

export async function throwIfChatGptTerminalErrorAlert(scope: ChatGptTextScope): Promise<void> {
  if (await scope.getByTestId("regenerate-thread-error-button").last().isVisible().catch(() => false)) {
    throw new ChatGptWebAdapterError(
      "ChatGPT displayed an error for this response. Check the ChatGPT tab for the exact error, then retry the turn.",
      { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
    );
  }
  if (!await chatGptTerminalErrorAlert(scope).isVisible().catch(() => false)) return;
  throw new ChatGptWebAdapterError(
    "ChatGPT ended the turn with 'Something went wrong'. Retry the turn.",
    { status: 502, errorType: "server_error", code: "upstream_server_error", retryable: true },
  );
}

/** Allow the configured app's public tool confirmations across common UI variants. */
export function operateOwnedLauncherToolConfirmation({appName,approve=false,persistent=true,expectedSignature}: {
  appName:string;approve?:boolean;persistent?:boolean;expectedSignature?:string;
}): {visible:boolean;activated:boolean;signature?:string;approval?:string|null;changed?:boolean;pending?:boolean;remaining?:number} {
  const normalize=(text:string)=>(text||"").normalize("NFKC").replace(/\s+/g," ").trim();
  const compact=(text:string)=>normalize(text).toLowerCase().replace(/[\p{P}\p{S}\s_]+/gu,"");
  const app=compact(appName||"Local-MCP");
  const visible=(element:Element)=>{const r=element.getBoundingClientRect(),s=getComputedStyle(element);return r.width>0&&r.height>0&&s.display!=="none"&&s.visibility!=="hidden";};
  const label=(button:HTMLElement)=>{const copy=button.cloneNode(true) as HTMLElement;copy.querySelectorAll('kbd,[aria-hidden="true"]').forEach(node=>node.remove());return normalize((button.getAttribute("aria-label")||"")+" "+(copy.textContent||"")).replace(/[⏎↵]+$/," ").trim();};
  const negative=/^(?:deny|decline|reject|cancel|stop|refuse|don't\s+(?:allow|approve)|do\s+not\s+(?:allow|approve)|不(?:允许|允許|同意|批准)|拒绝|拒絕|取消|停止|稍后|稍後)/i;
  const positive=/(?:allow|approv|authori[sz]|consent|grant|accept|confirm|permit|允许|允許|许可|授權|授权|批准|同意|確定|确定|確認|确认|继续|繼續)/i;
  const always=/(?:always|all\b|remember|don't ask|do not ask|始终|始終|一直|总是|總是|一律|全部|永久|不再|始終)/i;
  const allowed=(button:HTMLElement)=>{const text=label(button);return visible(button)&&!(button as HTMLButtonElement).disabled&&button.getAttribute("aria-disabled")!=="true"&&!negative.test(text)&&positive.test(text)&&!/(?:send-button|stop-button)/.test(button.getAttribute("data-testid")||"");};
  const question=(element:Element)=>{const text=normalize(element.textContent||""),key=compact(text);return (key.includes(app)||(app.startsWith("localmcp")&&key.includes("localmcp")))&&/(?:allow|approv|authori[sz]|permission|consent|grant|tool|允许|允許|许可|授權|授权|批准|同意|工具|访问|存取)/i.test(text);};
  const roots=[...document.querySelectorAll<HTMLElement>('[role="alert"],[role="dialog"],[role="alertdialog"],[data-testid*="approval"],[data-testid*="permission"]')].filter(element=>visible(element)&&question(element));
  const cards=new Set<HTMLElement>();
  for(const root of roots){let owner:HTMLElement|null=root;for(let n=0;owner&&n<6&&owner!==document.body&&owner!==document.documentElement;n++,owner=owner.parentElement){if([...owner.querySelectorAll<HTMLElement>('button,[role="button"]')].some(allowed)){cards.add(owner);break;}}}
  const candidates=[...cards].filter(card=>![...cards].some(other=>other!==card&&card.contains(other)));
  const stateKey="__CLW_TOOL_CONFIRMATION_PENDING__",saved=(globalThis as any)[stateKey];
  if(!candidates.length){if(saved)saved.pending=new WeakMap();return {visible:false,activated:false,remaining:0};}
  const card=candidates[0]!,buttons=[...card.querySelectorAll<HTMLElement>('button,[role="button"]')].filter(allowed);
  const preferred=persistent?buttons.filter(button=>always.test(label(button))):[],button=(preferred.length?preferred:buttons).sort((x,y)=>Number(y.tagName==="BUTTON")-Number(x.tagName==="BUTTON"))[0];
  const signature=JSON.stringify({appName:app,text:compact(card.textContent||""),action:button?compact(label(button)):null});
  const state={visible:true,activated:false,signature,approval:button?label(button):null,remaining:candidates.length};
  if(!approve)return state;
  if(expectedSignature&&signature!==expectedSignature)return {...state,changed:true};
  if(!card.isConnected||!button?.isConnected||!question(card))return {...state,changed:true};
  if((button as HTMLButtonElement).disabled||button.getAttribute("aria-disabled")==="true")return state;
  const memory=saved||{pending:new WeakMap()};if(!saved)Object.defineProperty(globalThis,stateKey,{value:memory,configurable:true});
  if(memory.pending.get(button)===signature)return {...state,pending:true};
  memory.pending.set(button,signature);button.click();return {...state,activated:true};
}

export async function resolveChatGptToolConfirmation(
  page: Page,
  appName: string,
  autoApprove: boolean,
  signal?: AbortSignal,
  timeoutMs = CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
  onVisible?: () => Promise<void>,
  ownedDom = false,
): Promise<boolean> {
  if(ownedDom){
    if(signal?.aborted)throw new DOMException("ChatGPT web turn aborted","AbortError");
    const inspect=()=>page.evaluate(operateOwnedLauncherToolConfirmation,{appName});
    const observed=await inspect();if(!observed.visible)return false;
    await onVisible?.();
    if(autoApprove){
      if(signal?.aborted)throw new DOMException("ChatGPT web turn aborted","AbortError");
      await page.evaluate(operateOwnedLauncherToolConfirmation,{appName,approve:true,expectedSignature:observed.signature});return true;
    }
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){
      if(signal?.aborted)throw new DOMException("ChatGPT web turn aborted","AbortError");
      if(!(await inspect()).visible)return true;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    return true; // Keep an outstanding manual confirmation; never implicitly deny it.
  }
  const dialog = page.locator('[role="dialog"], [data-testid="tool-approval-card"]')
    .filter({ hasText: `Allow ChatGPT to use ${appName}?` })
    .last();
  if (!await dialog.isVisible().catch(() => false)) return false;
  await onVisible?.();

  if (autoApprove) {
    // ChatGPT exposes either "Allow once" or the shorter "Allow" for the
    // current one-shot approval. Keep the matcher anchored so persistent
    // actions such as "Always allow" cannot match.
    const allowCurrentAction = dialog
      .getByRole("button", { name: /^Allow(?: once)?$/ })
      .last();
    await allowCurrentAction.waitFor({ state: "visible", timeout: 10_000 });
    await allowCurrentAction.press("Enter");
    return true;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (!await dialog.isVisible().catch(() => false)) return true;
    await new Promise(resolveSleep => setTimeout(resolveSleep, Math.min(100, Math.max(1, deadline - Date.now()))));
  }

  if (!await dialog.isVisible().catch(() => false)) return true;
  const deny = dialog.getByRole("button", { name: "Deny", exact: true }).last();
  await deny.waitFor({ state: "visible", timeout: 5_000 });
  await deny.press("Enter");
  await dialog.waitFor({ state: "hidden", timeout: 10_000 });
  return true;
}

export function assertChatGptWebInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  promptChars?: number,
): void {
  if (modelId !== CHATGPT_WEB_MODEL_ID && modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new Error(`ChatGPT web context limit is not defined for model: ${modelId}`);
  }
  if (
    modelId === CHATGPT_WEB_LUNA_MODEL_ID
    && estimatedInputTokens > CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET
  ) {
    throw new ChatGptWebAdapterError(
      `This Luna turn requires ${estimatedInputTokens.toLocaleString("en-US")} estimated input tokens, which exceeds the measured ${CHATGPT_LUNA_BROWSER_INPUT_TOKEN_BUDGET.toLocaleString("en-US")}-token ChatGPT Free browser transport budget. Completed Luna history is already replaced by its rolling checkpoint; the remaining payload is the current Codex turn and cannot be reduced by /compact.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  const { contextWindow } = resolveChatGptWebContextLimits(modelId, effort, capabilities);
  const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
    modelId,
    effort,
    capabilities,
  );
  if (
    browserComposerCharLimit !== undefined
    && promptChars !== undefined
    && promptChars > browserComposerCharLimit
  ) {
    throw new ChatGptWebAdapterError(
      `This prompt contains ${promptChars.toLocaleString("en-US")} inline characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary for this account and effort. Run /compact, then retry this Web model.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (browserMessageTokenLimit !== undefined && estimatedMessageTokens > browserMessageTokenLimit) {
    throw new ChatGptWebAdapterError(
      `This prompt requires ${estimatedMessageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT browser message boundary for this account and effort. The model context window is ${contextWindow.toLocaleString("en-US")} tokens; run /compact to reduce the next browser message without changing that model window.`,
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (estimatedInputTokens < contextWindow) return;
  throw new ChatGptWebAdapterError(
    `This task is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds the ${contextWindow.toLocaleString("en-US")}-token context window for this ChatGPT Web model. Switch to a model with a larger context window, run /compact, then retry this Web model.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export function assertChatGptWebMultipartInputWithinLimits(
  estimatedInputTokens: number,
  estimatedMessageTokens: number,
  modelId: string,
  effort: ChatGptWebModelMode["effort"],
  capabilities: ChatGptWebCapabilities,
  maxMessageChars: number,
  partCount: number,
  transport?: {
    stagingEffort: ChatGptWebModelMode["effort"];
    maxStageMessageTokens: number;
    maxStageChars: number;
    finalMessageTokens: number;
    finalMessageChars: number;
    finalImageTokens?: number;
  },
): void {
  if (!isChatGptWebMultipartPartCount(partCount)) {
    throw new Error("Bigger Context requires two or six context parts");
  }
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID) {
    throw new ChatGptWebAdapterError(
      "Bigger Context is unavailable for Luna because every later browser request includes the accumulated transcript inside the same 28,000-token transport budget.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context limit is not defined for model: ${modelId}`);
  }
  const { contextWindow: baseContextWindow } = resolveChatGptWebContextLimits(
    modelId,
    effort,
    { ...capabilities, experimentalBiggerContext: false },
  );
  const assertMessageBoundary = (
    label: "stage" | "final part",
    messageTokens: number,
    messageChars: number,
    messageEffort: ChatGptWebModelMode["effort"],
    imageTokens = 0,
  ): void => {
    const { browserMessageTokenLimit, browserComposerCharLimit } = resolveChatGptWebTransportLimits(
      modelId,
      messageEffort,
      capabilities,
    );
    if (browserComposerCharLimit !== undefined && messageChars > browserComposerCharLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} contains ${messageChars.toLocaleString("en-US")} characters, which exceeds the measured ${browserComposerCharLimit.toLocaleString("en-US")}-character ChatGPT composer boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    if (browserMessageTokenLimit !== undefined && messageTokens > browserMessageTokenLimit) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds the measured ${browserMessageTokenLimit.toLocaleString("en-US")}-token ChatGPT message boundary. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
    const messageBudget = resolveChatGptWebMessageTokenBudget(modelId, messageEffort, capabilities, imageTokens);
    if (messageTokens > messageBudget) {
      throw new ChatGptWebAdapterError(
        `A Bigger Context ${label} requires ${messageTokens.toLocaleString("en-US")} visible message tokens, which exceeds its ${messageBudget.toLocaleString("en-US")}-token input budget after reserving space for ChatGPT and attachments. The bridge will not split an individual Codex message or JSON record; compact the task before retrying.`,
        { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
      );
    }
  };
  if (transport) {
    assertMessageBoundary(
      "stage",
      transport.maxStageMessageTokens,
      transport.maxStageChars,
      transport.stagingEffort,
    );
    assertMessageBoundary(
      "final part",
      transport.finalMessageTokens,
      transport.finalMessageChars,
      effort,
      transport.finalImageTokens,
    );
  } else {
    assertMessageBoundary("stage", estimatedMessageTokens, maxMessageChars, effort);
  }
  // More transport messages do not enlarge the model's advertised context window.
  const experimentalContextWindow = baseContextWindow * Math.min(partCount, CHATGPT_WEB_BIGGER_CONTEXT_MULTIPLIER);
  if (estimatedInputTokens < experimentalContextWindow) return;
  const partLabel = partCount === 2 ? "two-part" : "six-part";
  throw new ChatGptWebAdapterError(
    `This Bigger Context transaction is estimated at ${estimatedInputTokens.toLocaleString("en-US")} input tokens, which exceeds its experimental ${experimentalContextWindow.toLocaleString("en-US")}-token ${partLabel} ceiling. Run /compact, then retry.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

/** Select the cheapest account-visible mode that can carry every inert multipart stage. */
export function resolveChatGptWebMultipartStagingMode(
  modelId: string,
  capabilities: ChatGptWebCapabilities,
  maxStageMessageTokens: number,
  maxStageChars: number,
): ChatGptWebModelMode {
  if (modelId === CHATGPT_WEB_LUNA_MODEL_ID || !capabilities.solAvailable) {
    throw new ChatGptWebAdapterError(
      "Bigger Context staging is unavailable for a Luna-only account.",
      { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
    );
  }
  if (modelId !== CHATGPT_WEB_MODEL_ID) {
    throw new Error(`ChatGPT Bigger Context staging mode is not defined for model: ${modelId}`);
  }
  const efforts: readonly ChatGptWebModelMode["effort"][] = capabilities.proAvailable
    ? ["low", "medium", "max"]
    : ["low", "medium"];
  for (const effort of efforts) {
    const mode = resolveChatGptWebModelMode(modelId, effort, capabilities);
    const limits = resolveChatGptWebTransportLimits(modelId, effort, capabilities);
    const messageTokenLimit = resolveChatGptWebMessageTokenBudget(modelId, effort, capabilities);
    const tokenFits = maxStageMessageTokens <= messageTokenLimit;
    const charsFit = limits.browserComposerCharLimit === undefined
      || maxStageChars <= limits.browserComposerCharLimit;
    if (tokenFits && charsFit) return mode;
  }
  throw new ChatGptWebAdapterError(
    `No ChatGPT effort available to this account can carry a Bigger Context stage with ${maxStageMessageTokens.toLocaleString("en-US")} estimated tokens and ${maxStageChars.toLocaleString("en-US")} characters.`,
    { status: 400, errorType: "invalid_request_error", code: "context_length_exceeded", retryable: false },
  );
}

export const browserStageTimeouts = {
  browserPage: 60_000,
  temporaryChatPreparation: 150_000,
  effortSelection: 120_000,
  promptAttachment: 60_000,
  fileAttachment: 120_000,
  send: 20_000,
  // A Bigger Context stage posts a much larger payload onto a conversation that already holds the
  // earlier parts. This budget covers ChatGPT accepting the submission, not just the click.
  multipartStageSend: 180_000,
  // Staging asks for one transaction-bound acknowledgement, not an open-ended model answer.
  multipartStageAcknowledgement: CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
} as const;

/**
 * Detects that this process was suspended (system sleep) by watching for gaps in a steady tick.
 * On Apple Silicon the monotonic clock keeps advancing through sleep, so elapsed time alone cannot
 * distinguish "the stage really took 15 minutes" from "the machine slept for 14 of them" — and a
 * stage budget charged for slept time cancels turns that never got their budget awake.
 */
export class ChatGptSuspensionClock {
  private suspendedTotalMs = 0;
  private lastTickAt: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly tickIntervalMs = 1_000,
    private readonly gapThresholdMs = 5_000,
  ) {
    this.lastTickAt = Date.now();
  }

  start(): void {
    if (this.timer) return;
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => this.tick(Date.now()), this.tickIntervalMs);
    this.timer.unref?.();
  }

  /** Exposed for tests; production ticks come from the interval above. */
  tick(now: number): void {
    const gap = now - this.lastTickAt;
    this.lastTickAt = now;
    if (gap >= this.gapThresholdMs) this.suspendedTotalMs += gap - this.tickIntervalMs;
  }

  suspendedMs(): number {
    return this.suspendedTotalMs;
  }
}

export const chatGptSuspensionClock = new ChatGptSuspensionClock();

/**
 * How much of a stage budget remains once slept time is refunded. Zero means the stage really
 * consumed its budget while awake and the timeout stands.
 */
export function remainingStageBudgetMs(
  timeoutMs: number,
  elapsedMs: number,
  suspendedMs: number,
): number {
  const awakeMs = elapsedMs - suspendedMs;
  if (awakeMs >= timeoutMs) return 0;
  return Math.max(250, timeoutMs - awakeMs);
}

export const CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS = 30_000;
export const MAX_CHATGPT_BROWSER_PAGE_REBINDS = 2;

export class ChatGptBrowserObservationTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`ChatGPT browser DOM observation did not respond within ${timeoutMs}ms`);
    this.name = "ChatGptBrowserObservationTimeoutError";
  }
}

export async function withChatGptBrowserObservationTimeout<T>(
  operation: Promise<T>,
  timeoutMs = CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ChatGptBrowserObservationTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function connectAfterClosingBrowserConnection<T>(
  previousConnection: Pick<Browser, "close"> | undefined,
  connect: () => Promise<T>,
): Promise<T> {
  if (previousConnection) await previousConnection.close();
  return connect();
}

export const CHATGPT_MIN_OPERATIONAL_VIEWPORT = Object.freeze({ width: 320, height: 240 });

export async function waitForOperationalChatGptViewport(page: Page, signal?: AbortSignal): Promise<void> {
  try {
    // A retained renderer can expose its public DOM while the SDK utility-world
    // waiter is stale. Read this bound page directly, just like owned input.
    const deadline = Date.now() + 10_000;
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Viewport remained below the operational minimum for 10000ms");
      const ready = await withBrowserTurnAbort(withChatGptBrowserObservationTimeout(page.evaluate(
        ({ width, height }) => innerWidth >= width && innerHeight >= height,
        CHATGPT_MIN_OPERATIONAL_VIEWPORT,
      ), remaining), signal);
      if (ready === true) return;
      await withBrowserTurnAbort(new Promise(resolve => setTimeout(resolve, 50)), signal);
    }
  } catch (error) {
    if (signal?.aborted) throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
    throw new Error(
      `ChatGPT browser surface did not expose an operational viewport: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const CHATGPT_COMPOSER_DOCUMENT_END_KEY = process.platform === "darwin"
  ? "Meta+ArrowDown"
  : "Control+End";
export const CHATGPT_COMPOSER_SELECT_ALL_KEY = process.platform === "darwin"
  ? "Meta+A"
  : "Control+A";

function throwIfPromptAttachmentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("ChatGPT prompt attachment aborted", "AbortError");
}

function withBrowserTurnAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException("ChatGPT web turn aborted", "AbortError"));
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const onAbort = () => rejectPromise(new DOMException("ChatGPT web turn aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

export interface BrowserTurn {
  traceId: string;
  modelId: string;
  reasoning?: string;
  modelFamily?: "5.6" | "6";
  capabilities: ChatGptWebCapabilities;
  prepare: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  prepareResume?: () => Promise<CompiledChatGptWebPrompt & { release: () => void }>;
  /** Select the Codex Native connector without advertising the ordinary turn tool environment. */
  nativeConnector?: boolean;
  retainConversation?: boolean;
  requireRetainedConversation?: boolean;
  conversationKey?: string;
  onPreparedSelected?: (reused: boolean) => void | Promise<void>;
  abortSignal?: AbortSignal;
  onHeartbeat?: () => void;
  /** Send activation is the ambiguity boundary after which a fresh surface must not replay this prompt. */
  onSendActivated?: () => void | Promise<void>;
  /** Semantic submission evidence proved that ChatGPT accepted the prompt. */
  onSubmitted?: () => void | Promise<void>;
  /** One inert Bigger Context stage completed its exact acknowledgement boundary. */
  onMultipartStageAcknowledged?: (stageIndex: number) => void | Promise<void>;
  /** Visible ChatGPT reasoning-summary step titles only; never hidden chain-of-thought. */
  onReasoningSummary?: (text: string, continuation?: boolean) => void;
  /** Stable visible ChatGPT prose between status/tool rows. */
  onCommentary?: (text: string, continuation?: boolean) => void;
  /** Append-only, structurally stable Markdown chunks. */
  onTextDelta: (delta: string) => void;
  /** Proven current-turn MCP activity; never response content or completion. */
  externalProgress?: ChatGptTurnProgressReader;
  /** Atomically fences browser completion against concurrent MCP claims in the turn broker. */
  completionFence?: {
    begin(): Promise<number | undefined>;
    commit(revision: number): Promise<boolean>;
  };
  /** Allow one clean pre-submit composer retry for isolated history compaction only. */
  compaction?: boolean;
  /** Require and remove the private Luna checkpoint tail from the visible Markdown stream. */
  captureLunaCheckpoint?: boolean;
  onLunaCheckpoint?: (captured: CapturedChatGptLunaCheckpoint) => void;
}

interface ChatGptSubmissionBaseline {
  userTurns: Locator;
  responseTurns: Locator;
  initialTurnIdentities: readonly string[];
  domCache: ChatGptSubmissionDomCache;
  submittedText?: string;
  /** Actual connector padding read from the verified composer before Send. */
  submittedConnectorPadding?: string;
  acceptedUserIdentity?: string;
  pendingUserRekeySince?: number;
}

interface ChatGptSubmissionObservationRecovery {
  page: Page;
  baseline: ChatGptSubmissionBaseline;
}

type ChatGptObservationRecovery = (
  attempt: number,
  cause: ChatGptBrowserObservationTimeoutError,
  baseline: ChatGptSubmissionBaseline,
  abortSignal?: AbortSignal,
) => Promise<ChatGptSubmissionObservationRecovery>;

interface ChatGptAssistantTurnBinding {
  identity: string;
  locator: Locator;
  acceptedTurnIdentities: readonly string[];
}

interface ChatGptSubmissionDomState {
  userTurnCount: number;
  assistantTurnCount: number;
  visibleStopButtonCount: number;
  turnIdentities: string[];
  userIdentities: string[];
  responseIdentities: string[];
}

interface ChatGptSubmissionDomCache {
  key?: string;
  snapshot?: ChatGptSubmissionDomState;
  fullScans?: number;
  cacheHits?: number;
}

export interface ResolvedBrowserConfig {
  appName: string;
  browserHost: "managed-chrome" | "launcher";
  browserHostDescriptorPath?: string;
  browserHelperScriptPath?: string;
  browserDiagnosticsPath?: string;
  storageStatePath: string;
  chromeExecutablePath: string;
  turnTimeoutMs?: number;
  headed: boolean;
  autoApproveToolCalls: boolean;
  useSavedChats: boolean;
}

export function chatGptTurnIsComplete(state: {
  responsePresent: boolean;
  running: boolean;
  currentText: string;
  currentHtml?: string;
  completionActionVisible: boolean;
}): boolean {
  return state.responsePresent
    && !state.running
    && state.currentText.length > 0
    && state.completionActionVisible;
}

export type ChatGptSubmissionEvidence = "user_turn" | "assistant_turn" | "generation_running" | "mcp_tool_call";

export function chatGptSubmissionEvidence(state: {
  initialTurnIdentities: readonly string[];
  userIdentities: readonly string[];
  responseIdentities: readonly string[];
  generationRunning: boolean;
}): ChatGptSubmissionEvidence | undefined {
  if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.userIdentities)) return "user_turn";
  if (chatGptNewTurnIdentity(state.initialTurnIdentities, state.responseIdentities)) return "assistant_turn";
  if (state.generationRunning) return "generation_running";
  return undefined;
}

export type ChatGptConnectorAttachmentMode = "none" | "mention" | "retained";

/** A launcher lease may reuse a connector only after proving that exact retained surface is bound. */
export function chatGptConnectorAttachmentMode(
  localTools: boolean,
  reuseConversation: boolean,
): ChatGptConnectorAttachmentMode {
  if (!localTools) return "none";
  return reuseConversation ? "retained" : "mention";
}

export async function setChatGptThinkMode(
  composerForm: Locator,
  enabled: boolean,
  captureDiagnostic?: (checkpoint: string) => Promise<void>,
  abortSignal?: AbortSignal,
): Promise<void> {
  throwIfPromptAttachmentAborted(abortSignal);
  const controls = composerForm
    .getByRole("button", { name: "Think", exact: true })
    .filter({ visible: true });
  const count = await controls.count();
  if (count === 0 && !enabled) {
    await captureDiagnostic?.("luna-default-confirmed");
    return;
  }
  if (count > 1) throw new Error(`ChatGPT exposed ${count} visible Think controls`);
  const control = controls.first();
  const actionOptions = { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS };
  let pressed = count === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
  if (count === 1 && pressed !== "true" && pressed !== "false") {
    throw new Error("ChatGPT Think control has no semantic pressed state");
  }
  const target = enabled ? "true" : "false";
  if (pressed !== target) {
    const composer = composerForm.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
    const composerState = () => composer.evaluate(element => {
      const copy = element.cloneNode(true) as HTMLElement;
      const pills = [...copy.querySelectorAll('[data-id^="plugin:"][data-keyword]')];
      const connectors = pills.map(pill => pill.getAttribute("data-keyword")).sort();
      for (const pill of pills) pill.remove();
      const text = element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
        ? element.value : copy.textContent ?? "";
      return { text: text.trim(), connectors };
    }, undefined, actionOptions);
    const before = await composerState();
    if (before.text) throw new Error("ChatGPT Think selection requires an empty prompt draft");
    await composer.focus(actionOptions);
    await composer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, actionOptions);
    await composer.pressSequentially("/think", { ...actionOptions, delay: 25 });
    await captureDiagnostic?.("think-slash-triggered");
    // The command popup shares menu-item classes with sidebar history. Count only this popup.
    const popup = composerForm.page().locator('.popover[aria-busy="false"]').filter({ visible: true });
    const rows = popup.locator('.__menu-item[tabindex="0"]').filter({ visible: true });
    await rows.first().waitFor({ state: "visible", timeout: 5_000, signal: abortSignal });
    if (await popup.count() !== 1 || await rows.count() !== 1) {
      throw new Error("ChatGPT Think slash menu must expose exactly one command option");
    }
    const row = rows.first();
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      await composer.press("ArrowDown", actionOptions);
    }
    if (await row.getAttribute("data-highlighted", actionOptions) === null) {
      throw new Error("ChatGPT Think slash option is not highlighted");
    }
    await captureDiagnostic?.("think-slash-menu-ready");
    throwIfPromptAttachmentAborted(abortSignal);
    await composer.press("Enter", actionOptions);
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      const currentCount = await controls.count();
      if (currentCount > 1) throw new Error(`ChatGPT exposed ${currentCount} visible Think controls`);
      pressed = currentCount === 1 ? await control.getAttribute("aria-pressed", actionOptions) : null;
      if (pressed === target) break;
      if (currentCount === 1 && pressed !== "true" && pressed !== "false") {
        throw new Error("ChatGPT Think control lost its semantic pressed state");
      }
      await withBrowserTurnAbort(new Promise(resolveSleep => setTimeout(resolveSleep, 100)), abortSignal);
    }
    if (pressed !== target) {
      throw new Error(`ChatGPT did not ${enabled ? "enable" : "disable"} Think mode`);
    }
    const after = await composerState();
    if (after.text || JSON.stringify(after.connectors) !== JSON.stringify(before.connectors)) {
      throw new Error("ChatGPT Think slash selection did not preserve the empty draft and selected connectors");
    }
  }
  await captureDiagnostic?.(enabled ? "think-enabled" : "think-disabled");
}

export function chatGptNewTurnIdentity(
  initial: readonly string[],
  current: readonly string[],
): string | undefined {
  const previous = new Set(initial);
  const added = current.filter(identity => !previous.has(identity));
  if (added.length > 1) {
    throw new Error(`ChatGPT exposed ${added.length} new conversation turns for one submitted message`);
  }
  return added[0];
}

export function chatGptReboundTurnIdentity(
  initial: readonly string[],
  boundIdentity: string,
  current: readonly string[],
): string | undefined {
  if (current.includes(boundIdentity)) return boundIdentity;
  return chatGptNewTurnIdentity(initial, current);
}

export class ChatGptCompletionTracker {
  private candidate?: { signature: string; since: number };
  private lastToolBatchRevision = 0;
  private postToolAnswerBaselineText?: string;
  private missingPostToolAnswerSince?: number;

  constructor(
    private readonly stableMs = CHATGPT_COMPLETION_SETTLE_MS,
    private readonly missingPostToolAnswerMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  needsToolBatchObservation(revision: number): boolean {
    if (!Number.isSafeInteger(revision) || revision < this.lastToolBatchRevision) {
      throw new Error("ChatGPT completion received an invalid tool-batch revision");
    }
    return revision > this.lastToolBatchRevision;
  }

  observeToolBatch(revision: number, currentText: string): boolean {
    if (!this.needsToolBatchObservation(revision)) return false;
    // The caller acknowledges the batch only after this projection is captured. The outer Codex
    // harness therefore cannot execute the tool until this exact pre-tool answer boundary exists.
    this.postToolAnswerBaselineText = currentText;
    this.lastToolBatchRevision = revision;
    this.missingPostToolAnswerSince = undefined;
    this.candidate = undefined;
    return true;
  }

  update(
    state: Parameters<typeof chatGptTurnIsComplete>[0] & {
      externalToolCallsInFlight?: boolean;
    },
    now = Date.now(),
  ): boolean {
    const signature = `${state.currentText}\0${state.currentHtml ?? state.currentText}`;
    // An outstanding tool call proves the model has more to say, whatever the rendered message
    // currently looks like. Completing here would return a truncated answer and retire the turn
    // while its own tool calls were still in flight.
    if (state.externalToolCallsInFlight) {
      this.candidate = undefined;
      this.missingPostToolAnswerSince = undefined;
      return false;
    }
    if (this.postToolAnswerBaselineText === state.currentText) {
      this.candidate = undefined;
      if (!chatGptTurnIsComplete(state)) {
        this.missingPostToolAnswerSince = undefined;
        return false;
      }
      this.missingPostToolAnswerSince ??= now;
      if (now - this.missingPostToolAnswerSince >= this.missingPostToolAnswerMs) {
        throw new Error("ChatGPT completed without producing a final answer after its last Codex tool call");
      }
      return false;
    }
    this.missingPostToolAnswerSince = undefined;
    if (!chatGptTurnIsComplete(state)) {
      this.candidate = undefined;
      return false;
    }
    if (this.candidate?.signature !== signature) {
      this.candidate = { signature, since: now };
      return false;
    }
    return now - this.candidate.since >= this.stableMs;
  }
}

export class ChatGptTurnDomHealthTracker {
  private sawResponse = false;
  private missingResponseSince?: number;
  private emptyCompletionSince?: number;
  private missingCompletionAction?: { text: string; since: number };

  constructor(
    private readonly missingResponseMs = CHATGPT_RESPONSE_DOM_GRACE_MS,
    private readonly emptyCompletionMs = CHATGPT_EMPTY_RESPONSE_GRACE_MS,
    private readonly missingCompletionActionMs = CHATGPT_COMPLETION_ACTION_GRACE_MS,
  ) {}

  /**
   * Clears only the missing-response window, leaving `sawResponse` history intact.
   *
   * Callers use this when proven external progress suspends DOM health checks: the suspended
   * stretch must not be charged against the grace period, or the first observation after it
   * resumes would fail instantly against a timestamp recorded long before.
   */
  clearMissingResponse(): void {
    this.missingResponseSince = undefined;
  }

  update(state: {
    responsePresent: boolean;
    running: boolean;
    currentText: string;
    completionActionVisible: boolean;
    externalProgressLive?: boolean;
  }, now = Date.now()): string | undefined {
    if (state.responsePresent) this.sawResponse = true;
    if (state.externalProgressLive) {
      // Every conclusion below asserts that ChatGPT stopped producing this turn. A tool call that
      // is still completing disproves all of them, whatever the renderer is currently exposing, so
      // no window may accrue while the model is provably working.
      this.missingResponseSince = undefined;
      this.emptyCompletionSince = undefined;
      this.missingCompletionAction = undefined;
      return undefined;
    }
    if (state.responsePresent) {
      this.missingResponseSince = undefined;
    } else {
      this.missingResponseSince ??= now;
      if (now - this.missingResponseSince >= this.missingResponseMs) {
        return this.sawResponse
          ? "ChatGPT response DOM disappeared while the browser turn was active"
          : "ChatGPT did not create a response DOM after the message was sent";
      }
    }

    const emptyCompletion = state.responsePresent
      && !state.running
      && state.currentText.length === 0
      && state.completionActionVisible;
    if (!emptyCompletion) {
      this.emptyCompletionSince = undefined;
    } else {
      this.emptyCompletionSince ??= now;
      if (now - this.emptyCompletionSince >= this.emptyCompletionMs) {
        return "ChatGPT browser turn completed without a final answer";
      }
    }

    const missingCompletionAction = state.responsePresent
      && !state.running
      && state.currentText.length > 0
      && !state.completionActionVisible;
    if (!missingCompletionAction) {
      this.missingCompletionAction = undefined;
    } else if (this.missingCompletionAction?.text !== state.currentText) {
      this.missingCompletionAction = { text: state.currentText, since: now };
    } else if (now - this.missingCompletionAction.since >= this.missingCompletionActionMs) {
      return "ChatGPT stopped generating but did not expose its completed-turn action; the ChatGPT DOM may have changed";
    }
    return undefined;
  }
}

/**
 * Consecutive internal observation faults tolerated before a turn is abandoned.
 *
 * An internal observation fault is not evidence that the upstream turn failed. The loop
 * re-observes within a consecutive budget; any successful observation resets that budget, and
 * exhausting it fails closed with the original fault as the cause.
 */
export const MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS = 8;

/**
 * How stale recorded MCP progress may be and still suppress DOM health checks.
 *
 * An outstanding tool call reports liveness regardless of age, so a call that never returns would
 * otherwise hold a turn open forever — turns carry no deadline unless a caller supplies one. This
 * bounds the silence since the last recorded activity rather than the turn's total duration, so a
 * long turn that keeps calling tools is never penalised for taking a long time.
 */
export const CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS = 10 * 60_000;

/** Tolerated clock difference between the recording daemon and the observing helper process. */
export const CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS = 5_000;

/** Proven MCP activity, additionally required to be recent enough to still be evidence. */
export function chatGptExternalProgressSuppressesDomHealth(
  snapshot: ChatGptExternalTurnProgressSnapshot | undefined,
  now: number,
): boolean {
  if (!chatGptExternalProgressIsLive(snapshot, now, CHATGPT_RESPONSE_DOM_GRACE_MS)) return false;
  const lastProgressAt = snapshot?.lastProgressAt;
  if (lastProgressAt === undefined) return false;
  const age = now - lastProgressAt;
  // A timestamp from the future would keep `age` below the ceiling forever. Recorded activity can
  // only precede the observation, so anything meaningfully ahead of now is not evidence at all.
  return age >= -CHATGPT_EXTERNAL_PROGRESS_CLOCK_SKEW_MS
    && age < CHATGPT_EXTERNAL_PROGRESS_STALL_CEILING_MS;
}

export interface ChatGptVisibleTraceBlock {
  kind: "answer" | "commentary" | "status";
  text: string;
  key?: string;
  complete?: boolean;
  uiControl?: boolean;
}

export interface ChatGptVisibleTraceEvent {
  kind: "reasoning" | "commentary";
  text: string;
  continuation?: boolean;
}

interface ChatGptResponseDomSnapshot {
  responsePresent: boolean;
  visibleText: string;
  fullHtml: string;
  markdownSegments: ChatGptMarkdownSegment[];
  completionActionVisible: boolean;
  stoppedThinkingVisible: boolean;
  traceBlocks: ChatGptVisibleTraceBlock[];
}

interface ChatGptResponseDomCache {
  key?: string;
  snapshot?: ChatGptResponseDomSnapshot;
  fullScans?: number;
  cacheHits?: number;
}

const absentResponseDomSnapshot = (): ChatGptResponseDomSnapshot => ({
  responsePresent: false,
  visibleText: "",
  fullHtml: "",
  markdownSegments: [],
  completionActionVisible: false,
  stoppedThinkingVisible: false,
  traceBlocks: [],
});

/** Convert the public ChatGPT turn DOM into append-only Codex reasoning summaries. */
export class ChatGptVisibleTraceTracker {
  private readonly emittedTrace = new Map<string, string>();
  private readonly traceCandidates = new Map<string, { text: string; changedAt: number }>();

  constructor(private readonly traceStabilityMs = 250) {}

  observe(blocks: ChatGptVisibleTraceBlock[], completionActionVisible: boolean, now = Date.now()): ChatGptVisibleTraceEvent[] {
    const output: ChatGptVisibleTraceEvent[] = [];
    let statusSlot = 0;
    let commentarySlot = 0;
    for (const block of blocks) {
      // Final-answer roots are carried by ChatGptMarkdownBuffer. Commentary roots are identified
      // structurally by responseDomSnapshot before they reach this tracker.
      if (block.kind === "answer") continue;
      const index = block.kind === "status" ? statusSlot++ : commentarySlot++;
      const slot = block.key ? `${block.kind}:${block.key}` : `${block.kind}:${index}`;
      const stripped = block.text
        .replace(/\r\n/g, "\n")
        .split("\n")
        .map(line => line.replace(/[\t ]+/g, " ").trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      const text = block.kind === "status" ? stripped.replace(/\s+/g, " ") : stripped;
      if (!text) continue;
      let candidate = this.traceCandidates.get(slot);
      if (!candidate || candidate.text !== text) {
        candidate = { text, changedAt: now };
        this.traceCandidates.set(slot, candidate);
        if (!completionActionVisible && this.traceStabilityMs > 0) continue;
      }
      // A commentary Markdown root remains mutable until ChatGPT appends the next reasoning item.
      // Emitting it earlier lets a tool-status boundary split one semantic paragraph into multiple
      // Codex messages. The next anchored item (or final completion evidence) is the stable boundary.
      if (block.kind === "commentary" && block.complete === false && !completionActionVisible) continue;
      if (!completionActionVisible && now - candidate.changedAt < this.traceStabilityMs) continue;

      const previous = this.emittedTrace.get(slot);
      if (previous === text) continue;
      this.emittedTrace.set(slot, text);
      const kind = block.kind === "commentary" ? "commentary" : "reasoning";

      if (previous && text.startsWith(previous)) {
        output.push({ kind, text: text.slice(previous.length), continuation: true });
      } else {
        output.push({ kind, text });
      }
    }
    return output;
  }
}

export function isChatGptTraceControl(block: ChatGptVisibleTraceBlock): boolean {
  if (block.kind !== "status") return false;
  const text = block.text.replace(/\s+/g, " ").trim();
  return block.uiControl === true || text === "Answer now" || text === "Thinking";
}

export function stripChatGptTraceControlSuffix(block: ChatGptVisibleTraceBlock): ChatGptVisibleTraceBlock {
  if (block.kind !== "status") return block;
  const text = block.text.replace(/(?:^|\s)Answer now\s*$/, "").trimEnd();
  return text === block.text ? block : { ...block, text };
}

export function redactChatGptUiDiagnostic(value: string): string {
  return value
    .replace(/<codex_context_json>[\s\S]*?<\/codex_context_json>/gi, "<codex_context_json>[redacted]</codex_context_json>")
    .replace(/\b(turn|binding|call)_[A-Za-z0-9_-]{12,}\b/g, "$1_[redacted]");
}

const CHATGPT_DIAGNOSTIC_SAFE_STRING_KEYS = new Set([
  "tag",
  "role",
  "ariaExpanded",
  "ariaChecked",
  "dataState",
  "dataHighlighted",
  "origin",
]);

/** Defense in depth: persisted browser traces contain structure, never rendered UI text. */
export function sanitizeChatGptBrowserDiagnosticState(value: unknown): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(sanitizeChatGptBrowserDiagnosticState);
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, candidate]) => {
    if (typeof candidate === "string") {
      return CHATGPT_DIAGNOSTIC_SAFE_STRING_KEYS.has(key) && candidate.length <= 200
        ? [[key, candidate]]
        : [];
    }
    const sanitized = sanitizeChatGptBrowserDiagnosticState(candidate);
    return sanitized === undefined ? [] : [[key, sanitized]];
  }));
}

const CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT = 10;

export function browserDiagnosticCheckpoint(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return safe || "checkpoint";
}

function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try { chmodSync(path, 0o700); } catch { /* Windows ACLs are managed by the installer. */ }
}

function pruneBrowserDiagnostics(root: string): void {
  const traces = readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^[A-Za-z0-9_-]{6,128}$/.test(entry.name))
    .map(entry => {
      const path = join(root, entry.name);
      return { path, modifiedAt: statSync(path).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const trace of traces.slice(CHATGPT_BROWSER_DIAGNOSTIC_TRACE_LIMIT)) {
    rmSync(trace.path, { recursive: true, force: true });
  }
}

export class ChatGptBrowserDiagnostics {
  private readonly directory: string;
  private sequence = 0;
  private initialized = false;

  constructor(
    private readonly traceId: string,
    private readonly root: string,
    private readonly appName: string,
  ) {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      throw new Error("ChatGPT browser diagnostic trace id is invalid");
    }
    this.directory = join(this.root, `${traceId}-${randomUUID().slice(0, 8)}`);
  }

  async capture(page: Page, checkpoint: string, error?: unknown): Promise<void> {
    try {
      if (!this.initialized) {
        privateDirectory(this.root);
        privateDirectory(this.directory);
        pruneBrowserDiagnostics(this.root);
        this.initialized = true;
      }
      const sequence = String(++this.sequence).padStart(2, "0");
      const stem = `${sequence}-${browserDiagnosticCheckpoint(checkpoint)}`;
      const includeScreenshot = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1";
      if (checkpoint === "send-ready" && !includeScreenshot) {
        // The journal requires this conservative pre-Send marker. Record it without
        // spending the operation budget on a second serialization of the full draft.
        atomicWriteFile(join(this.directory, `${stem}.json`), `${JSON.stringify({
          version: 2, capturedAt: new Date().toISOString(), traceId: this.traceId,
          checkpoint, capture: "checkpoint_only",
        })}\n`);
        return;
      }
      const [screenshotResult, stateResult] = await Promise.allSettled([
        includeScreenshot
          ? page.screenshot({ animations: "disabled", caret: "hide", timeout: 5_000, type: "png" })
          : Promise.resolve(undefined),
        withChatGptBrowserObservationTimeout(page.evaluate(({
          composerSelector,
          effortControlSelector,
          effortItemSelector,
          effortSliderContainerSelector,
          assistantTurnSelector,
          userTurnSelector,
          stopButtonSelector,
          completionActionSelector,
          appName,
        }) => {
          const rendered = (element: Element): boolean => {
            const candidate = element as HTMLElement;
            const style = getComputedStyle(candidate);
            return candidate.isConnected
              && style.display !== "none"
              && style.visibility !== "hidden"
              && style.opacity !== "0";
          };

          const rows = (selector: string, limit = 40) => [...document.querySelectorAll(selector)]
            .filter(rendered)
            .slice(-limit)
            .map(element => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute("role"),
                ariaExpanded: element.getAttribute("aria-expanded"),
                ariaChecked: element.getAttribute("aria-checked"),
                dataState: element.getAttribute("data-state"),
                dataHighlighted: element.getAttribute("data-highlighted"),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                textChars: (element.textContent ?? "").length,
              };
            });
          const exactText = (element: Element, expected: string): boolean => (
            [element, ...element.querySelectorAll("*")].some(candidate => (
              candidate.children.length === 0
              && (candidate.textContent ?? "").replace(/\s+/g, " ").trim() === expected
            ))
          );
          const composers = [...document.querySelectorAll(composerSelector)].filter(rendered);
          const assistantTurns = [...document.querySelectorAll(assistantTurnSelector)].filter(rendered);
          const selectedConnectors = composers.flatMap(composer => (
            [...composer.querySelectorAll('[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]')]
          ))
            .filter(rendered);
          const exactConnectorRows = [...document.querySelectorAll('.__menu-item[tabindex="0"], [data-mention-list-scroll-area] button[data-list-navigation-item="true"]')]
            .filter(element => rendered(element) && exactText(element, appName));
          const currentUrl = new URL(location.href);
          const integerAttribute = (element: Element, name: string): number | null => {
            const raw = element.getAttribute(name);
            return raw !== null && /^-?\d+$/.test(raw) && Number.isSafeInteger(Number(raw))
              ? Number(raw) : null;
          };
          return {
            location: {
              origin: currentUrl.origin,
              pathSegments: currentUrl.pathname.split("/").filter(Boolean).length,
              temporaryChat: currentUrl.searchParams.has("temporary-chat"),
            },
            titleChars: document.title.length,
            documentComplete: document.readyState === "complete",
            viewport: { width: innerWidth, height: innerHeight },
            surfaceBound: typeof (globalThis as typeof globalThis & { __CODEX_WEB_GPT_SURFACE_ID__?: unknown })
              .__CODEX_WEB_GPT_SURFACE_ID__ === "string",
            // textContent avoids the synchronous layout forced by innerText on huge prompts.
            bodyTextChars: document.body?.textContent?.length ?? 0,
            composer: {
              visibleCount: composers.length,
              textChars: composers.map(element => (
                element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
                  ? element.value : element.textContent ?? ""
              ).length),
              editors: composers.map(element => ({
                tag: element.tagName.toLowerCase(),
                contentEditable: (element as HTMLElement).isContentEditable,
                focused: element === document.activeElement,
              })),
              // When recognition fails, retain structure of the unmatched controls,
              // never their values, labels, HTML or other conversation contents.
              unrecognizedEditors: composers.length === 0
                ? [...document.querySelectorAll('textarea, [contenteditable="true"]')]
                  .filter(rendered).slice(0, 10).map(element => ({
                    tag: element.tagName.toLowerCase(),
                    role: element.getAttribute("role"),
                    attributes: Object.fromEntries([
                      "id", "data-testid", "data-lexical-editor", "data-composer-markdown",
                      "contenteditable", "placeholder", "autofocus", "disabled", "readonly",
                    ].map(name => [name, element.hasAttribute(name)])),
                    inForm: Boolean(element.closest("form")),
                    inComposerForm: Boolean(element.closest("form[data-chatgpt-composer]")),
                    focused: element === document.activeElement,
                  }))
                : [],
              selectedConnectorCount: selectedConnectors.length,
              exactSelectedConnectorCount: selectedConnectors.filter(
                element => (element.getAttribute("data-keyword") ?? element.getAttribute("app-mention-display-name")) === appName,
              ).length,
            },
            focus: {
              tag: document.activeElement?.tagName.toLowerCase() ?? null,
              role: document.activeElement?.getAttribute("role") ?? null,
              documentFocused: document.hasFocus(),
            },
            effortControls: rows(effortControlSelector, 10),
            effortItems: rows(effortItemSelector, 20),
            effortSliders: [...document.querySelectorAll(effortSliderContainerSelector)]
              .filter(rendered).slice(-10)
              .flatMap(container => [...container.querySelectorAll('[role="slider"]')])
              .map(element => ({
                min: integerAttribute(element, "aria-valuemin"),
                max: integerAttribute(element, "aria-valuemax"),
                value: integerAttribute(element, "aria-valuenow"),
              })),
            menus: rows('[role="menu"], [role="listbox"], [data-testid="composer-intelligence-picker-content"]', 20),
            connectorRows: exactConnectorRows.slice(-20).map(element => {
              const rect = element.getBoundingClientRect();
              return {
                tag: element.tagName.toLowerCase(),
                role: element.getAttribute("role"),
                dataState: element.getAttribute("data-state"),
                dataHighlighted: element.getAttribute("data-highlighted"),
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                textChars: (element.textContent ?? "").length,
              };
            }),
            overlays: rows('[role="dialog"], [role="alert"], [role="status"]', 30),
            turns: {
              user: document.querySelectorAll(userTurnSelector).length,
              stopButtonCount: [...document.querySelectorAll(stopButtonSelector)].filter(rendered).length,
              assistant: assistantTurns.map(element => ({
                textChars: (element.textContent ?? "").length,
                htmlChars: (element as HTMLElement).innerHTML.length,
                markdownCount: element.querySelectorAll('.markdown, [data-markdown-text-style="assistant-message"]').length,
                streamingStatusCount: element.querySelectorAll("[data-streaming-response-status]").length,
                completionActionCount: element.querySelectorAll(completionActionSelector).length,
                renderedCompletionActionCount: [...element.querySelectorAll(completionActionSelector)]
                  .filter(rendered).length,
              })),
            },
          };
        }, {
          composerSelector: CHATGPT_COMPOSER_SELECTOR,
          effortControlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR,
          effortItemSelector: CHATGPT_EFFORT_ITEM_SELECTOR,
          effortSliderContainerSelector: CHATGPT_EFFORT_SLIDER_CONTAINER_SELECTOR,
          assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
          userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
          stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
          completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
          appName: this.appName,
        })),
      ]);
      const capturedAt = new Date().toISOString();
      if (screenshotResult.status === "fulfilled" && screenshotResult.value) {
        atomicWriteFile(join(this.directory, `${stem}.png`), screenshotResult.value);
      }
      const captureErrors = Object.fromEntries([
        ...(screenshotResult.status === "rejected" ? [[
          "screenshot",
          redactChatGptUiDiagnostic(
            screenshotResult.reason instanceof Error ? screenshotResult.reason.message : String(screenshotResult.reason),
          ),
        ]] : []),
        ...(stateResult.status === "rejected" ? [[
          "state",
          redactChatGptUiDiagnostic(
            stateResult.reason instanceof Error ? stateResult.reason.message : String(stateResult.reason),
          ),
        ]] : []),
      ]);
      atomicWriteFile(join(this.directory, `${stem}.json`), `${JSON.stringify({
        version: 2,
        capturedAt,
        traceId: this.traceId,
        checkpoint,
        ...(error !== undefined ? {
          error: redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error)),
        } : {}),
        ...(stateResult.status === "fulfilled"
          ? { state: sanitizeChatGptBrowserDiagnosticState(stateResult.value) }
          : {}),
        ...(Object.keys(captureErrors).length > 0 ? { captureErrors } : {}),
      }, null, 2)}\n`);
      if (Object.keys(captureErrors).length > 0) {
        console.warn(
          `[chatgpt-web] browser diagnostic partial capture trace=${this.traceId}`
          + ` checkpoint=${stem} failures=${Object.keys(captureErrors).join(",")}`,
        );
      }
      console.info(`[chatgpt-web] browser diagnostic trace=${this.traceId} checkpoint=${stem} path=${this.directory}`);
    } catch (captureError) {
      console.warn(
        `[chatgpt-web] browser diagnostic capture failed trace=${this.traceId}`
        + ` checkpoint=${browserDiagnosticCheckpoint(checkpoint)}:`
        + ` ${captureError instanceof Error ? captureError.message : String(captureError)}`,
      );
    }
  }
}

export function resolveBrowserConfig(provider: CodexProviderConfig): ResolvedBrowserConfig {
  const configured = provider.chatgptWeb ?? {};
  const appName = configured.appName?.trim() || CHATGPT_CONNECTOR_NAME;
  const browserHost = configured.browserHost ?? "managed-chrome";
  const browserHostDescriptorPath = configured.browserHostDescriptorPath?.trim();
  const browserHelperScriptPath = configured.browserHelperScriptPath?.trim();
  const browserDiagnosticsPath = resolve(expandUserPath(
    configured.browserDiagnosticsPath?.trim() || join(getConfigDir(), "diagnostics", "browser-turns"),
  ));
  const turnTimeoutMs = configured.turnTimeoutMs;
  if (browserHost === "launcher" && !browserHostDescriptorPath) {
    throw new Error("Launcher browser host requires chatgptWeb.browserHostDescriptorPath");
  }
  if (browserHelperScriptPath && browserHost !== "launcher") {
    throw new Error("Explicit browser helper script requires a launcher host");
  }
  const resolvedBrowserHelperScriptPath = browserHelperScriptPath
    ? resolve(expandUserPath(browserHelperScriptPath))
    : undefined;
  if (resolvedBrowserHelperScriptPath && !existsSync(resolvedBrowserHelperScriptPath)) {
    throw new Error(`Explicit browser helper script does not exist: ${resolvedBrowserHelperScriptPath}`);
  }
  if (turnTimeoutMs !== undefined
    && (!Number.isFinite(turnTimeoutMs) || turnTimeoutMs <= 0)) {
    throw new Error("ChatGPT Web turnTimeoutMs must be a positive finite number");
  }
  if (isLegacyChatGptConnectorName(appName)) {
    throw new Error(legacyChatGptConnectorMigrationMessage(appName));
  }
  return {
    appName,
    browserHost,
    ...(browserHostDescriptorPath ? { browserHostDescriptorPath: resolve(expandUserPath(browserHostDescriptorPath)) } : {}),
    ...(resolvedBrowserHelperScriptPath ? { browserHelperScriptPath: resolvedBrowserHelperScriptPath } : {}),
    browserDiagnosticsPath,
    storageStatePath: resolve(expandUserPath(configured.storageStatePath?.trim() || join(getConfigDir(), "browser", "storage-state.json"))),
    chromeExecutablePath: resolve(expandUserPath(configured.chromeExecutablePath?.trim() || defaultChromeExecutable())),
    ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
    headed: configured.headed !== false,
    autoApproveToolCalls: configured.autoApproveToolCalls === true,
    useSavedChats: configured.useSavedChats === true,
  };
}

const imageExtensions = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
]);

export function chatGptImageFilePayloads(images: ChatGptWebPromptImage[]): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  if (images.length > CHATGPT_MAX_INPUT_IMAGES) {
    throw new Error(`ChatGPT web accepts at most ${CHATGPT_MAX_INPUT_IMAGES} input images per Codex turn`);
  }
  let totalBytes = 0;
  return images.map(image => {
    const parsed = parseDataUrl(image.imageUrl);
    if (!parsed) throw new Error(`ChatGPT web input image ${image.ref} must be an inline base64 data URL`);
    const extension = imageExtensions.get(parsed.mediaType.toLowerCase());
    if (!extension) throw new Error(`ChatGPT web input image ${image.ref} has unsupported media type: ${parsed.mediaType}`);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(parsed.base64) || parsed.base64.length % 4 !== 0) {
      throw new Error(`ChatGPT web input image ${image.ref} contains invalid base64 data`);
    }
    const buffer = Buffer.from(parsed.base64, "base64");
    if (buffer.length === 0) throw new Error(`ChatGPT web input image ${image.ref} is empty`);
    if (buffer.length > 20_000_000) throw new Error(`ChatGPT web input image ${image.ref} exceeds 20 MB`);
    totalBytes += buffer.length;
    if (totalBytes > 50_000_000) throw new Error("ChatGPT web input images exceed the 50 MB per-turn limit");
    return { name: `${image.ref}.${extension}`, mimeType: parsed.mediaType.toLowerCase(), buffer };
  });
}

function assertChatGptPromptAttachments(prompt: CompiledChatGptWebPrompt): void {
  if (prompt.images.length + (prompt.skillFiles?.length ?? 0) > CHATGPT_MAX_INPUT_IMAGES) {
    throw new ChatGptWebAdapterError(
      "Selected skills and images exceed ChatGPT's 10 attachments per message; disable Skills as files or reduce attachments.",
      { status: 400, errorType: "invalid_request_error", code: "too_many_attachments", retryable: false },
    );
  }
  validateSkillFiles(prompt.skillFiles);
}

export function chatGptPromptFilePayloads(
  prompt: CompiledChatGptWebPrompt,
): Array<{ name: string; mimeType: string; buffer: Buffer }> {
  assertChatGptPromptAttachments(prompt);
  const files = [...chatGptImageFilePayloads(prompt.images), ...(prompt.skillFiles ?? []).map(file => ({
    name: file.name, mimeType: "text/plain", buffer: Buffer.from(file.text, "utf8"),
  }))];
  if (files.reduce((sum, file) => sum + file.buffer.length, 0) > 50_000_000) {
    throw new Error("ChatGPT web attachments exceed the 50 MB per-turn limit");
  }
  return files;
}

/**
 * Insert `value` at the caret of an already-resolved ChatGPT composer, returning whether the edit
 * was applied. Runs inside the page, so it may reference only globals and its two arguments.
 *
 * Effort selection closes a menu immediately before a staged part is attached, and focus is still
 * settling when this runs: the composer can be the active element while the caret has not yet been
 * placed inside it, or focus can still be on the menu that just closed. Reading that as a rejected
 * edit failed whole turns roughly a tenth of a second after the effort menu closed, so the caret is
 * placed explicitly instead of assumed. An existing collapsed caret inside the composer is left
 * exactly where the user put it; only a missing or foreign one is replaced, and always with a
 * position inside this composer, so an insert can never land in another element.
 */
export function insertPlainTextIntoComposer(element: HTMLElement, value: string): boolean {
  if (document.activeElement !== element) element.focus();
  if (document.activeElement !== element) return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const alreadyPlaced = selection.isCollapsed
    && selection.anchorNode !== null
    && element.contains(selection.anchorNode);
  if (!alreadyPlaced) {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  if (
    !selection.isCollapsed
    || !selection.anchorNode
    || !element.contains(selection.anchorNode)
  ) {
    return false;
  }
  return document.execCommand("insertText", false, value);
}

type LauncherComposerOperation = {
  kind: "count" | "focus" | "end" | "insert" | "text" | "connectors" | "clear" | "send-state" | "send" | "connector-state" | "connector-select" | "ui-state";
  text?: string;
  appName?: string;
  sendSelector?: string;
  expectedRaw?: string;
  mentionCount?: number;
};

type LauncherSendFailure = "session_expired" | "subscription_unavailable" | "rate_limited";
type LauncherSendState = { visibleCount: number; enabled: boolean; mentionCount: number; raw?: string; activated?: boolean; failure?: LauncherSendFailure };
type LauncherConnectorState = { text: string; selected: string[]; titles: string[]; exactRows: number; menuCount: number; activated?: boolean; failure?: LauncherSendFailure };

function throwLauncherSendFailure(failure?: LauncherSendFailure): void {
  if (failure === "session_expired") throw new ChatGptWebAdapterError(
    "The ChatGPT session has expired. Sign in again in Codex Web GPT.",
    { status: 401, errorType: "authentication_error", code: "chatgpt_session_expired", retryable: false });
  if (failure === "subscription_unavailable") throw new ChatGptWebAdapterError(
    "ChatGPT could not load the account subscription. Reload ChatGPT inside the launcher and retry; sign out only if the error persists.",
    { status: 503, errorType: "server_error", code: "chatgpt_subscription_unavailable", retryable: true });
  if (failure === "rate_limited") throw new ChatGptWebAdapterError(
    "ChatGPT rate limit: too many requests. Try again in a few minutes.",
    { status: 429, errorType: "rate_limit_error", code: "rate_limit_exceeded", retryable: false });
}

// Locator.evaluate resolves an element handle through the hidden renderer's
// polling context. Use one public DOM transaction on the already-owned page
// instead; uniqueness and exact readback still guard every edit.
export function operateOwnedLauncherComposer({ selector, operation }: {
  selector: string;
  operation: LauncherComposerOperation;
}): number | boolean | string | string[] | LauncherSendState | LauncherConnectorState | { failure?: LauncherSendFailure } {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const uiFailure = (): LauncherSendFailure | undefined => {
    const notices = [...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(visible)
      .map(element => ({ role: element.getAttribute("role"), text: (element.textContent ?? "").replace(/\s+/g, " ") }));
    if (notices.some(row => /Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i.test(row.text))) return "session_expired";
    if (notices.some(row => row.role === "alert" && /Failed to load subscription/i.test(row.text))) return "subscription_unavailable";
    if (notices.some(row => row.role === "dialog"
      && /Too many requests|太多要求|太多请求|リクエストが多すぎます|요청이 너무 많습니다|요청을 너무 빠르게|너무 많은 요청/i.test(row.text)
      && /making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます|요청을 너무 빠르게|요청이 너무 많습니다|너무 많은 요청/i.test(row.text))) return "rate_limited";
  };
  // Public failures belong to the page, including while its editor is absent.
  // Reading them must not resolve an editor or begin a composer transaction.
  if (operation.kind === "ui-state") return { failure: uiFailure() };
  const editors = [...document.querySelectorAll<HTMLElement>(selector)].filter(visible);
  if (operation.kind === "count") return editors.length;
  if (editors.length !== 1 || !editors[0]!.isConnected) throw new Error(`ChatGPT owned composer is not unique (visibleCount=${editors.length})`);
  const editor = editors[0]!;
  const mentions = '[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]';
  const readText = () => {
    const clone = editor.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(mentions + ', [data-inline-selection-pill-cursor-target]').forEach(element => element.remove());
    return [...clone.childNodes].map(child => child.textContent ?? "").join("\n").trimStart();
  };
  if (operation.kind === "connector-state" || operation.kind === "connector-select") {
    const form = editor.closest("form");
    if (!form || !operation.appName) throw new Error("ChatGPT owned connector identity is unavailable");
    const selected = [...editor.querySelectorAll(mentions)].filter(visible)
      .map(element => element.getAttribute("data-keyword") ?? element.getAttribute("app-mention-display-name") ?? "");
    if (selected.filter(name => name === operation.appName).length > 1) throw new Error("ChatGPT composer exposed duplicate connector selections");
    // The current composer renders this portal directly under body, without
    // aria-controls. Its structural marker, unique editor, exact inserted query
    // and confirmed editor focus jointly own the menu. A second portal fails.
    const roots = [...document.querySelectorAll<HTMLElement>('[data-composer-overlay-floating-ui] [data-mention-list-scroll-area]')]
      .filter(element => visible(element) && (!element.closest("form") || element.closest("form") === form));
    const ownedIds = (editor.getAttribute("aria-controls") ?? editor.getAttribute("aria-owns") ?? "").split(/\s+/).filter(Boolean);
    for (const list of document.querySelectorAll<HTMLElement>('[role="listbox"]')) {
      if (visible(list) && (list.closest("form") === form || ownedIds.includes(list.id)) && !roots.includes(list)
        && !roots.some(root => root.contains(list) || list.contains(root))) roots.push(list);
    }
    const rows = roots.flatMap(root => [...root.querySelectorAll<HTMLElement>('.__menu-item[tabindex="0"], button[data-list-navigation-item="true"]')].filter(visible));
    const exactText = (row: HTMLElement) => [row, ...row.querySelectorAll("*")].some(element =>
      element.children.length === 0 && (element.textContent ?? "").replace(/\s+/g, " ").trim() === operation.appName);
    const exact = rows.filter(exactText);
    const state: LauncherConnectorState = { text: readText(), selected, menuCount: roots.length, exactRows: exact.length,
      titles: rows.map(row => [...row.querySelectorAll("*")].find(element => element.children.length === 0 && element.textContent?.trim())?.textContent?.trim()
        ?? row.innerText.split("\n")[0]?.trim() ?? "").filter(Boolean), failure: uiFailure() };
    if (roots.length > 1 || exact.length > 1) throw new Error("ChatGPT owned connector menu is not unique");
    if (operation.kind === "connector-state" || state.failure) return state;
    if (roots.length !== 1 || exact.length !== 1 || state.text.trim() !== "@" + operation.appName
      || selected.length !== 0 || document.activeElement !== editor) throw new Error("ChatGPT owned connector query or menu changed before selection");
    const row = exact[0]!;
    if (row.getAttribute("aria-disabled") === "true" || (row instanceof HTMLButtonElement && row.disabled)) throw new Error("ChatGPT owned connector row is disabled");
    if (row instanceof HTMLButtonElement) row.click();
    else row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true,
      button: 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    return { ...state, activated: true };
  }
  if (operation.kind === "send-state" || operation.kind === "send") {
    const form = editor.closest("form");
    if (!form || !operation.sendSelector) throw new Error("ChatGPT owned composer form is unavailable");
    const buttons = [...form.querySelectorAll<HTMLButtonElement>(operation.sendSelector)].filter(visible);
    const mentionCount = editor.querySelectorAll(mentions).length;
    const clone = editor.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(mentions + ', [data-inline-selection-pill-cursor-target]').forEach(element => element.remove());
    const raw = mentionCount === 1 ? [...clone.childNodes].map(child => child.textContent ?? "").join("\n") : undefined;
    const state: LauncherSendState = { visibleCount: buttons.length,
      enabled: buttons.length === 1 && !buttons[0]!.disabled && buttons[0]!.getAttribute("aria-disabled") !== "true",
      mentionCount, raw };
    state.failure = uiFailure();
    if (operation.kind === "send-state") return state;
    if (state.failure) return { ...state, activated: false };
    if (!state.enabled) throw new Error("ChatGPT owned Send button is unavailable or disabled");
    if (state.raw !== operation.expectedRaw || state.mentionCount !== operation.mentionCount) return { ...state, activated: false };
    // The original form owns this single click. Submission evidence, never the click itself,
    // confirms delivery; an observation timeout must not activate Send again.
    buttons[0]!.click();
    return { ...state, activated: true };
  }
  if (operation.kind === "connectors") return [...editor.querySelectorAll(mentions)].filter(visible)
    .map(element => element.getAttribute("data-keyword") ?? element.getAttribute("app-mention-display-name") ?? "");
  if (operation.kind === "text") return readText();
  editor.focus({ preventScroll: true });
  if (document.activeElement !== editor) throw new Error("ChatGPT owned editor focus was not confirmed");
  if (operation.kind === "focus") return true;
  if (operation.kind === "clear") {
    for (const type of ["keydown", "keyup"]) editor.dispatchEvent(new KeyboardEvent(type, {
      key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  }
  const selection = document.getSelection();
  if (!selection) throw new Error("ChatGPT owned editor selection unavailable");
  // Transport insertion always appends to this editor. A retained collapsed
  // caret can remain inside a cleared inline pill cursor, whose content is
  // deliberately excluded from prompt readback. Put the caret at the editor's
  // own boundary on every operation rather than inheriting that stale subtree.
  const range = document.createRange();
  range.selectNodeContents(editor);
  if (operation.kind !== "clear") range.collapse(false);
  selection.removeAllRanges(); selection.addRange(range);
  if (operation.kind === "clear") { document.execCommand("delete", false); return true; }
  if (operation.kind === "end") return true;
  if (!selection.isCollapsed || !selection.anchorNode || !editor.contains(selection.anchorNode)) return false;
  return document.execCommand("insertText", false, operation.text ?? "");
}

/** Read the same owned model/effort guards without resolving hidden element handles. */
export async function inspectOwnedLauncherEffort({ composerSelector, controlSelector, verifyFamily, select, readinessTimeoutMs = 0 }: {
  composerSelector: string; controlSelector: string; verifyFamily: boolean;
  select?: { effortIndex: number; modelFamily?: "5.6" | "6" };
  readinessTimeoutMs?: number;
}) {
  const visible = (element: Element) => {
    const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };
  const checkUiFailure = () => {
    const notices = [...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(visible)
      .map(element => ({ role: element.getAttribute("role"), text: (element.textContent ?? "").replace(/\s+/g, " ") }));
    if (notices.some(row => /Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i.test(row.text))) throw new Error("owned_picker_failure:session_expired");
    if (notices.some(row => row.role === "alert" && /Failed to load subscription/i.test(row.text))) throw new Error("owned_picker_failure:subscription_unavailable");
    if (notices.some(row => row.role === "dialog"
      && /Too many requests|太多要求|太多请求|リクエストが多すぎます|요청이 너무 많습니다|요청을 너무 빠르게|너무 많은 요청/i.test(row.text)
      && /making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます|요청을 너무 빠르게|요청이 너무 많습니다|너무 많은 요청/i.test(row.text))) throw new Error("owned_picker_failure:rate_limited");
  };
  checkUiFailure();
  const composers = [...document.querySelectorAll<HTMLElement>(composerSelector)].filter(visible);
  if (composers.length !== 1) throw new Error("ChatGPT owned composer is not unique");
  const composer = composers[0]!, form = composer.closest("form");
  // A new saved-chat page can hydrate its model control after the editor. Keep
  // the original selection readiness budget without resolving background handles.
  // This is only a wait for an absent control; ambiguous or changed owners fail.
  const readinessDeadline = Date.now() + readinessTimeoutMs;
  let controls: HTMLElement[];
  do {
    checkUiFailure();
    const current = [...document.querySelectorAll<HTMLElement>(composerSelector)].filter(visible);
    if (current.length !== 1 || current[0] !== composer || !composer.isConnected || !form?.isConnected
      || composer.closest("form") !== form) throw new Error("ChatGPT owned composer changed before effort selection");
    controls = [...form.querySelectorAll<HTMLElement>(controlSelector)].filter(visible);
    if (controls.length > 1) throw new Error("ChatGPT owned effort control is not unique");
    if (controls.length === 1) break;
    if (Date.now() >= readinessDeadline) throw new Error("ChatGPT owned effort control did not become ready");
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (true);
  const control = controls[0]!, label = control.innerText.trim();
  if ((!select && control.getAttribute("aria-expanded") !== "false") || !composer.isContentEditable) {
    throw new Error("ChatGPT owned effort is not ready");
  }
  const state = { url: location.href, label, closedLabel: label,
    rows: [] as { label: string; checked: boolean }[],
    slider: undefined as { min: string | null; max: string | null; value: string | null } | undefined,
    descriptions: [] as string[] };
  if (!verifyFamily && !select) return state;
  const menuForControl = () => {
    const id = control.getAttribute("aria-controls");
    const menus = id ? [document.getElementById(id)].filter((element): element is HTMLElement => !!element)
      : [...document.querySelectorAll<HTMLElement>('[role="menu"]')].filter(element =>
        !!control.id && (element.getAttribute("aria-labelledby") ?? "").split(/\s+/).includes(control.id));
    if (menus.length > 1) throw new Error("ChatGPT owned effort menu is not unique");
    return menus[0];
  };
  const pointer = { bubbles: true, cancelable: true, composed: true, button: 0,
    buttons: 1, pointerId: 1, pointerType: "mouse", isPrimary: true };
  const click = (element: HTMLElement) => {
    if (!element.isConnected) throw new Error("ChatGPT owned picker control detached");
    const down = element.dispatchEvent(new PointerEvent("pointerdown", pointer));
    if (down && element.dispatchEvent(new MouseEvent("mousedown", pointer))) element.focus();
    element.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("mouseup", { ...pointer, buttons: 0 }));
    element.dispatchEvent(new MouseEvent("click", { ...pointer, buttons: 0, detail: 1 }));
  };
  const key = (element: HTMLElement | Document, name: string) => {
    const event = { key: name, code: name, bubbles: true, cancelable: true };
    element.dispatchEvent(new KeyboardEvent("keydown", event));
    element.dispatchEvent(new KeyboardEvent("keyup", event));
  };
  const open = async () => {
    if (control.getAttribute("aria-expanded") !== "true") click(control);
    const deadline = Date.now() + 5_000;
    let menu: HTMLElement | undefined;
    do {
      menu = menuForControl();
      if (menu && visible(menu) && control.getAttribute("aria-expanded") === "true") break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (Date.now() < deadline);
    if (!menu || !visible(menu) || control.getAttribute("aria-expanded") !== "true") throw new Error("ChatGPT owned effort menu did not open");
    return menu;
  };
  const close = async () => {
    if (control.getAttribute("aria-expanded") !== "true") return;
    key(menuForControl() ?? document, "Escape");
    const deadline = Date.now() + 1_000;
    while (control.getAttribute("aria-expanded") !== "false" && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (control.getAttribute("aria-expanded") !== "false") throw new Error("ChatGPT owned effort menu did not close");
  };
  const labelOf = (element: HTMLElement) => (element.innerText || element.textContent || "").replace(/\s+/g, " ").trim();
  const familyPattern = select?.modelFamily === "5.6" ? /^GPT[-\s]?5\.6\s+Sol(?:\s+Pro)?$/i
    : /^(?:Latest|最新|최신|GPT[-\s]?6(?:\s+Astra)?(?:\s+Pro)?)$/i;
  const familyRow = (menu: HTMLElement) => {
    const rows = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].filter(element => familyPattern.test(labelOf(element)));
    if (rows.length !== 1) throw new Error("ChatGPT owned model family is not unique");
    return rows[0]!;
  };
  const read = (menu: HTMLElement) => {
    checkUiFailure();
    const currentComposers = [...document.querySelectorAll<HTMLElement>(composerSelector)].filter(visible);
    const currentControls = [...form!.querySelectorAll<HTMLElement>(controlSelector)].filter(visible);
    if (currentComposers.length !== 1 || currentComposers[0] !== composer || !composer.isConnected
      || composer.closest("form") !== form || !form!.isConnected || currentControls.length !== 1
      || currentControls[0] !== control) throw new Error("ChatGPT owned composer changed during effort verification");
    if (menuForControl() !== menu || !menu.isConnected || !visible(menu) || control.getAttribute("aria-expanded") !== "true") throw new Error("ChatGPT owned effort menu changed");
    const containers = [...menu.querySelectorAll<HTMLElement>('[data-model-reasoning-effort-slider], [data-model-picker-power-slider]')].filter(visible);
    if (containers.length > 1) throw new Error("ChatGPT owned effort container is not unique");
    if (containers.length === 0) return undefined;
    const container = containers[0]!, sliders = [...container.querySelectorAll<HTMLElement>('[role="slider"]')];
    if (sliders.length > 1) throw new Error("ChatGPT owned effort slider is not unique");
    if (sliders.length === 0) return undefined;
    const slider = sliders[0]!;
    state.rows = [...menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]')]
      .map(element => ({ label: labelOf(element), checked: element.getAttribute("aria-checked") === "true" }));
    state.slider = { min: slider.getAttribute("aria-valuemin"), max: slider.getAttribute("aria-valuemax"), value: slider.getAttribute("aria-valuenow") };
    state.descriptions = (slider.closest('[role="menuitem"]')?.getAttribute("aria-describedby") ?? "")
      .split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent ?? "");
    const power = container.hasAttribute("data-model-picker-power-slider")
      && !!container.querySelector('[data-orientation="horizontal"][aria-disabled="false"]');
    const locks = [...container.querySelectorAll('[data-selected]')].map(tick => tick.getAttribute("data-locked") ?? (power ? "false" : null));
    return { slider, locks, min: state.slider.min, max: state.slider.max, value: state.slider.value };
  };
  const readyRead = async (menu: HTMLElement, deadline: number) => {
    // Menu geometry can become visible before its slider is mounted. Wait only
    // for absence, under the existing availability budget and the same owner.
    do {
      const raw = read(menu);
      if (raw) return raw;
      if (Date.now() >= deadline) throw new Error("ChatGPT owned effort container or slider did not become ready");
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
  };
  const available = async (menu: HTMLElement) => {
    const deadline = Date.now() + 1_000;
    do {
      const raw = await readyRead(menu, deadline);
      if (![raw.min, raw.max, raw.value].every(value => value !== null && /^-?\d+$/.test(value))) throw new Error("ChatGPT owned effort exposed an invalid ARIA range");
      const min = Number(raw.min), max = Number(raw.max), value = Number(raw.value);
      if (![min, max, value].every(Number.isSafeInteger) || max < min || max - min > 4 || value < min || value > max) throw new Error("ChatGPT owned effort exposed an invalid ARIA range");
      if (raw.locks.length === max - min + 1 && raw.locks.every(lock => lock === "true" || lock === "false")) {
        const index = select!.effortIndex;
        if (!Number.isInteger(index) || index < 0 || index > max - min) throw new Error(`ChatGPT owned effort does not expose item index ${index} (min=${min}; max=${max})`);
        if (raw.locks[index] !== "false") throw new Error("chatgpt_effort_locked: ChatGPT locks the requested browser effort behind an upgrade");
        return { min, max, value, slider: raw.slider };
      }
      if (Date.now() >= deadline) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    } while (true);
    throw new Error("ChatGPT owned effort availability could not be verified from its slider ticks");
  };
  try {
    let menu = await open();
    if (select) {
      if (select.modelFamily && familyRow(menu).getAttribute("aria-checked") !== "true") {
        const views = [...menu.querySelectorAll<HTMLElement>('[data-model-picker-view]')];
        if (views.length > 1) throw new Error("ChatGPT owned model view is not unique");
        const view = views[0];
        const collapsed = view ? view.getAttribute("data-model-picker-view") === "simple" : true;
        if (view && !["simple", "advanced"].includes(view.getAttribute("data-model-picker-view") ?? "")) throw new Error("ChatGPT owned model view is unknown");
        if (collapsed) {
          const triggers = [...(view ?? menu).querySelectorAll<HTMLElement>(view
            ? '[data-model-picker-view-toggle="true"][aria-hidden="false"]'
            : '[role="menuitem"][aria-expanded][aria-hidden="false"]')].filter(visible);
          if (triggers.length !== 1) throw new Error("ChatGPT owned model view toggle is not unique");
          if (view || triggers[0]!.getAttribute("aria-expanded") === "false") click(triggers[0]!);
        }
        const deadline = Date.now() + 1_000;
        while (!visible(familyRow(menu)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
        const row = familyRow(menu);
        if (!visible(row)) throw new Error("ChatGPT owned model choice did not open");
        click(row);
        await close();
        menu = await open();
        if (familyRow(menu).getAttribute("aria-checked") !== "true") throw new Error("ChatGPT did not retain the requested model family");
      }
      let current = await available(menu);
      const origin = current.min, target = origin + select.effortIndex;
      while (current.value !== target) {
        const direction = target > current.value ? 1 : -1, previous = current.value;
        const keyboardControl = current.slider.closest<HTMLElement>('[role="menuitem"]');
        if (!keyboardControl || !menu.contains(keyboardControl)) throw new Error("ChatGPT owned slider has no keyboard control");
        keyboardControl.focus();key(keyboardControl, direction > 0 ? "ArrowRight" : "ArrowLeft");
        const deadline = Date.now() + 5_000;
        do {
          current = await available(menu);
          if (current.min !== origin) throw new Error("ChatGPT changed its effort range origin during selection");
          if (current.value !== previous) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        if (current.value !== previous + direction) throw new Error("ChatGPT owned effort did not move exactly one keyboard step");
      }
      await close();menu = await open();
      const confirmed = await available(menu);
      if (confirmed.min !== origin || confirmed.value !== target) throw new Error("ChatGPT did not persist the requested effort after closing its menu");
      if (select.modelFamily && familyRow(menu).getAttribute("aria-checked") !== "true") throw new Error("ChatGPT changed its model family during effort selection");
    } else await readyRead(menu, Date.now() + 1_000);
  } finally {
    await close();
  }
  state.closedLabel = control.innerText.trim();
  if (!composer.isConnected || !composer.isContentEditable) throw new Error("ChatGPT owned composer changed during effort verification");
  checkUiFailure();
  return state;
}

async function launcherComposerOperation(page: Page, operation: LauncherComposerOperation, signal?: AbortSignal) {
  throwIfPromptAttachmentAborted(signal);
  const result = await withBrowserTurnAbort(withChatGptBrowserObservationTimeout(
    page.evaluate(operateOwnedLauncherComposer, { selector: CHATGPT_COMPOSER_SELECTOR, operation }),
  ), signal);
  throwIfPromptAttachmentAborted(signal);
  return result;
}

export class ChatGptBrowserWorker {
  static forProvider(provider: CodexProviderConfig): ChatGptBrowserWorker {
    const config = resolveBrowserConfig(provider);
    const key = JSON.stringify(config);
    let worker = workers.get(key);
    if (!worker) {
      worker = new ChatGptBrowserWorker(config);
      workers.set(key, worker);
    }
    return worker;
  }

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private managedBrowserReady?: Promise<{ browser: Browser; context: BrowserContext }>;
  private launcherHelper?: LauncherBrowserHelperClient;
  private maintenanceTail: Promise<void> = Promise.resolve();
  private readonly activeRuns = new Map<string, Promise<string>>();

  private constructor(private readonly config: ResolvedBrowserConfig) {}

  /**
   * Lexical/contenteditable may preserve runs of ASCII spaces by exposing some of them as NBSP
   * through DOM textContent. Treat that DOM-only representation as equivalent only when the
   * expected U+0020 belongs to a multi-space run. Single spaces, tabs, newlines, intentional
   * expected NBSP characters, and every other mutation remain exact and fail closed.
   */
  private promptCodeUnitEquivalent(
    expected: string,
    observed: string,
    index: number,
  ): boolean {
    const expectedUnit = expected[index];
    const observedUnit = observed[index];

    if (expectedUnit === observedUnit) return true;
    if (expectedUnit !== " " || observedUnit !== "\u00A0") return false;

    return expected[index - 1] === " " || expected[index + 1] === " ";
  }

  private promptTextEquivalent(
    expected: string,
    observed: string,
  ): boolean {
    if (expected.length !== observed.length) return false;

    for (let index = 0; index < expected.length; index += 1) {
      if (!this.promptCodeUnitEquivalent(expected, observed, index)) {
        return false;
      }
    }

    return true;
  }

  private promptEquivalentPrefixLength(
    expected: string,
    observed: string,
  ): number {
    const length = Math.min(expected.length, observed.length);

    let index = 0;
    while (
      index < length
      && this.promptCodeUnitEquivalent(expected, observed, index)
    ) {
      index += 1;
    }

    return index;
  }

  run(turn: BrowserTurn): Promise<string> {
    if (this.activeRuns.has(turn.traceId)) {
      return Promise.reject(new Error(`Duplicate ChatGPT web browser turn: ${turn.traceId}`));
    }
    if (this.activeRuns.size >= MAX_CHATGPT_BROWSER_TABS) {
      return Promise.reject(new Error(
        `ChatGPT Web supports at most ${MAX_CHATGPT_BROWSER_TABS} simultaneous browser turns; close or finish a browser tab before starting another`,
      ));
    }
    const useHelper = this.config.browserHost === "launcher" && process.env.CODEX_CHATGPT_WEB_BROWSER_HELPER_PROCESS !== "1";
    if (useHelper) {
      this.launcherHelper ??= new LauncherBrowserHelperClient(this.config);
    }
    const run = Promise.resolve().then(() => useHelper ? this.launcherHelper!.run(turn) : this.runExclusive(turn));
    this.activeRuns.set(turn.traceId, run);
    void run.finally(() => {
      if (this.activeRuns.get(turn.traceId) === run) this.activeRuns.delete(turn.traceId);
    }).catch(() => {});
    return run;
  }

  verifyConnector(traceId = `verify_${randomUUID().replaceAll("-", "")}`): Promise<string> {
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(traceId)) {
      return Promise.reject(new Error("ChatGPT connector verification trace id is invalid"));
    }
    return this.enqueueMaintenance("connector verification", () => this.verifyConnectorExclusive(traceId));
  }

  inspectSession(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    extraHighAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    return this.enqueueMaintenance("session inspection", () => this.inspectSessionExclusive(detectCapabilities));
  }

  smokeTest(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    return this.enqueueMaintenance("smoke test", () => this.smokeTestExclusive(abortSignal));
  }

  inspectLimitsPlan() {
    return this.enqueueMaintenance("Limits setup", async () => {
      const page = await this.ensurePage();
      await this.prepareChatSurface(page);
      return detectChatGptLimitsPlan(page);
    });
  }

  private enqueueMaintenance<T>(name: string, action: () => Promise<T>): Promise<T> {
    const operation = this.maintenanceTail.then(() => {
      if (this.activeRuns.size > 0) {
        throw new Error(`ChatGPT ${name} requires all browser turns to finish`);
      }
      return action();
    });
    this.maintenanceTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async close(): Promise<void> {
    if (this.launcherHelper) {
      const helper = this.launcherHelper;
      this.launcherHelper = undefined;
      await helper.close();
    }
    await Promise.allSettled([...this.activeRuns.values()]);
    await this.maintenanceTail;
    const browser = this.browser;
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.managedBrowserReady = undefined;
    // For connectOverCDP, Playwright implements Browser.close as a transport disconnect; it does
    // not close the launcher-owned Electron process. Always release that connection and its
    // artifact directory instead of leaking one per timeout/helper lifecycle.
    if (browser) await browser.close();
  }

  private async runStage<T>(
    traceId: string,
    stage: string,
    timeoutMs: number,
    action: (abortSignal: AbortSignal) => Promise<T>,
    suspensionClock: Pick<ChatGptSuspensionClock, "suspendedMs"> = chatGptSuspensionClock,
    awaitAbortedActionSettlement = false,
  ): Promise<T> {
    chatGptSuspensionClock.start();
    const startedAt = performance.now();
    const suspendedAtStart = suspensionClock.suspendedMs();
    console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} started`);
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stageTimedOut = false;
    let actionPromise: Promise<T> | undefined;
    try {
      const timeout = new Promise<never>((_, rejectTimeout) => {
        const fireOrRearm = () => {
          // A stage that spans a system sleep has not consumed its budget: the browser was as
          // frozen as this process, so slept time is refunded before the timer is re-armed.
          const suspendedMs = suspensionClock.suspendedMs() - suspendedAtStart;
          const remaining = remainingStageBudgetMs(timeoutMs, performance.now() - startedAt, suspendedMs);
          if (remaining > 0) {
            timer = setTimeout(fireOrRearm, remaining);
            return;
          }
          stageTimedOut = true;
          controller.abort();
          rejectTimeout(new Error(`ChatGPT browser stage timed out: ${stage}`));
        };
        timer = setTimeout(fireOrRearm, timeoutMs);
      });
      actionPromise = action(controller.signal);
      const value = await Promise.race([actionPromise, timeout]);
      console.info(`[chatgpt-web] browser turn ${traceId} stage=${stage} completed durationMs=${Math.round(performance.now() - startedAt)}`);
      return value;
    } catch (error) {
      let surfacedError = error;
      if (stageTimedOut && awaitAbortedActionSettlement && actionPromise) {
        try {
          await actionPromise;
        } catch (settlementError) {
          if (settlementError instanceof ChatGptPersistentBrowserStateError) {
            surfacedError = settlementError;
          }
        }
      }
      console.error(`[chatgpt-web] browser turn ${traceId} stage=${stage} failed durationMs=${Math.round(performance.now() - startedAt)}: ${surfacedError instanceof Error ? surfacedError.message : String(surfacedError)}`);
      throw surfacedError;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (this.config.browserHost === "launcher") {
      const connection = await connectLauncherBrowserHost(this.config.browserHostDescriptorPath!);
      this.browser = connection.browser;
      this.context = connection.context;
      this.page = connection.page;
      return this.page;
    }
    if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
      throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
    }
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
    }
    this.browser = await chromium.launch({
      executablePath: this.config.chromeExecutablePath,
      headless: !this.config.headed,
    });
    this.context = await this.browser.newContext({ storageState: this.config.storageStatePath });
    this.page = await this.context.newPage();
    return this.page;
  }

  private async ensureManagedBrowser(): Promise<{ browser: Browser; context: BrowserContext }> {
    if (this.managedBrowserReady) return this.managedBrowserReady;
    const opening = (async () => {
      if (!existsSync(this.config.storageStatePath) || !existsSync(loginVerificationMarkerPath(this.config.storageStatePath))) {
        throw new Error(`ChatGPT web login state is missing: ${this.config.storageStatePath}`);
      }
      if (!existsSync(this.config.chromeExecutablePath)) {
        throw new Error(`Configured Chrome executable does not exist: ${this.config.chromeExecutablePath}`);
      }
      const browser = await chromium.launch({
        executablePath: this.config.chromeExecutablePath,
        headless: !this.config.headed,
      });
      const context = await browser.newContext({ storageState: this.config.storageStatePath });
      this.browser = browser;
      this.context = context;
      return { browser, context };
    })();
    this.managedBrowserReady = opening;
    try {
      return await opening;
    } catch (error) {
      if (this.managedBrowserReady === opening) this.managedBrowserReady = undefined;
      throw error;
    }
  }

  /**
   * A Codex turn owns one isolated browser conversation. Reusing the same
   * ChatGPT SPA page can retain the previous transcript and autocomplete DOM,
   * so an @app lookup may select stale UI from the preceding turn.
   */
  private async pageForNewTurn(): Promise<Page> {
    if (this.config.browserHost === "launcher") {
      throw new Error("Launcher turns require an explicitly leased browser surface");
    }
    const { context } = await this.ensureManagedBrowser();
    return await context.newPage();
  }

  private async selectModelAndEffort(
    page: Page,
    modelId: string,
    reasoning: string | undefined,
    capabilities: ChatGptWebCapabilities,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    trackUsage = false,
    modelFamily?: "5.6" | "6",
  ): Promise<SelectedChatGptWebModelMode> {
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const uiEffortIndex = mode.uiEffortIndex;
    if (this.config?.browserHost === "launcher" && uiEffortIndex !== null) {
      // Selection and its persisted check use the same composer-owned public DOM
      // transaction as pre-send verification, including retained summary turns.
      try {
        // Saved-chat navigation can reset CDP's effective viewport after the
        // page-acquisition check. A mounted editor is not yet an operational
        // picker: wait on this exact page before its first control activation.
        await waitForOperationalChatGptViewport(page);
        const state = await withChatGptBrowserObservationTimeout(page.evaluate(inspectOwnedLauncherEffort, {
          composerSelector: CHATGPT_COMPOSER_SELECTOR, controlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR, verifyFamily: true,
          select: { effortIndex: uiEffortIndex, ...(modelFamily ? { modelFamily } : {}) },
          readinessTimeoutMs: 70_000,
        }));
        const slider = state.slider && parseChatGptEffortSliderState(state.slider.min, state.slider.max, state.slider.value);
        if (state.url !== page.url() || !state.closedLabel || !slider || slider.value !== slider.min + uiEffortIndex
          || (modelFamily && !chatGptModelFamilyMatches(state.descriptions, modelFamily, mode.effort))) throw new Error("ChatGPT changed the requested model or effort during selection");
        const selectedMode: SelectedChatGptWebModelMode = {
          ...mode, ...(modelFamily ? { modelFamily } : {}),
          selection: { url: state.url, label: state.closedLabel },
          ...(trackUsage ? { usageModel: mode.effort === "max" ? chatGptUsageModelFromAnnouncements(state.descriptions) : "other" as const } : {}),
        };
        await captureDiagnostic?.("effort-selection-confirmed");
        return selectedMode;
      } catch (cause) {
        if (cause instanceof ChatGptWebAdapterError || cause instanceof ChatGptBrowserObservationTimeoutError) throw cause;
        throwLauncherSendFailure(String(cause).match(/owned_picker_failure:(session_expired|subscription_unavailable|rate_limited)/)?.[1] as LauncherSendFailure | undefined);
        if (String(cause).includes("chatgpt_effort_locked:")) throw new ChatGptWebAdapterError(
          "ChatGPT locks the browser option requested for this effort behind an upgrade. The message was not sent.",
          { status: 400, errorType: "invalid_request_error", code: "chatgpt_effort_locked", retryable: false, cause },
        );
        throw chatGptModelControlUnavailableAdapterError("ChatGPT could not select and retain the requested model and effort in its owned composer", cause instanceof Error ? cause.message : String(cause));
      }
    }
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    if (uiEffortIndex === null) {
      await settleChatGptUi();
      await throwIfChatGptRateLimitDialog(page);
      const visibleControls = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
      if (await visibleControls.count() > 0) {
        throw chatGptModelControlUnavailableError(
          "ChatGPT Luna was selected from a Luna-only capability probe, but the account now exposes a model selector; rerun setup",
        );
      }
      // Enable Think during prompt attachment, after fresh connector selection. Ordinary Luna
      // still clears a previous Think selection here; retained Think is checked on every attach.
      if (!mode.thinkEnabled) await setChatGptThinkMode(composerForm, false, captureDiagnostic);
      return mode;
    }
    const currentEffort = composerForm.locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
    const effortWaitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        currentEffort.waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "effort" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: effortWaitAbort.signal }).then(() => "session-expired" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw chatGptModelControlUnavailableError(
        "ChatGPT rendered the composer but its model/effort control did not become ready",
      );
    } finally {
      effortWaitAbort.abort();
    }
    await settleChatGptUi();
    await throwIfChatGptRateLimitDialog(page);
    // Full DOM captures of every picker transition can consume the selection
    // deadline on a large managed page. Keep the final verified selection and
    // failure captures by default; detailed transition capture is opt-in.
    const detailedPickerDiagnostics = process.env.CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS === "1";
    if (detailedPickerDiagnostics) await captureDiagnostic?.("effort-control-ready");
    await throwIfChatGptRateLimitDialog(page);
    let activation = await activateChatGptEffortMenu(page, currentEffort);
    if (modelFamily) activation = await selectChatGptModelFamily(
      page, activation, modelFamily, () => activateChatGptEffortMenu(page, currentEffort),
    );
    if (detailedPickerDiagnostics) await captureDiagnostic?.("effort-menu-open-requested");
    const effortSlider = activation.slider;
    const sliderContainer = activation.sliderContainer;
    const waitAbort = new AbortController();
    try {
      const ready = await Promise.race([
        sliderContainer.waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal })
          .then(() => effortSlider.waitFor({ state: "attached", timeout: 70_000, signal: waitAbort.signal }))
          .then(() => "slider" as const),
        chatGptRateLimitDialog(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "rate-limit" as const),
        chatGptExpiredSessionAlert(page).waitFor({ state: "visible", timeout: 70_000, signal: waitAbort.signal }).then(() => "session-expired" as const),
      ]);
      if (ready === "rate-limit") await throwIfChatGptRateLimitDialog(page);
      if (ready === "session-expired") await throwIfChatGptSessionFailureAlert(page);
      if (detailedPickerDiagnostics) await captureDiagnostic?.("effort-slider-visible");
    } catch (error) {
      if (error instanceof ChatGptWebAdapterError) throw error;
      await throwIfChatGptRateLimitDialog(page);
      await throwIfChatGptSessionFailureAlert(page);
      throw chatGptModelControlUnavailableAdapterError(
        `ChatGPT effort slider did not become ready for item index ${uiEffortIndex}`,
      );
    } finally {
      waitAbort.abort();
    }
    const selectionUrl = page.url();
    const readAvailableEffort = async (container: Locator, menu: Locator) => {
      const state = await readChatGptEffortSnapshot(container)
        .catch(error => { throw chatGptModelControlUnavailableAdapterError(String(error)); });
      if (uiEffortIndex > state.max - state.min) {
        const detail = uiEffortIndex === 4 ? await chatGptUnavailableProDetail(menu) : undefined;
        throw chatGptModelControlUnavailableAdapterError(
          `ChatGPT effort slider does not expose item index ${uiEffortIndex} (min=${state.min}; max=${state.max})`
          + (uiEffortIndex === 4 ? " ChatGPT may have temporarily hidden Pro because you reached its usage limit." : ""),
          detail,
        );
      }
      if (!state.available[uiEffortIndex]) {
        throw new ChatGptWebAdapterError(
          `ChatGPT locks the browser option requested for ${mode.displayLabel} behind an upgrade. `
          + "The message was not sent. Choose an available effort and run Repair Codex setup to refresh the model list.",
          { status: 400, errorType: "invalid_request_error", code: "chatgpt_effort_locked", retryable: false },
        );
      }
      return state;
    };
    let sliderState = await readAvailableEffort(sliderContainer, activation.menu);
    const initialMin = sliderState.min;
    const targetValue = initialMin + uiEffortIndex;
    const sliderControl = effortSlider.locator("xpath=ancestor::*[@role='menuitem'][1]");
    while (sliderState.value !== targetValue) {
      await throwIfChatGptRateLimitDialog(page);
      const direction = targetValue > sliderState.value ? 1 : -1;
      const key = direction > 0 ? "ArrowRight" : "ArrowLeft";
      const previousValue = sliderState.value;
      await sliderControl.press(key);
      const changeDeadline = Date.now() + 5_000;
      do {
        sliderState = await readAvailableEffort(sliderContainer, activation.menu);
        if (sliderState.min !== initialMin) {
          throw chatGptModelControlUnavailableError("ChatGPT changed its effort range origin during selection");
        }
        if (sliderState.value !== previousValue) break;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 50));
      } while (Date.now() < changeDeadline);
      if (sliderState.value !== previousValue + direction) {
        throw chatGptModelControlUnavailableError(
          `ChatGPT effort slider did not move exactly one step with ${key}`
          + ` (before=${previousValue}; after=${sliderState.value})`,
        );
      }
    }
    await settleChatGptUi();
    const selectedState = await readAvailableEffort(sliderContainer, activation.menu);
    if (selectedState.min !== initialMin || selectedState.value !== targetValue) {
      throw chatGptModelControlUnavailableAdapterError("ChatGPT changed its effort range or selection before the menu closed");
    }
    if (detailedPickerDiagnostics) await captureDiagnostic?.("effort-selected");
    await page.keyboard.press("Escape");
    await settleChatGptUi();
    // While open, the trigger reads "Thinking effort", not the selected value. Read its
    // closed label and reopen the menu once to prove the selection survived the commit.
    const selectedMode: SelectedChatGptWebModelMode = {
      ...mode,
      ...(modelFamily ? { modelFamily } : {}),
      selection: { url: selectionUrl, label: (await currentEffort.innerText()).trim() },
    };
    await this.assertSelectedEffort(page, selectedMode, false);
    const confirmation = await activateChatGptEffortMenu(page, currentEffort);
    await confirmation.slider.waitFor({ state: "attached", timeout: 5_000 });
    const confirmedState = await readAvailableEffort(confirmation.sliderContainer, confirmation.menu);
    if (confirmedState.min !== initialMin || confirmedState.value !== targetValue) {
      throw chatGptModelControlUnavailableAdapterError("ChatGPT did not persist the requested effort after closing its menu");
    }
    if (modelFamily) await assertChatGptModelFamily(confirmation, modelFamily, mode.effort, uiEffortIndex, 1_000);
    // A bare 'Pro' trigger does not identify the family selected by ChatGPT's Latest option.
    // Unknown evidence remains visible as unclassified Pro usage in Limits.
    if (trackUsage) {
      selectedMode.usageModel = await readChatGptUsageModel(confirmation.slider, mode.effort === "max")
        .catch(() => mode.effort === "max" ? "pro-unknown" as const : "other" as const);
    }
    await page.keyboard.press("Escape");
    await settleChatGptUi();
    await this.assertSelectedEffort(page, selectedMode, false);
    await captureDiagnostic?.("effort-selection-confirmed");
    return selectedMode;
  }

  private async assertSelectedEffort(page: Page, mode: SelectedChatGptWebModelMode, verifyFamily = true): Promise<void> {
    if (!mode.selection) return;
    if (this.config?.browserHost === "launcher") {
      try {
        const familyCheck = verifyFamily && !!mode.modelFamily && mode.uiEffortIndex !== null;
        const state = await withChatGptBrowserObservationTimeout(page.evaluate(inspectOwnedLauncherEffort, {
          composerSelector: CHATGPT_COMPOSER_SELECTOR, controlSelector: CHATGPT_EFFORT_CONTROL_SELECTOR, verifyFamily: familyCheck,
        }));
        if (page.url() !== mode.selection.url || state.url !== mode.selection.url || !mode.selection.label
          || state.label !== mode.selection.label || state.closedLabel !== mode.selection.label) throw new Error("Selected effort changed");
        if (familyCheck) {
          const pattern = mode.modelFamily === "5.6" ? /^GPT[-\s]?5\.6\s+Sol(?:\s+Pro)?$/i : /^(?:Latest|最新|최신|GPT[-\s]?6(?:\s+Astra)?(?:\s+Pro)?)$/i;
          const rows = state.rows.filter(row => pattern.test(row.label));
          const slider = state.slider && parseChatGptEffortSliderState(state.slider.min, state.slider.max, state.slider.value);
          if (rows.length !== 1 || !rows[0]!.checked || !slider || slider.value !== slider.min + mode.uiEffortIndex!
            || !chatGptModelFamilyMatches(state.descriptions, mode.modelFamily!, mode.effort)) throw new Error("Selected model family changed");
        }
        return;
      } catch (cause) {
        throwLauncherSendFailure(String(cause).match(/owned_picker_failure:(session_expired|subscription_unavailable|rate_limited)/)?.[1] as LauncherSendFailure | undefined);
        throw chatGptModelControlUnavailableAdapterError("ChatGPT did not retain the selected model and effort before submission", cause instanceof Error ? cause.message : undefined);
      }
    }
    const composer = await this.activeComposer(page);
    const controls = composer.locator("xpath=ancestor::form[1]")
      .locator(CHATGPT_EFFORT_CONTROL_SELECTOR).filter({ visible: true });
    if (page.url() !== mode.selection.url || !mode.selection.label || await controls.count() !== 1) {
      throw chatGptModelControlUnavailableAdapterError("ChatGPT changed the selected model's browser surface before submission");
    }
    const control = controls.first();
    if ((await control.innerText()).trim() !== mode.selection.label
      || await control.getAttribute("aria-expanded") !== "false"
      || !await composer.isEditable()) {
      throw chatGptModelControlUnavailableAdapterError(
        "ChatGPT did not retain the selected effort in its ready composer; the message was not submitted",
      );
    }
    if (verifyFamily && mode.modelFamily && mode.uiEffortIndex !== null) {
      const menu = await activateChatGptEffortMenu(page, control);
      try {
        await assertChatGptModelFamily(menu, mode.modelFamily, mode.effort, mode.uiEffortIndex);
      } finally {
        await page.keyboard.press("Escape");
      }
      if (page.url() !== mode.selection.url || (await control.innerText()).trim() !== mode.selection.label
        || await control.getAttribute("aria-expanded") !== "false" || !await composer.isEditable()) {
        throw chatGptModelControlUnavailableAdapterError("ChatGPT changed the model while checking its family before submission");
      }
    }
  }

  private async activeComposer(
    page: Page,
    timeoutMs = 30_000,
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    const composers = page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true });
    const deadline = Date.now() + timeoutMs;
    let count = 0;
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      count = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(
          this.config?.browserHost === "launcher" ? launcherComposerOperation(page, { kind: "count" }, abortSignal).then(value => value as number) : composers.count(),
          Math.max(1, Math.min(CHATGPT_BROWSER_OBSERVATION_PROBE_TIMEOUT_MS, deadline - Date.now())),
        ),
        abortSignal,
      );
      if (count === 1) return composers.first();
      await withBrowserTurnAbort(
        new Promise(resolveSleep => setTimeout(resolveSleep, 50)),
        abortSignal,
      );
    }
    throw new Error(
      "ChatGPT composer is unavailable. Reload ChatGPT and retry the task.",
      { cause: new Error(`Visible ChatGPT composer count was ${count}`) },
    );
  }

  /** Prepare a new conversation; account inspection still uses an empty Temporary Chat. */
  private async prepareChatSurface(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    useSavedChats = false,
  ): Promise<Locator> {
    // Launcher verification refreshes its owned page before attaching Playwright so a newly added
    // connector is present in the catalog. Navigating again here destroys that freshly hydrated
    // document and made the first verification race a second SPA bootstrap. A leased turn starts on
    // about:blank and therefore still performs exactly one navigation through this same method.
    const targetUrl = chatGptNewChatUrl(useSavedChats);
    if (page.url() !== targetUrl) {
      // Navigate once, then use the bounded visible-composer and authenticated
      // new-chat checks below. Slow secondary resources must not turn an
      // already committed page into a false pre-send navigation failure.
      await page.goto(targetUrl, {
        waitUntil: "commit",
        timeout: 60_000,
      });
      await captureDiagnostic?.(useSavedChats ? "saved-chat-navigation-complete" : "temporary-chat-navigation-complete");
    }
    // A failed page read is not evidence of an expired login. Preserve the actual
    // observation error; the authenticated-session check below owns login failures.
    let composer: Locator;
    try {
      composer = await this.activeComposer(page, 180_000);
    } catch (cause) {
      // CLW: slow bootstrap is a browser readiness failure, not model capacity
      // or proof that the account expired. No message has been submitted here.
      throw new ChatGptWebAdapterError(
        "ChatGPT page is not ready; no message was sent. Check the browser connection and retry.",
        { status: 408, errorType: "invalid_request_error", code: "browser_not_ready", retryable: false, cause },
      );
    }
    if (!useSavedChats && await dismissChatGptTemporaryChatOnboarding(page)) {
      await captureDiagnostic?.("temporary-chat-onboarding-dismissed");
    }
    await captureDiagnostic?.("composer-ready");
    await throwIfChatGptSessionFailureAlert(page);
    await assertAuthenticatedChatGptPage(page);
    await assertNewChatPage(page, useSavedChats);
    await captureDiagnostic?.("session-verified");
    return composer;
  }

  private async waitForTurnDomMutation(page: Page, timeoutMs = 50): Promise<void> {
    await page.evaluate(({ timeout, attributeFilter }) => new Promise<void>(resolveMutation => {
      let settled = false;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeoutTimer);
        if (settleTimer) clearTimeout(settleTimer);
        resolveMutation();
      };
      const observer = new MutationObserver(() => {
        if (settleTimer) return;
        // Let one React mutation batch finish before the next compact state read.
        settleTimer = setTimeout(finish, 16);
      });
      observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter,
      });
      const timeoutTimer = setTimeout(finish, timeout);
    }), { timeout: timeoutMs, attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES] });
  }

  private async waitForTurnDomOrExternalProgress(
    page: Page,
    afterProgressRevision: number,
    externalProgress?: ChatGptTurnProgressReader,
    signal?: AbortSignal,
  ): Promise<void> {
    const domMutation = this.waitForTurnDomMutation(page);
    if (!externalProgress) {
      await withBrowserTurnAbort(domMutation, signal);
      return;
    }
    const progressWaitAbort = new AbortController();
    const progressSignal = signal
      ? AbortSignal.any([progressWaitAbort.signal, signal])
      : progressWaitAbort.signal;
    try {
      await withBrowserTurnAbort(Promise.race([
        domMutation,
        externalProgress.waitForChange(afterProgressRevision, progressSignal).then(() => undefined),
      ]), signal);
    } finally {
      progressWaitAbort.abort();
    }
  }

  private async waitForSubmissionAccepted(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
  ): Promise<ChatGptSubmissionEvidence> {
    if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if(this.config?.browserHost==="launcher"&&this.config.autoApproveToolCalls===true){
        await resolveChatGptToolConfirmation(page,this.config.appName,true,signal,CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,undefined,true);
      }
      const progress = externalProgress?.snapshot();
      if (progress
        && externalProgress
        && completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)) {
        const boundaryText = await this.currentSubmissionAnswerText(page, baseline, signal);
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (progress && progress.lastToolBatchRevision > initialToolBatchRevision) return "mcp_tool_call";
      if (this.config?.browserHost !== "launcher") {
        await throwIfChatGptSessionFailureAlert(page);
        await throwIfChatGptRateLimitDialog(page);
      }
      // Until the new response is bound, last() can still be a historical failed answer.
      // Response errors are checked against the bound current turn in the observation loops.
      let evidence: ChatGptSubmissionEvidence | undefined;
      if (externalProgress) {
        const progressWaitAbort = new AbortController();
        const progressSignal = signal
          ? AbortSignal.any([progressWaitAbort.signal, signal])
          : progressWaitAbort.signal;
        try {
          const observed = await withBrowserTurnAbort(Promise.race([
            this.currentSubmissionEvidence(page, baseline, signal).then(value => ({ kind: "dom" as const, value })),
            externalProgress.waitForChange(progress?.revision ?? 0, progressSignal)
              .then(() => ({ kind: "external" as const })),
          ]), signal);
          if (observed.kind === "external") continue;
          evidence = observed.value;
        } finally {
          progressWaitAbort.abort();
        }
      } else {
        evidence = await this.currentSubmissionEvidence(page, baseline, signal);
      }
      if (evidence) return evidence;
      await this.waitForTurnDomOrExternalProgress(
        page,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
    }
  }

  private async submissionDomState(
    page: Page,
    cache?: ChatGptSubmissionDomCache,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionDomState> {
    throwIfPromptAttachmentAborted(signal);
    const observed = await withChatGptBrowserObservationTimeout(withBrowserTurnAbort(page.evaluate(options => {
      type ObserverState = { id: string; revision: number; observer: MutationObserver };
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_TURN_OBSERVER__?: ObserverState;
      };
      const observerState = scope.__CODEX_WEB_GPT_TURN_OBSERVER__ ??= (() => {
        const state: ObserverState = {
          id: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
          revision: 0,
          observer: undefined as unknown as MutationObserver,
        };
        state.observer = new MutationObserver(() => {
          state.revision += 1;
        });
        state.observer.observe(document.documentElement, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: options.attributeFilter,
        });
        return state;
      })();
      const observerKey = `${observerState.id}:${observerState.revision}`;
      const identities = (elements: Element[], attribute: string): string[] => {
        const values = elements.map(element => element.getAttribute(attribute));
        if (values.some(value => typeof value !== "string" || value.trim().length === 0)) {
          throw new Error(`ChatGPT conversation turn has no stable ${attribute} identity`);
        }
        const typed = values as string[];
        if (new Set(typed).size !== typed.length) {
          throw new Error("ChatGPT exposed duplicate conversation turn identities");
        }
        return typed;
      };
      const visible = (element: Element): boolean => {
        const candidate = element as HTMLElement;
        const style = getComputedStyle(candidate);
        const bounds = candidate.getBoundingClientRect();
        return candidate.isConnected
          && style.visibility !== "hidden"
          && (bounds.width > 0 || bounds.height > 0);
      };
      // These availability checks belong to the same owned-page read as Send
      // acknowledgement. Hidden Locator probes can consume the entire Send
      // deadline even after the new user turn has already mounted.
      if (options.checkUiFailure) {
        const notices = [...document.querySelectorAll('[role="alert"], [role="dialog"]')].filter(visible)
          .map(element => ({ role: element.getAttribute("role"), text: (element.textContent ?? "").replace(/\s+/g, " ") }));
        let failure: LauncherSendFailure | undefined;
        if (notices.some(row => /Your session has expired|你的工作階段已過期|您的工作階段已過期|你的会话已过期|您的会话已过期/i.test(row.text))) failure = "session_expired";
        else if (notices.some(row => row.role === "alert" && /Failed to load subscription/i.test(row.text))) failure = "subscription_unavailable";
        else if (notices.some(row => row.role === "dialog"
          && /Too many requests|太多要求|太多请求|リクエストが多すぎます|요청이 너무 많습니다|요청을 너무 빠르게|너무 많은 요청/i.test(row.text)
          && /making requests too quickly|過於頻繁|过于频繁|リクエストの頻度が高すぎます|요청을 너무 빠르게|요청이 너무 많습니다|너무 많은 요청/i.test(row.text))) failure = "rate_limited";
        if (failure) return { key: observerKey, failure };
      }
      // CSS visibility can change without a mutation. Check live notices even
      // when the logical-turn snapshot is unchanged.
      if (options.knownKey === observerKey) return { key: observerKey };
      // data-testid contains a display index: ChatGPT can renumber it while the same turn lives.
      // Virtualization removes a turn's section, but retains its outer identity container.
      const containers = [...document.querySelectorAll("[data-turn-id-container]")].filter(element =>
        !element.closest("[data-turn-key]")
        && element.parentElement?.closest("[data-turn-id-container]")?.getAttribute("data-turn-id-container")
          !== element.getAttribute("data-turn-id-container"));
      const turnIdentities = identities(containers, "data-turn-id-container");
      const legacyTurns = (selector: string) => [...document.querySelectorAll(selector)]
        .filter(element => element.getAttribute("data-turn-key") == null);
      const userIdentities = identities(legacyTurns(options.userTurnSelector), "data-turn-id");
      const responseIdentities = identities(legacyTurns(options.assistantTurnSelector), "data-turn-id");
      const knownTurns = new Set(turnIdentities);
      if ([...userIdentities, ...responseIdentities].some(identity => !knownTurns.has(identity))) {
        throw new Error("ChatGPT conversation turn has no matching identity container");
      }
      const groups = [...document.querySelectorAll("[data-turn-key]")];
      const groupKeys = identities(groups, "data-turn-key");
      groups.forEach((group, index) => {
        const user = `group:user:${groupKeys[index]}`;
        const assistant = `group:assistant:${groupKeys[index]}`;
        // Keep both logical roles in the baseline even when virtualization unmounts their
        // contents. Remounting an old answer must never acknowledge a new submission.
        turnIdentities.push(user, assistant);
        if (group.querySelector("[data-user-message-bubble]")) userIdentities.push(user);
        if (group.querySelector('[data-conversation-role="assistant"], [data-chatgpt-agent-turn-start]')) responseIdentities.push(assistant);
      });
      return {
        key: observerKey,
        snapshot: {
          userTurnCount: userIdentities.length,
          assistantTurnCount: responseIdentities.length,
          visibleStopButtonCount: [...document.querySelectorAll(options.stopButtonSelector)].filter(visible).length,
          turnIdentities,
          userIdentities,
          responseIdentities,
        },
      };
    }, {
      userTurnSelector: CHATGPT_USER_TURN_SELECTOR,
      assistantTurnSelector: CHATGPT_ASSISTANT_TURN_SELECTOR,
      stopButtonSelector: CHATGPT_STOP_BUTTON_SELECTOR,
      knownKey: cache?.key,
      attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
      checkUiFailure: this.config?.browserHost === "launcher",
    }), signal));
    throwLauncherSendFailure(observed.failure);
    const snapshot = observed.snapshot ?? cache?.snapshot;
    if (!snapshot) throw new Error("ChatGPT turn DOM revision cache has no baseline snapshot");
    if (observed.snapshot && cache) {
      cache.key = observed.key;
      cache.snapshot = observed.snapshot;
      cache.fullScans = (cache.fullScans ?? 0) + 1;
    } else if (!observed.snapshot && cache?.snapshot) {
      cache.cacheHits = (cache.cacheHits ?? 0) + 1;
    }
    return snapshot;
  }

  private async currentSubmissionEvidence(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<ChatGptSubmissionEvidence | undefined> {
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const evidence = chatGptSubmissionEvidence({
      initialTurnIdentities: baseline.initialTurnIdentities,
      userIdentities: state.userIdentities,
      responseIdentities: state.responseIdentities,
      generationRunning: state.visibleStopButtonCount > 0,
    });
    await this.rememberSubmittedUserIdentity(page, baseline, state, signal);
    return evidence;
  }

  private async submittedUserTextMatches(
    page: Page,
    identity: string,
    submittedText: string,
    signal?: AbortSignal,
    connectorPadding?: string,
  ): Promise<"match" | "pending" | "mismatch"> {
    return withChatGptBrowserObservationTimeout(withBrowserTurnAbort(page.evaluate(({ key, submitted, padding }): "match" | "pending" | "mismatch" => {
      const groups = [...document.querySelectorAll<HTMLElement>("[data-turn-key]")]
        .filter(group => group.getAttribute("data-turn-key") === key);
      if (groups.length === 0) return "pending";
      if (groups.length !== 1) return "mismatch";
      const bubbles = groups[0]!.querySelectorAll<HTMLElement>("[data-user-message-bubble]");
      if (bubbles.length === 0) return "pending";
      if (bubbles.length !== 1) return "mismatch";
      const contents = bubbles[0]!.querySelectorAll<HTMLElement>("[data-search-result-target]");
      if (contents.length === 0) return "pending";
      if (contents.length !== 1) return "mismatch";
      const content = contents[0]!;
      const mentions = content.querySelectorAll<HTMLElement>(
        '[data-prompt-link-href^="app://"], [app-mention-path^="app://"]',
      );
      if (mentions.length > 1) return "mismatch";
      let text = content.innerText;
      if (mentions.length === 1) {
        // A selected connector is rendered in the user bubble, although it was
        // attached separately from the submitted prompt. Remove only that explicit
        // leading app mention and its one separator, preserving prompt whitespace.
        const mention = mentions[0]!.innerText;
        if (!mention || !text.startsWith(mention)) return "mismatch";
        text = text.slice(mention.length).replace(/^[ \t\n\u00a0]/, "");
      }
      const normalize = (value: string) => value.replace(/\r\n?/g, "\n");
      const observed = normalize(text);
      const expected = normalize(submitted);
      // The rich user renderer inserts escapes in bare paragraph text and
      // innerText adds layout newlines around the connector. Read this known
      // DOM representation structurally, without trimming/collapsing task text.
      const rich = content.querySelector<HTMLElement>('.rich-text-user-turn[data-markdown-text-tone="user-message"]');
      if (rich) {
        if (mentions.length === 1 && padding === undefined) return "mismatch";
        const read = (node: Node): string | undefined => {
          if (node.nodeType === Node.TEXT_NODE) {
            const value = node.textContent ?? "";
            // Captured renderer fallback: escaped quotes, backticks, '<' and '*'
            // remain in bare P text. Span text already contains original text.
            return node.parentElement?.tagName === "P"
              ? value.replace(/\\(["`<*])/g, "$1") : value;
          }
          if (!(node instanceof HTMLElement)) return undefined;
          if (node.matches('[data-prompt-link-href^="app://"], [app-mention-path^="app://"]')) return "";
          if (node.tagName === "BR") return "\n";
          if (!["P", "SPAN", "A"].includes(node.tagName)) return undefined;
          const parts = [...node.childNodes].map(read);
          return parts.some(part => part === undefined) ? undefined : parts.join("");
        };
        const paragraphs = [...rich.childNodes].map(read);
        if (!paragraphs.some(part => part === undefined)) {
          const source = normalize(paragraphs.join("\n"));
          const prefix = mentions.length === 1 ? padding! : "";
          const sent = prefix + expected;
          if (source === sent) return "match";
          return source.length < sent.length && sent.startsWith(source) ? "pending" : "mismatch";
        }
        return "mismatch";
      }
      if (observed === expected) return "match";
      return observed.length < expected.length && expected.startsWith(observed)
        ? "pending" : "mismatch";
    }, { key: identity.slice("group:user:".length), submitted: submittedText, padding: connectorPadding }), signal));
  }

  private async rememberSubmittedUserIdentity(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    state: ChatGptSubmissionDomState,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const identity = chatGptNewTurnIdentity(baseline.initialTurnIdentities, state.userIdentities);
    const pendingExpired = () => baseline.pendingUserRekeySince !== undefined
      && Date.now() - baseline.pendingUserRekeySince >= CHATGPT_RESPONSE_DOM_GRACE_MS;
    if (!identity) {
      if (pendingExpired()) throw new Error("ChatGPT could not verify the rekeyed user turn after submission");
      return baseline.pendingUserRekeySince === undefined;
    }
    if (baseline.pendingUserRekeySince !== undefined && identity === baseline.acceptedUserIdentity) {
      const initial = new Set(baseline.initialTurnIdentities);
      const assistantIdentity = `group:assistant:${identity.slice("group:user:".length)}`;
      if (state.turnIdentities.every(turn => initial.has(turn)
        || turn === identity || turn === assistantIdentity)) {
        baseline.pendingUserRekeySince = undefined;
      }
    }
    if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== identity) {
      const oldIdentity = baseline.acceptedUserIdentity;
      const assistantIdentity = `group:assistant:${identity.slice("group:user:".length)}`;
      const initial = new Set(baseline.initialTurnIdentities);
      const soleReplacement = oldIdentity.startsWith("group:user:")
        && identity.startsWith("group:user:")
        && !state.turnIdentities.includes(oldIdentity)
        && state.turnIdentities.every(turn => initial.has(turn)
          || turn === identity || turn === assistantIdentity);
      if (!soleReplacement || !baseline.submittedText) {
        throw new Error("ChatGPT changed the user turn that acknowledged the submission");
      }
      const match = await this.submittedUserTextMatches(page, identity, baseline.submittedText, signal, baseline.submittedConnectorPadding);
      if (match === "pending") {
        baseline.pendingUserRekeySince ??= Date.now();
        if (pendingExpired()) throw new Error("ChatGPT could not verify the rekeyed user turn after submission");
        return false;
      }
      if (match !== "match") {
        throw new Error("ChatGPT changed the user turn that acknowledged the submission");
      }
      baseline.pendingUserRekeySince = undefined;
    }
    if (baseline.pendingUserRekeySince !== undefined) {
      if (pendingExpired()) throw new Error("ChatGPT could not verify the rekeyed user turn after submission");
      return false;
    }
    baseline.acceptedUserIdentity = identity;
    baseline.pendingUserRekeySince = undefined;
    return true;
  }

  private async currentSubmissionAnswerText(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    signal?: AbortSignal,
  ): Promise<string> {
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const identity = chatGptNewTurnIdentity(
      baseline.initialTurnIdentities,
      state.responseIdentities,
    );
    if (!identity) return "";
    const locator = page.locator(chatGptAssistantTurnSelector(identity));
    return (await this.responseDomSnapshot(locator, {}, identity)).visibleText;
  }

  private async captureSubmissionBaseline(page: Page, submittedText?: string): Promise<ChatGptSubmissionBaseline> {
    const userTurns = page.locator(CHATGPT_USER_TURN_SELECTOR);
    const responseTurns = page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR);
    const domCache: ChatGptSubmissionDomCache = {};
    const state = await this.submissionDomState(page, domCache);
    return {
      userTurns,
      responseTurns,
      initialTurnIdentities: state.turnIdentities,
      domCache,
      submittedText,
    };
  }

  private async waitForNewAssistantTurn(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    deadline: number | undefined,
    signal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    graceMs: number = CHATGPT_RESPONSE_DOM_GRACE_MS,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<ChatGptAssistantTurnBinding> {
    let observationPage = page;
    let observationBaseline = baseline;
    let recoveryAttempts = 0;
    let responseDeadline = Math.min(
      deadline ?? Number.POSITIVE_INFINITY,
      Date.now() + graceMs,
    );
    for (;;) {
      if (signal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      if (observationPage.isClosed()) throw chatGptBrowserTabClosedError();
      if(this.config?.browserHost==="launcher"&&this.config.autoApproveToolCalls===true){
        if(await resolveChatGptToolConfirmation(observationPage,this.config.appName,true,signal,CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,undefined,true)){
          responseDeadline=Math.min(deadline??Number.POSITIVE_INFINITY,Date.now()+graceMs);
        }
      }
      let progress = externalProgress?.snapshot();
      if (progress?.lastProgressAt !== undefined) {
        responseDeadline = Math.min(
          deadline ?? Number.POSITIVE_INFINITY,
          Math.max(responseDeadline, progress.lastProgressAt + graceMs),
        );
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT web turn timed out");
      }
      if (this.config?.browserHost !== "launcher") {
        await throwIfChatGptSessionFailureAlert(observationPage);
        await throwIfChatGptRateLimitDialog(observationPage);
      }
      let state: ChatGptSubmissionDomState;
      try {
        state = await this.submissionDomState(
          observationPage,
          observationBaseline.domCache,
          signal,
        );
      } catch (error) {
        const latestProgress = externalProgress?.snapshot();
        if (error instanceof ChatGptBrowserObservationTimeoutError && recoverObservation) {
          recoveryAttempts += 1;
          if (recoveryAttempts > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
            throw new Error(
              `ChatGPT accepted the message, but its DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
              { cause: error },
            );
          }
          const recovered = await recoverObservation(
            recoveryAttempts,
            error,
            observationBaseline,
            signal,
          );
          observationPage = recovered.page;
          observationBaseline = recovered.baseline;
          continue;
        }
        if (!chatGptExternalProgressIsLive(latestProgress, Date.now(), graceMs)) throw error;
        await this.waitForTurnDomOrExternalProgress(
          observationPage,
          latestProgress?.revision ?? 0,
          externalProgress,
          signal,
        );
        continue;
      }
      recoveryAttempts = 0;
      // Stop or MCP activity can acknowledge Send before the user bubble exists.
      // An optimistic user group may also acquire a persisted key. Until the
      // replacement exposes the exact submitted content, keep observing instead
      // of binding an assistant response to an unverified group.
      const userIdentityVerified = await this.rememberSubmittedUserIdentity(
        observationPage, observationBaseline, state, signal,
      );
      // A tool batch can arrive while the DOM probe is in flight. Read progress again before
      // acknowledging its boundary; the pre-probe snapshot can otherwise leave the broker waiting
      // despite this exact iteration having successfully observed the page.
      progress = externalProgress?.snapshot();
      const identity = chatGptNewTurnIdentity(
        observationBaseline.initialTurnIdentities,
        state.responseIdentities,
      );
      if (progress
        && externalProgress
        && completionTracker?.needsToolBatchObservation(progress.lastToolBatchRevision)) {
        const boundaryText = identity
          ? (await this.responseDomSnapshot(
            observationPage.locator(chatGptAssistantTurnSelector(identity)),
            {},
            identity,
          )).visibleText
          : "";
        completionTracker.observeToolBatch(progress.lastToolBatchRevision, boundaryText);
        await externalProgress.acknowledgeToolBatch(progress.lastToolBatchRevision);
      }
      if (identity && userIdentityVerified) return {
        identity,
        locator: observationPage.locator(chatGptAssistantTurnSelector(identity)),
        acceptedTurnIdentities: state.turnIdentities,
      };
      // The power UI can expose Stop for a long reasoning phase before mounting any assistant
      // node. Fresh generation evidence extends only DOM grace, never the caller's deadline.
      if (state.visibleStopButtonCount > 0) {
        responseDeadline = Math.min(deadline ?? Number.POSITIVE_INFINITY, Date.now() + graceMs);
      }
      // A delayed renderer wake can cross the grace while the assistant appears. Only a fresh
      // observation can prove it is still missing; the explicit turn deadline remains above.
      if (Date.now() >= responseDeadline
        && !chatGptExternalProgressSuppressesDomHealth(progress, Date.now())) {
        throw new Error("ChatGPT accepted the message but did not expose its assistant turn in the DOM");
      }
      await this.waitForTurnDomOrExternalProgress(
        observationPage,
        progress?.revision ?? 0,
        externalProgress,
        signal,
      );
    }
  }

  private async reconcileAssistantTurnBinding(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    binding: ChatGptAssistantTurnBinding,
    signal?: AbortSignal,
  ): Promise<ChatGptAssistantTurnBinding> {
    if (baseline.pendingUserRekeySince !== undefined) {
      const state = await this.submissionDomState(page, baseline.domCache, signal);
      if (!await this.rememberSubmittedUserIdentity(page, baseline, state, signal)) return binding;
    }
    const boundCount = await withChatGptBrowserObservationTimeout(
      withBrowserTurnAbort(binding.locator.count(), signal),
    );
    if (boundCount === 1) return binding;
    if (boundCount > 1) {
      throw new Error(`ChatGPT exposed ${boundCount} DOM nodes for the bound assistant turn`);
    }
    const state = await this.submissionDomState(page, baseline.domCache, signal);
    const acceptedTurns = new Set(binding.acceptedTurnIdentities);
    const identity = chatGptReboundTurnIdentity(
      baseline.initialTurnIdentities,
      binding.identity,
      state.responseIdentities,
    );
    const newUsers = state.userIdentities.filter(identity => !acceptedTurns.has(identity));
    if (newUsers.length > 0) {
      // Activity can unmount the accepted user group while it renders a temporary
      // assistant group. Its return must match the ID that acknowledged Send. If no
      // user ID was observed then, require the entire submitted text instead. A
      // surviving old group or any competing new turn remains foreign.
      const user = newUsers[0]!;
      const replacement = identity && newUsers.length === 1
        && binding.identity.startsWith("group:assistant:")
        && user.startsWith("group:user:")
        && identity === `group:assistant:${user.slice("group:user:".length)}`
        && !state.turnIdentities.includes(binding.identity)
        && state.turnIdentities.every(turn => acceptedTurns.has(turn) || turn === user || turn === identity);
      let matches = false;
      if (replacement) {
        const locator = page.locator(chatGptAssistantTurnSelector(identity!));
        if (baseline.acceptedUserIdentity && baseline.acceptedUserIdentity !== user) {
          if (!await this.rememberSubmittedUserIdentity(page, baseline, state, signal)) return binding;
        }
        if (baseline.acceptedUserIdentity) {
          matches = user === baseline.acceptedUserIdentity;
        } else if (baseline.submittedText) {
          const match = await this.submittedUserTextMatches(page, user, baseline.submittedText, signal, baseline.submittedConnectorPadding);
          if (match === "pending") return binding;
          matches = match === "match";
        }
        if (matches) {
          const response = await this.responseDomSnapshot(locator, {}, identity!);
          matches = response.responsePresent && response.completionActionVisible;
        }
      }
      if (!matches) throw new Error("ChatGPT opened another user turn while the bound assistant response was detached");
    }
    if (!identity || identity === binding.identity) return binding;
    return {
      identity,
      locator: page.locator(chatGptAssistantTurnSelector(identity)),
      acceptedTurnIdentities: state.turnIdentities,
    };
  }

  private async attachedPromptText(page: Page, abortSignal?: AbortSignal): Promise<string> {
    if (this.config?.browserHost === "launcher") return await launcherComposerOperation(page, { kind: "text" }, abortSignal) as string;
    const composer = await this.activeComposer(page, 30_000, abortSignal);
    return composer.evaluate(element => {
      const clone = element.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(
        '[data-id^="plugin:"][data-keyword], [data-inline-selection-pill-cursor-target], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]',
      )
        .forEach(part => part.remove());
      return [...clone.childNodes]
        .map(child => child.textContent ?? "")
        .join("\n")
        .trimStart();
    }, undefined, { timeout: 20_000, signal: abortSignal });
  }

  private async assertPromptAttached(
    page: Page,
    prompt: string,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    let observed = "";
    while (Date.now() < deadline) {
      throwIfPromptAttachmentAborted(abortSignal);
      observed = await this.attachedPromptText(page, abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
      if (this.promptTextEquivalent(prompt, observed)) return;
      await withBrowserTurnAbort(
        new Promise(resolveSleep => setTimeout(resolveSleep, 50)),
        abortSignal,
      );
    }
    throwIfPromptAttachmentAborted(abortSignal);
    const commonPrefix = this.promptEquivalentPrefixLength(prompt, observed);
    throw new ChatGptPromptAttachmentIntegrityError(
      `ChatGPT composer did not preserve the complete prompt (expectedChars=${prompt.length}, actualChars=${observed.length}, commonPrefixChars=${commonPrefix})`,
    );
  }

  private selectedConnectorControl(composer: Locator): Locator {
    return composer
      .locator([
        `[data-id^="plugin:"][data-keyword=${JSON.stringify(this.config.appName)}]`,
        `[app-mention-path^="app://"][app-mention-display-name=${JSON.stringify(this.config.appName)}][contenteditable="false"]`,
      ].join(", "))
      .filter({ visible: true });
  }

  private async connectorIsSelected(composer: Locator, abortSignal?: AbortSignal): Promise<boolean> {
    const keywords = this.config?.browserHost === "launcher"
      ? await launcherComposerOperation(composer.page(), { kind: "connectors" }, abortSignal) as string[]
      : await withBrowserTurnAbort(
      withChatGptBrowserObservationTimeout(this.selectedConnectorControl(composer).evaluateAll(elements => (
        elements.map(element => element.getAttribute("data-keyword") ?? element.getAttribute("app-mention-display-name"))
      ))),
      abortSignal,
    );
    const exactMatches = keywords.filter(keyword => keyword === this.config.appName).length;
    if (exactMatches > 1) {
      throw new Error(`ChatGPT composer exposed duplicate ${JSON.stringify(this.config.appName)} connector selections`);
    }
    return exactMatches === 1;
  }

  private async connectorMentionRowTitles(
    menuRows: Locator,
    abortSignal?: AbortSignal,
  ): Promise<string[]> {
    let texts: string[];
    try {
      texts = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).allInnerTexts()),
        abortSignal,
      );
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      texts = [];
    }
    return texts
      .map(text => (text.split("\n")[0] ?? "").replace(/\s+/g, " ").trim())
      .filter(title => title.length > 0);
  }

  private async connectorMentionFailure(
    menuRows: Locator | string[],
    triggerAttempts: number,
    abortSignal?: AbortSignal,
  ): Promise<string> {
    const titles = Array.isArray(menuRows) ? menuRows : await this.connectorMentionRowTitles(menuRows, abortSignal);
    if (titles.length === 0) {
      return `ChatGPT connector menu did not open after ${triggerAttempts} complete mention trigger attempt(s)`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && titles.includes(DEV_CHATGPT_CONNECTOR_NAME)) {
      return `ChatGPT exposes the isolated DEV connector ${JSON.stringify(DEV_CHATGPT_CONNECTOR_NAME)},`
        + ` but production requires a separate connector named ${JSON.stringify(CHATGPT_CONNECTOR_NAME)};`
        + ` create ${JSON.stringify(CHATGPT_CONNECTOR_NAME)} against the production tunnel and leave the DEV connector unchanged`;
    }
    if (this.config.appName === CHATGPT_CONNECTOR_NAME && !titles.includes(CHATGPT_CONNECTOR_NAME)) {
      const legacyName = LEGACY_CHATGPT_CONNECTOR_NAMES.find(name => titles.includes(name));
      if (legacyName) return legacyChatGptConnectorMigrationMessage(legacyName);
    }
    return `ChatGPT connector menu opened but exposed no row named ${JSON.stringify(this.config.appName)}`
      + ` after ${triggerAttempts} complete mention trigger attempt(s)`
      + `; create a connector with that exact name before retrying`;
  }

  private async focusComposer(composer: Locator, options: { signal?: AbortSignal; timeout: number }): Promise<void> {
    if (this.config.browserHost !== "launcher") {
      await composer.focus(options);
      return;
    }
    throwIfPromptAttachmentAborted(options.signal);
    await launcherComposerOperation(composer.page(), { kind: "focus" }, options.signal);
    throwIfPromptAttachmentAborted(options.signal);
  }

  private async clearChatGptComposerState(page: Page): Promise<void> {
    await runChatGptPersonalizationCleanup(async (deadline, signal) => {
      if (this.config.browserHost === "launcher") {
        await launcherComposerOperation(page, { kind: "clear" }, signal);
        await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);
        const text = await launcherComposerOperation(page, { kind: "text" }, signal) as string;
        const connectors = await launcherComposerOperation(page, { kind: "connectors" }, signal) as string[];
        if (text.trim() || connectors.length) throw new Error("ChatGPT connector cleanup did not produce an empty composer");
        return;
      }
      await pressChatGptPersonalizationEscape(page, deadline, signal);
      const timeoutMs = Math.max(1, deadline - Date.now());
      const composer = await this.activeComposer(page, timeoutMs, signal);
      await this.focusComposer(composer, {
        signal,
        timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
      });
      await composer.press(CHATGPT_COMPOSER_SELECT_ALL_KEY, {
        signal,
        timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
      });
      await composer.press("Backspace", {
        signal,
        timeout: Math.max(1, Math.min(CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, deadline - Date.now())),
      });
      await waitForChatGptPersonalizationPoll(CHATGPT_UI_SETTLE_MS, signal);
      const settledComposer = await this.activeComposer(page, Math.max(1, deadline - Date.now()), signal);
      const remainingMs = Math.max(1, deadline - Date.now());
      const remainingText = await settledComposer.evaluate(
        element => element.textContent?.trim() ?? "",
        undefined,
        { timeout: remainingMs, signal },
      );
      const connectorSelected = await this.connectorIsSelected(settledComposer, signal);
      if (remainingText.length > 0 || connectorSelected) {
        throw new Error(
          `ChatGPT connector cleanup did not produce an empty composer`
          + ` (visibleCharacters=${remainingText.length}, connectorSelected=${connectorSelected})`,
        );
      }
    });
  }

  private async waitForOwnedLauncherConnectorMenu(page: Page, signal?: AbortSignal): Promise<LauncherConnectorState> {
    const deadline = Date.now() + 20_000;
    let state: LauncherConnectorState;
    do {
      state = await launcherComposerOperation(page, { kind: "connector-state", appName: this.config.appName }, signal) as LauncherConnectorState;
      throwLauncherSendFailure(state.failure);
      if (state.exactRows === 1) return state;
      if (state.text.trim() !== "@" + this.config.appName || state.selected.length) throw new ChatGptPromptAttachmentIntegrityError("ChatGPT did not preserve the owned connector mention");
      if (Date.now() >= deadline) break;
      await waitForChatGptPersonalizationPoll(50, signal);
    } while (true);
    return state;
  }

  private async selectOwnedLauncherConnector(
    page: Page, capture: (checkpoint: string) => Promise<void>, catalogRefreshAvailable: boolean,
    attemptBudget: ChatGptConnectorAttemptBudget, signal?: AbortSignal,
  ): Promise<Locator> {
    const read = async () => {
      const state = await launcherComposerOperation(page, { kind: "connector-state", appName: this.config.appName }, signal) as LauncherConnectorState;
      throwLauncherSendFailure(state.failure);
      return state;
    };
    const trigger = async (triggerSignal?: AbortSignal) => {
      await launcherComposerOperation(page, { kind: "clear" }, triggerSignal);
      await this.insertPromptText(page, "@" + this.config.appName, triggerSignal);
      return this.waitForOwnedLauncherConnectorMenu(page, triggerSignal);
    };
    if (new URL(page.url()).searchParams.get("temporary-chat") === "true") {
      await ensureChatGptPersonalizedConnectorAccess(page, capture, async personalizationSignal => {
        let error: unknown, result = false;
        try {
          const state = await trigger(personalizationSignal);result = state.exactRows === 1;
          await capture(result ? "personalization-proof-menu-visible" : "personalization-proof-menu-missing");
        } catch (caught) { error = caught; }
        try { await this.clearChatGptComposerState(page); }
        catch (cleanupError) { throw new ChatGptPersistentBrowserStateError(error !== undefined ? [error, cleanupError] : [cleanupError], "ChatGPT connector proof did not leave a verified empty composer"); }
        if (error !== undefined) throw error;
        return result;
      }, signal);
    }
    try {
      const initial = await read();
      if (initial.selected.length === 1 && initial.selected[0] === this.config.appName && !initial.text.trim()) {
        await capture("connector-already-selected");
        return page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
      }
      if (initial.text.trim() || initial.selected.length) await capture("restored-draft-before-attachment");
      let menu: LauncherConnectorState | undefined;
      while (attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
        attemptBudget.triggerAttempts += 1;
        await launcherComposerOperation(page, { kind: "clear" }, signal);
        await this.insertPromptText(page, "@" + this.config.appName, signal);
        if (attemptBudget.triggerAttempts === 1) await capture("connector-mention-triggered");
        menu = await this.waitForOwnedLauncherConnectorMenu(page, signal);
        if (menu.exactRows === 1) break;
        const knownMismatch = this.config.appName === CHATGPT_CONNECTOR_NAME
          && (menu.titles.includes(DEV_CHATGPT_CONNECTOR_NAME) || LEGACY_CHATGPT_CONNECTOR_NAMES.some(name => menu!.titles.includes(name)));
        if (knownMismatch || attemptBudget.triggerAttempts >= MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
          await capture("connector-menu-missing");
          throw chatGptConnectorUnavailableError(await this.connectorMentionFailure(menu.titles, attemptBudget.triggerAttempts, signal));
        }
        if (catalogRefreshAvailable && menu.titles.length && !menu.titles.includes(this.config.appName)) throw new ChatGptConnectorCatalogStaleError(this.config.appName, attemptBudget.triggerAttempts);
      }
      if (!menu || menu.exactRows !== 1) throw chatGptConnectorUnavailableError("ChatGPT connector trigger budget was exhausted");
      await capture("connector-menu-visible");
      const selected = await launcherComposerOperation(page, { kind: "connector-select", appName: this.config.appName }, signal) as LauncherConnectorState;
      throwLauncherSendFailure(selected.failure);
      if (!selected.activated) throw new Error("ChatGPT owned connector row was not activated");
      await capture("connector-choice-activated");
      const deadline = Date.now() + CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS;
      do {
        const state = await read();
        if (state.selected.length === 1 && state.selected[0] === this.config.appName) {
          await capture("connector-selected");
          return page.locator(CHATGPT_COMPOSER_SELECTOR).filter({ visible: true }).first();
        }
        if (state.selected.length) throw new Error("ChatGPT composer selected a different connector");
        if (Date.now() >= deadline) break;
        await waitForChatGptPersonalizationPoll(50, signal);
      } while (true);
      throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
    } catch (error) {
      try { await this.clearChatGptComposerState(page); }
      catch (cleanupError) { throw new ChatGptPersistentBrowserStateError([error, cleanupError], "ChatGPT connector selection failed and its composer state could not be cleared"); }
      throw error;
    }
  }

  private async selectConnector(
    page: Page,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    catalogRefreshAvailable = false,
    attemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 },
    abortSignal?: AbortSignal,
  ): Promise<Locator> {
    const capture = async (checkpoint: string): Promise<void> => {
      throwIfPromptAttachmentAborted(abortSignal);
      await withBrowserTurnAbort(captureDiagnostic?.(checkpoint) ?? Promise.resolve(), abortSignal);
      throwIfPromptAttachmentAborted(abortSignal);
    };
    if (this.config.browserHost === "launcher") return this.selectOwnedLauncherConnector(page, capture, catalogRefreshAvailable, attemptBudget, abortSignal);
    let composer: Locator;
    const mentionQuery = "@" + this.config.appName; // CLW: search the configured connector identity.
    const menuRows = page.locator('.__menu-item[tabindex="0"], [data-mention-list-scroll-area] button[data-list-navigation-item="true"]');
    const appResult = menuRows.filter({
      has: page.getByText(this.config.appName, { exact: true }),
    });
    if (new URL(page.url()).searchParams.get("temporary-chat") === "true") await ensureChatGptPersonalizedConnectorAccess(
      page,
      capture,
      async (personalizationSignal) => {
        let proofResult: boolean | undefined;
        let proofError: unknown;
        try {
          composer = await this.activeComposer(page, 30_000, personalizationSignal);
          await composer.fill("", {
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await this.focusComposer(composer, {
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await withBrowserTurnAbort(settleChatGptUi(), personalizationSignal);
          await composer.pressSequentially(mentionQuery, {
            delay: 25,
            signal: personalizationSignal,
            timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
          });
          await capture("personalization-proof-mention-triggered");
          try {
            await appResult.waitFor({ state: "visible", timeout: 20_000, signal: personalizationSignal });
            proofResult = true;
            await capture("personalization-proof-menu-visible");
          } catch (error) {
            if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
            proofResult = false;
            await capture("personalization-proof-menu-missing");
            const mention = await composer.evaluate(element => ({
              text: element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement
                ? element.value : element.textContent ?? "",
              focused: element === document.activeElement,
            }), undefined, { timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS, signal: personalizationSignal });
            if (mention.text !== mentionQuery) {
              throw new ChatGptPromptAttachmentIntegrityError(
                `ChatGPT did not preserve the connector mention (expectedChars=${mentionQuery.length}, actualChars=${mention.text.length}, focused=${mention.focused})`,
              );
            }
          }
        } catch (error) {
          proofError = error;
        }
        try {
          await this.clearChatGptComposerState(page);
        } catch (cleanupError) {
          throw new ChatGptPersistentBrowserStateError(
            proofError !== undefined ? [proofError, cleanupError] : [cleanupError],
            "ChatGPT connector proof did not leave a verified empty composer",
          );
        }
        if (proofError !== undefined) throw proofError;
        return proofResult === true;
      },
      abortSignal,
    );
    try {
      composer = await this.activeComposer(page, 30_000, abortSignal);
      if (await this.connectorIsSelected(composer, abortSignal)) {
        // A fresh saved-chat page can hydrate another tab's persisted draft,
        // including its connector pill. Reusing that pill must not append this
        // turn's transport to the other task. Clear only our owned, unsent editor.
        if (!(await this.attachedPromptText(page, abortSignal)).trim()) {
          await capture("connector-already-selected");
          return composer;
        }
        await capture("restored-draft-before-attachment");
        await this.clearChatGptComposerState(page);
        composer = await this.activeComposer(page, 30_000, abortSignal);
      }
      await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });

      let firstMenuCaptured = false;
      while (attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
        attemptBudget.triggerAttempts += 1;
        composer = await this.activeComposer(page, 30_000, abortSignal);
        await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await this.focusComposer(composer, { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
        await composer.pressSequentially(mentionQuery, {
          delay: 25,
          signal: abortSignal,
          timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        });
        if (!firstMenuCaptured) {
          firstMenuCaptured = true;
          await capture("connector-mention-triggered");
        }
        try {
          await appResult.waitFor({
            state: "visible",
            timeout: 20_000,
            signal: abortSignal,
          });
          await capture("connector-menu-visible");
          break;
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "TimeoutError") throw error;
          const visibleRows = await this.connectorMentionRowTitles(menuRows, abortSignal);
          const knownIdentityMismatch = this.config.appName === CHATGPT_CONNECTOR_NAME
            && (
              visibleRows.includes(DEV_CHATGPT_CONNECTOR_NAME)
              || LEGACY_CHATGPT_CONNECTOR_NAMES.some(name => visibleRows.includes(name))
            );
          if (knownIdentityMismatch) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal),
            );
          }
          if (
            catalogRefreshAvailable
            && visibleRows.length > 0
            && !visibleRows.includes(this.config.appName)
            && attemptBudget.triggerAttempts < MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS
          ) {
            throw new ChatGptConnectorCatalogStaleError(
              this.config.appName,
              attemptBudget.triggerAttempts,
            );
          }
          if (attemptBudget.triggerAttempts >= MAX_CHATGPT_CONNECTOR_TRIGGER_ATTEMPTS) {
            await capture("connector-menu-missing");
            throw chatGptConnectorUnavailableError(
              await this.connectorMentionFailure(menuRows, attemptBudget.triggerAttempts, abortSignal),
            );
          }
        }
      }
      const exactResultCount = await withBrowserTurnAbort(
        withChatGptBrowserObservationTimeout(appResult.count()),
        abortSignal,
      );
      if (exactResultCount !== 1) {
        throw chatGptConnectorUnavailableError(
          `ChatGPT connector menu did not expose one exact ${JSON.stringify(this.config.appName)} row`
          + ` after ${attemptBudget.triggerAttempts} complete mention trigger attempt(s)`,
        );
      }
      // Managed Chrome keeps the upstream keyboard highlight contract.
        const rowHighlighted = async () => {
          const options = { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS };
          return await appResult.getAttribute("data-highlighted", options) !== null
            || await appResult.getAttribute("aria-current", options) === "true";
        };
        if (!await rowHighlighted()) {
          const visibleRowCount = await withBrowserTurnAbort(
            withChatGptBrowserObservationTimeout(menuRows.filter({ visible: true }).count()),
            abortSignal,
          );
          for (let step = 0; step < visibleRowCount && !await rowHighlighted(); step += 1) {
            await composer.press("ArrowDown", {
              signal: abortSignal,
              timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
            });
          }
        }
        if (!await rowHighlighted()) {
          throw new Error(`ChatGPT connector menu could not highlight ${JSON.stringify(this.config.appName)}`);
        }
        await composer.press("Enter", {
          signal: abortSignal,
          timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        });
      await capture("connector-choice-activated");
      // Selecting a connector replaces the Lexical composer subtree. Resolve the active composer
      // again instead of returning the pre-selection locator, otherwise the real turn can focus a
      // detached/hidden editor even though verification just succeeded.
      const selectedComposer = await this.activeComposer(page, 30_000, abortSignal);
      const selectedConnector = this.selectedConnectorControl(selectedComposer);
      await selectedConnector.waitFor({
        state: "visible",
        timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        signal: abortSignal,
      });
      if (!await this.connectorIsSelected(selectedComposer, abortSignal)) {
        throw new Error(`ChatGPT composer did not select ${JSON.stringify(this.config.appName)} connector`);
      }
      await capture("connector-selected");
      return selectedComposer;
    } catch (error) {
      try {
        await this.clearChatGptComposerState(page);
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT connector selection failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  private async attachPrompt(
    page: Page,
    prompt: string,
    localTools: boolean,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget?: ChatGptConnectorAttemptBudget,
    reuseConnector = false,
    requireThink = false,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    if (this.config.browserHost === "launcher") {
      const state = await launcherComposerOperation(page, { kind: "ui-state" }, abortSignal) as { failure?: LauncherSendFailure };
      throwLauncherSendFailure(state.failure);
      // The SPA can replace its editor after model selection. Reacquire readiness
      // before connector reads or edits, while rollback still owns no mutation.
      await this.activeComposer(page, 30_000, abortSignal);
    } else await throwIfChatGptRateLimitDialog(page);
    throwIfPromptAttachmentAborted(abortSignal);
    const connectorMode = chatGptConnectorAttachmentMode(localTools, reuseConnector);
    let composerMutationStarted = false;
    try {
      if (connectorMode !== "mention") {
        // Playwright's multiline fill maps through an input action that ChatGPT's Lexical editor can
        // collapse to the first paragraph on the launcher-owned Electron surface. Clear separately,
        // then transport the complete text through the browser's plain-text editing command.
        composerMutationStarted = true;
        if (this.config.browserHost === "launcher") {
          await launcherComposerOperation(page, { kind: "clear" }, abortSignal);
          if (requireThink) {
            const composer = await this.activeComposer(page, 30_000, abortSignal);
            await setChatGptThinkMode(composer.locator("xpath=ancestor::form[1]"), true, captureDiagnostic, abortSignal);
          }
        } else {
          const composer = await this.activeComposer(page, 30_000, abortSignal);
          await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
          await this.focusComposer(composer, { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
          if (requireThink) await setChatGptThinkMode(composer.locator("xpath=ancestor::form[1]"), true, captureDiagnostic, abortSignal);
        }
        await this.insertPromptText(page, prompt, abortSignal);
        await this.assertPromptAttached(page, prompt, abortSignal);
        return;
      }
      const selectedComposer = await this.selectConnector(
        page,
        captureDiagnostic,
        catalogRefreshAvailable,
        connectorAttemptBudget,
        abortSignal,
      );
      // selectConnector owns and rolls back every mutation until it returns. From this point the
      // attachment owns the selected pill and prompt text as one transaction.
      composerMutationStarted = true;
      if (requireThink) {
        await setChatGptThinkMode(selectedComposer.locator("xpath=ancestor::form[1]"), true, captureDiagnostic, abortSignal);
      }
      if (this.config.browserHost === "launcher") {
        await launcherComposerOperation(page, { kind: "end" }, abortSignal);
      } else {
        await this.focusComposer(selectedComposer, { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
        await selectedComposer.press(CHATGPT_COMPOSER_DOCUMENT_END_KEY, {
          signal: abortSignal,
          timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS,
        });
      }
      await this.insertPromptText(page, ` ${prompt}`, abortSignal);
      await this.assertPromptAttached(page, prompt, abortSignal);
    } catch (error) {
      if (!composerMutationStarted || error instanceof ChatGptPersistentBrowserStateError) throw error;
      try {
        await this.clearChatGptComposerState(page);
      } catch (cleanupError) {
        throw new ChatGptPersistentBrowserStateError(
          [error, cleanupError],
          "ChatGPT prompt attachment failed and its composer state could not be cleared",
        );
      }
      throw error;
    }
  }

  private async waitForSubmissionAcceptedWithRecovery(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
  ): Promise<ChatGptSubmissionEvidence> {
    let observationPage = page;
    let observationBaseline = baseline;
    let recoveryAttempts = 0;
    for (;;) {
      try {
        const evidence = await this.waitForSubmissionAccepted(
          observationPage,
          observationBaseline,
          abortSignal,
          externalProgress,
          initialToolBatchRevision,
          completionTracker,
        );
        return evidence;
      } catch (error) {
        if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !recoverObservation) throw error;
        recoveryAttempts += 1;
        if (recoveryAttempts > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
          throw new Error(
            `ChatGPT submission DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
            { cause: error },
          );
        }
        const recovered = await recoverObservation(
          recoveryAttempts,
          error,
          observationBaseline,
          abortSignal,
        );
        observationPage = recovered.page;
        observationBaseline = recovered.baseline;
      }
    }
  }

  private async sendAttachedPrompt(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    submissionLifecycle?: Pick<BrowserTurn, "onSendActivated" | "onSubmitted">,
    completionTracker?: ChatGptCompletionTracker,
    recoverObservation?: ChatGptObservationRecovery,
    stageBudget?: { traceId: string; activationTimeoutMs: number; confirmationTimeoutMs: number },
  ): Promise<ChatGptSubmissionEvidence> {
    const activate = async (activationSignal?: AbortSignal): Promise<number> => {
      const abortSignal = activationSignal;
      if (abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      const launcher = this.config?.browserHost === "launcher";
      const composer = launcher ? undefined : await this.activeComposer(page);
      const sendButton = composer?.locator("xpath=ancestor::form[1]").locator(CHATGPT_SEND_BUTTON_SELECTOR);
      if (sendButton) await sendButton.waitFor({ state: "visible", timeout: browserStageTimeouts.send });
      await settleChatGptUi();
      const sendEnableDeadline = Date.now() + CHATGPT_SEND_ENABLE_GRACE_MS;
      let launcherState: LauncherSendState | undefined;
      for (;;) {
        if (abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
        if (page.isClosed()) throw chatGptBrowserTabClosedError();
        if (launcher) {
          launcherState = await launcherComposerOperation(page, { kind: "send-state", sendSelector: CHATGPT_SEND_BUTTON_SELECTOR }, abortSignal) as LauncherSendState;
          throwLauncherSendFailure(launcherState.failure);
          if (launcherState.visibleCount > 1) throw new Error("ChatGPT owned Send button is not unique");
          if (launcherState.enabled) break;
        } else {
          await throwIfChatGptSessionFailureAlert(page);
          await throwIfChatGptRateLimitDialog(page);
          if (await sendButton!.isEnabled()) break;
        }
        if (Date.now() >= sendEnableDeadline) {
          await captureDiagnostic?.("send-disabled");
          throw new Error("ChatGPT send button remained disabled after the complete prompt was attached");
        }
        await settleChatGptUi();
      }
      await captureDiagnostic?.("send-ready");
      const initialToolBatchRevision = externalProgress?.snapshot().lastToolBatchRevision ?? 0;
      if (baseline.submittedText !== undefined) {
        const raw = launcher ? launcherState?.raw : await composer!.evaluate(element => {
          const clone = element.cloneNode(true) as HTMLElement;
          const mentions = clone.querySelectorAll('[data-id^="plugin:"][data-keyword], [app-mention-path^="app://"][app-mention-display-name][contenteditable="false"]');
          if (mentions.length !== 1) return undefined;
          mentions.forEach(part => part.remove());
          clone.querySelectorAll('[data-inline-selection-pill-cursor-target]').forEach(part => part.remove());
          return [...clone.childNodes].map(child => child.textContent ?? "").join("\n");
        });
        if (raw !== undefined) {
          const paddingLength = raw.length - baseline.submittedText.length;
          const padding = raw.slice(0, Math.max(0, paddingLength));
          if (paddingLength < 0 || !/^[ \u00a0]*$/.test(padding)
            || !this.promptTextEquivalent(baseline.submittedText, raw.slice(paddingLength))) {
            throw new ChatGptPromptAttachmentIntegrityError("ChatGPT connector prompt changed before Send");
          }
          baseline.submittedConnectorPadding = padding;
        }
      }
      await submissionLifecycle?.onSendActivated?.();
      if (launcher) {
        const activation = await launcherComposerOperation(page, { kind: "send", sendSelector: CHATGPT_SEND_BUTTON_SELECTOR,
          expectedRaw: launcherState?.raw, mentionCount: launcherState?.mentionCount }, abortSignal) as LauncherSendState;
        throwLauncherSendFailure(activation.failure);
        if (!activation.activated) throw new ChatGptPromptAttachmentIntegrityError("ChatGPT connector prompt changed before Send");
      } else await sendButton!.press("Enter", {
        noWaitAfter: true,
        signal: abortSignal,
        // runStage owns the operation budget. A second Locator timeout would silently collapse the
        // 180-second Bigger Context budget back to the ordinary 20 seconds after Enter has already
        // submitted the message; semantic submission evidence below remains the authority.
        timeout: 0,
      });
      return initialToolBatchRevision;
    };
    const signalForStage = (stageSignal: AbortSignal): AbortSignal => abortSignal
      ? AbortSignal.any([stageSignal, abortSignal])
      : stageSignal;
    const initialToolBatchRevision = stageBudget
      ? await this.runStage(stageBudget.traceId, "send", stageBudget.activationTimeoutMs,
        stageSignal => activate(signalForStage(stageSignal)))
      : await activate(abortSignal);
    const confirm = async (confirmationSignal?: AbortSignal): Promise<ChatGptSubmissionEvidence> => {
      const evidence = await this.waitForSubmissionAcceptedWithRecovery(
        page,
        baseline,
        confirmationSignal,
        externalProgress,
        initialToolBatchRevision,
        completionTracker,
        recoverObservation,
      );
      if (confirmationSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      await submissionLifecycle?.onSubmitted?.();
      return evidence;
    };
    // Activation is irreversible. Once it returns, use a fresh observation budget and signal;
    // the expired Send budget must neither retire an accepted native token nor trigger a resend.
    return stageBudget
      ? this.runStage(stageBudget.traceId, "submission_confirmation", stageBudget.confirmationTimeoutMs,
        stageSignal => confirm(signalForStage(stageSignal)))
      : confirm(abortSignal);
  }

  private async waitForMultipartAcknowledgement(
    page: Page,
    initialResponseTurn: ChatGptAssistantTurnBinding,
    submissionBaseline: ChatGptSubmissionBaseline,
    stage: ChatGptWebMultipartStage,
    deadline: number | undefined,
    abortSignal?: AbortSignal,
    externalProgress?: ChatGptTurnProgressReader,
    completionTracker = new ChatGptCompletionTracker(),
  ): Promise<void> {
    // A staged message may briefly create an assistant shell and then replace it while ChatGPT
    // ingests the attached context. The ordinary 60-second missing-response verdict would cut the
    // dedicated multipart acknowledgement budget back down after that transient shell appears.
    // Keep DOM absence bounded by the same per-stage budget that owns this protocol step.
    const domHealthTracker = new ChatGptTurnDomHealthTracker(
      CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
    );
    const responseDomCache: ChatGptResponseDomCache = {};
    let responseTurn = initialResponseTurn;
    for (;;) {
      if (page.isClosed()) throw chatGptBrowserTabClosedError();
      if (abortSignal?.aborted) {
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
        throw new DOMException("ChatGPT multipart stage aborted", "AbortError");
      }
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error("ChatGPT Bigger Context transaction timed out while awaiting a stage acknowledgement");
      }
      await throwIfChatGptSessionFailureAlert(page);
      await throwIfChatGptTerminalErrorAlert(responseTurn.locator);
      let snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache, responseTurn.identity);
      if (submissionBaseline.pendingUserRekeySince !== undefined) {
        const state = await this.submissionDomState(page, submissionBaseline.domCache, abortSignal);
        if (!await this.rememberSubmittedUserIdentity(page, submissionBaseline, state, abortSignal)) {
          await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
          continue;
        }
      }
      if (!snapshot.responsePresent && await responseTurn.locator.count() !== 1) {
        const rebound = await this.reconcileAssistantTurnBinding(
          page,
          submissionBaseline,
          responseTurn,
          abortSignal,
        );
        if (rebound.identity !== responseTurn.identity) {
          responseTurn = rebound;
          responseDomCache.key = undefined;
          responseDomCache.snapshot = undefined;
          snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache, responseTurn.identity);
        }
      }
      if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
      const externalProgressSnapshot = externalProgress?.snapshot();
      if (externalProgress
        && externalProgressSnapshot
        && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
        completionTracker.observeToolBatch(
          externalProgressSnapshot.lastToolBatchRevision,
          snapshot.visibleText,
        );
        await externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
      }
      const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
        externalProgressSnapshot,
        Date.now(),
      );
      const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
      if (!snapshot.responsePresent && externalProgressLive) {
        // Proven MCP activity outranks a momentarily unavailable staging DOM, exactly as it does
        // in the main turn loop.
        domHealthTracker.clearMissingResponse();
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
        continue;
      }
      const running = await page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last().isVisible().catch(() => false);
      const domError = domHealthTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        completionActionVisible: snapshot.completionActionVisible,
        externalProgressLive,
      });
      if (domError) throw new Error(domError);
      if (completionTracker.update({
        responsePresent: snapshot.responsePresent,
        running,
        currentText: snapshot.visibleText,
        currentHtml: snapshot.fullHtml,
        completionActionVisible: snapshot.completionActionVisible,
        externalToolCallsInFlight,
      })) {
        const actual = snapshot.visibleText.trim();
        if (actual !== stage.acknowledgement) {
          throw new ChatGptWebAdapterError(
            "ChatGPT did not confirm the Bigger Context handoff. Disable Bigger Context or retry the task.",
            {
              status: 502,
              errorType: "server_error",
              code: "multipart_protocol_violation",
              retryable: false,
              cause: new Error(
                `Bigger Context acknowledgement mismatch (actualChars=${actual.length.toLocaleString("en-US")})`,
              ),
            },
          );
        }
        return;
      }
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
  }

  private async resetCompactionComposerForRetry(
    page: Page,
    baseline: ChatGptSubmissionBaseline,
    abortSignal?: AbortSignal,
  ): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    const before = await this.currentSubmissionEvidence(page, baseline, abortSignal);
    if (before) {
      throw new ChatGptPromptAttachmentIntegrityError(
        "ChatGPT changed while the compaction prompt was being prepared. Check the ChatGPT tab before retrying.",
        new Error(`Submission evidence appeared after prompt attachment failed: ${before}`),
      );
    }

    const composer = await this.activeComposer(page, 30_000, abortSignal);
    await composer.fill("", { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await composer.focus({ signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
    await withBrowserTurnAbort(settleChatGptUi(), abortSignal);
    throwIfPromptAttachmentAborted(abortSignal);

    const after = await this.currentSubmissionEvidence(page, baseline, abortSignal);
    if (after) {
      throw new ChatGptPromptAttachmentIntegrityError(
        "ChatGPT changed while the compaction prompt was being reset. Check the ChatGPT tab before retrying.",
        new Error(`Submission evidence appeared while resetting the prompt: ${after}`),
      );
    }
    const observed = await this.attachedPromptText(page, abortSignal);
    if (observed.length > 0) {
      throw new ChatGptPromptAttachmentIntegrityError(
        `ChatGPT composer could not reset cleanly for compaction retry (actualChars=${observed.length})`,
      );
    }
  }

  private async attachPromptWithCompactionRetry(
    page: Page,
    prompt: string,
    localTools: boolean,
    compaction: boolean,
    baseline: ChatGptSubmissionBaseline,
    captureDiagnostic?: (checkpoint: string) => Promise<void>,
    abortSignal?: AbortSignal,
    catalogRefreshAvailable = false,
    connectorAttemptBudget?: ChatGptConnectorAttemptBudget,
    reuseConnector = false,
    requireThink = false,
  ): Promise<void> {
    let retryAvailable = compaction;
    for (;;) {
      try {
        await this.attachPrompt(
          page,
          prompt,
          localTools,
          captureDiagnostic,
          abortSignal,
          catalogRefreshAvailable,
          connectorAttemptBudget,
          reuseConnector,
          requireThink,
        );
        return;
      } catch (error) {
        if (!retryAvailable || !(error instanceof ChatGptPromptAttachmentIntegrityError)) throw error;
        retryAvailable = false;
        const evidence = await this.currentSubmissionEvidence(page, baseline, abortSignal);
        if (evidence) {
          throw new ChatGptPromptAttachmentIntegrityError(
            "ChatGPT changed while the compaction prompt was being prepared. Check the ChatGPT tab before retrying.",
            new Error(`Prompt attachment failed before submission evidence appeared: ${evidence}`, { cause: error }),
          );
        }
        await captureDiagnostic?.("prompt-attachment-integrity-retry");
        await this.resetCompactionComposerForRetry(page, baseline, abortSignal);
      }
    }
  }

  private async insertPromptText(page: Page, text: string, abortSignal?: AbortSignal): Promise<void> {
    throwIfPromptAttachmentAborted(abortSignal);
    // CDP Input.insertText is interpreted as live typing by ChatGPT's Lexical plugins. On a large
    // JSON transport it can turn literal Markdown backticks into rich code nodes, remove the
    // delimiters from textContent, and leave the next insertion outside the intended block. The
    // browser's plain-text editing command updates the same focused contenteditable atomically
    // without running those Markdown shortcuts. Exact readback below remains the authority.
    let inserted: unknown;
    if (this.config?.browserHost === "launcher") inserted = await launcherComposerOperation(page, { kind: "insert", text }, abortSignal);
    else {
      const composer = await this.activeComposer(page, 30_000, abortSignal);
      await this.focusComposer(composer, { signal: abortSignal, timeout: CHATGPT_CONNECTOR_ACTION_TIMEOUT_MS });
      inserted = await composer.evaluate(insertPlainTextIntoComposer, text, { timeout: 20_000, signal: abortSignal });
    }
    throwIfPromptAttachmentAborted(abortSignal);
    if (!inserted) {
      throw new ChatGptPromptAttachmentIntegrityError(
        "ChatGPT composer rejected the plain-text editing command",
      );
    }
  }

  private async verifyConnectorExclusive(
    traceId = `verify_${randomUUID().replaceAll("-", "")}`,
  ): Promise<string> {
    const page = await this.ensurePage();
    const diagnostics = new ChatGptBrowserDiagnostics(
      traceId,
      this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
      this.config.appName,
    );
    const captureDiagnostic = (checkpoint: string): Promise<void> => diagnostics.capture(page, checkpoint);
    try {
      await captureDiagnostic("connector-verification-started");
      await this.prepareChatSurface(page, captureDiagnostic);
      // The launcher refreshes its owned ChatGPT document before starting this helper. A second
      // reload here can discard the first catalog's exact mismatch evidence and report a generic
      // menu failure instead of identifying the connector the account actually exposes.
      await this.selectConnector(page, captureDiagnostic);
      // Verification proves selection but does not submit a turn. Leaving the selected plugin in
      // ChatGPT's persisted composer draft makes the next hard refresh restore half-hydrated plugin
      // state; clearing it through native editor deletion keeps repeated verification transactional.
      await this.clearChatGptComposerState(page);
      await captureDiagnostic("connector-verification-cleared");
      await captureDiagnostic("connector-verification-succeeded");
      return this.config.appName;
    } catch (error) {
      await diagnostics.capture(page, "connector-verification-failed", error);
      throw error;
    }
  }

  private async inspectSessionExclusive(detectCapabilities: boolean): Promise<{
    authenticated: true;
    temporary: true;
    url: string;
    solAvailable?: boolean;
    extraHighAvailable?: boolean;
    proAvailable?: boolean;
  }> {
    const page = await this.ensurePage();
    await this.prepareChatSurface(page);
    const url = page.url();
    if (!detectCapabilities) return { authenticated: true, temporary: true, url };
    const capabilities = await detectChatGptAccountCapabilities(page);
    return { authenticated: true, temporary: true, url, ...capabilities };
  }

  private async smokeTestExclusive(abortSignal?: AbortSignal): Promise<{ effort: string; response: string }> {
    const page = await this.ensurePage();
    await this.prepareChatSurface(page);
    const account = await detectChatGptAccountCapabilities(page);
    // Core smoke runs before the optional MCP connector is configured, so it must remain a
    // browser-only transport check. Connector setup has its own explicit verification operation.
    const capabilities: ChatGptWebCapabilities = { ...account, localToolsEnabled: false };
    const modelId = account.solAvailable ? CHATGPT_WEB_MODEL_ID : CHATGPT_WEB_LUNA_MODEL_ID;
    const reasoning = account.solAvailable ? "high" : "low";
    const mode = resolveChatGptWebModelMode(modelId, reasoning, capabilities);
    const traceId = `smoke_${randomUUID().replaceAll("-", "")}`;
    const response = await this.runBrowserTurn({
      traceId,
      modelId,
      reasoning,
      capabilities,
      prepare: async () => ({ text: CHATGPT_SMOKE_TEXT, images: [], release: () => {} }),
      abortSignal,
      onTextDelta: () => {},
    }, undefined, page);
    if (response.trim() !== CHATGPT_SMOKE_EXPECTED) {
      throw new Error(
        `ChatGPT smoke test returned an unexpected answer (${JSON.stringify(response.trim().slice(0, 200))})`,
      );
    }
    return { effort: mode.displayLabel, response: CHATGPT_SMOKE_EXPECTED };
  }

  private async attachFiles(page: Page, prompt: CompiledChatGptWebPrompt): Promise<void> {
    const files = chatGptPromptFilePayloads(prompt);
    if (files.length === 0) return;
    const composer = await this.activeComposer(page);
    const composerForm = composer.locator("xpath=ancestor::form[1]");
    const input = page.locator('input[data-testid="upload-photos-input"], form[data-chatgpt-composer] input[type="file"][multiple]:not([accept])');
    await input.waitFor({ state: "attached", timeout: 20_000 });
    await input.setInputFiles(files);
    try {
      await Promise.all(files.map(file => (
        composerForm.getByRole("group", { name: file.name, exact: true })
          .or(composerForm.locator(`.composer-attachment-surface:is(button, [role="button"])[aria-label=${JSON.stringify(file.name)}]`))
          .waitFor({ state: "visible", timeout: 60_000 })
      )));
    } catch {
      const alerts = (await page.locator('[role="alert"]').allInnerTexts().catch(() => []))
        .map(text => text.replace(/\s+/g, " ").trim())
        .filter(Boolean);
      throw new Error(
        `ChatGPT did not accept all prompt attachments`
        + (alerts.length > 0 ? `: ${alerts.join(" | ")}` : ""),
      );
    }
    const send = composerForm.locator(CHATGPT_SEND_BUTTON_SELECTOR);
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (await send.isEnabled().catch(() => false)) return;
      await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
    }
    throw new Error("ChatGPT accepted the prompt attachments but did not make the message ready to send");
  }

  private async responseDomSnapshot(
    responseTurn: Locator,
    cache?: ChatGptResponseDomCache,
    identity?: string,
  ): Promise<ChatGptResponseDomSnapshot> {
    type ResponseOptions = {
      completionActionSelector: string;
      stoppedThinkingLabels: string[];
      knownKey?: string;
      attributeFilter: string[];
      rootSelector?: string;
    };
    const inspect = (elementOrOptions: HTMLElement | ResponseOptions, suppliedOptions?: ResponseOptions) => {
      const options = suppliedOptions ?? elementOrOptions as ResponseOptions;
      const roots = options.rootSelector
        ? [...document.querySelectorAll<HTMLElement>(options.rootSelector)]
        : [elementOrOptions as HTMLElement];
      if (roots.length > 1) throw new Error("ChatGPT exposed duplicate DOM nodes for the bound assistant turn");
      const root = roots[0];
      if (!root) return {
        key: "missing-bound-response",
        snapshot: {
          responsePresent: false, visibleText: "", fullHtml: "", markdownSegments: [],
          completionActionVisible: false, stoppedThinkingVisible: false, traceBlocks: [],
        } as ChatGptResponseDomSnapshot,
      };
      type ObserverState = {
        id: number;
        revision: number;
        observer: MutationObserver;
        rendered: Map<HTMLElement, boolean>;
      };
      type ObserverRegistry = { documentId: string; nextId: number; states: WeakMap<Element, ObserverState> };
      const scope = globalThis as typeof globalThis & {
        __CODEX_WEB_GPT_RESPONSE_OBSERVERS__?: ObserverRegistry;
      };
      const registry = scope.__CODEX_WEB_GPT_RESPONSE_OBSERVERS__ ??= {
        documentId: `${performance.timeOrigin}:${Math.random().toString(36).slice(2)}`,
        nextId: 0,
        states: new WeakMap<Element, ObserverState>(),
      };
      let observerState = registry.states.get(root);
      if (!observerState) {
        observerState = {
          id: ++registry.nextId,
          revision: 0,
          observer: undefined as unknown as MutationObserver,
          rendered: new Map<HTMLElement, boolean>(),
        };
        const state = observerState;
        state.observer = new MutationObserver(() => {
          state.revision += 1;
        });
        state.observer.observe(root, {
          subtree: true,
          childList: true,
          characterData: true,
          attributes: true,
          attributeFilter: options.attributeFilter,
        });
        registry.states.set(root, state);
      }
      // Browser turn WebContents are intentionally allowed to run while their Electron view is
      // hidden or has no measured width. Layout geometry is therefore not response visibility:
      // completed Markdown can have width=0 while remaining connected, rendered and readable.
      const isRendered = (candidate: HTMLElement): boolean => {
        if (!candidate.isConnected) return false;
        for (let node: HTMLElement | null = candidate; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (node.hidden || style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
        }
        return true;
      };
      // CSS animations and stylesheet changes can reveal an answer or its completion controls
      // without mutating this subtree. Recheck the rendering dependencies of the cached scan;
      // unchanged text/HTML still avoids the expensive serialization below.
      for (const [candidate, rendered] of observerState.rendered) {
        if (isRendered(candidate) !== rendered) {
          observerState.revision += 1;
          break;
        }
      }
      const observerKey = `${registry.documentId}:${observerState.id}:${observerState.revision}`;
      if (options.knownKey === observerKey) return { key: observerKey };
      observerState.rendered.clear();
      const renderedInDom = (candidate: HTMLElement): boolean => {
        const rendered = isRendered(candidate);
        observerState.rendered.set(candidate, rendered);
        return rendered;
      };

      // ChatGPT's DIL renderer has no .markdown class (#538). Read its response root within the
      // assistant-owned PUIK container; the CSS module hash is build-specific. Both renderers
      // feed the same content serializer and completion checks below, without reading UI text.
      const answerRootSelector = '.markdown, [data-message-author-role="assistant"] .puik-root.not-markdown > [class*="_DilResponseRoot"], [data-markdown-text-style="assistant-message"]';
      // In the Activity renderer, the agent-start marker owns the progress block
      // before an assistant search unit exists. Final answers have their own unit.
      const activityContainers = [...root.querySelectorAll<HTMLElement>("[data-chatgpt-agent-turn-start]")]
        .map(marker => marker.parentElement!);
      // ChatGPT uses the same content renderer for intermediate commentary and for the final
      // answer. Older responses nested commentary in the streaming-status container. Pro can also
      // render a completed commentary Markdown root immediately before that live status container.
      // Final-answer Markdown follows the live status instead, so DOM order remains the semantic
      // boundary without relying on localized labels such as "Pro thinking".
      const allMarkdownRoots = [...root.querySelectorAll<HTMLElement>(answerRootSelector)]
        .filter(candidate => {
          if (!root.hasAttribute("data-turn-key") && !candidate.hasAttribute("data-markdown-text-style")) return true;
          const unit = candidate.closest("[data-content-search-unit-key]");
          return unit ? Array.from(unit.children)
            .some(child => child.getAttribute("data-conversation-role") === "assistant")
            : activityContainers.some(container => container.contains(candidate));
        })
        .filter(candidate => !candidate.parentElement?.closest(answerRootSelector))
        .filter(renderedInDom);
      const streamingStatusContainers = [...root.querySelectorAll<HTMLElement>("[data-streaming-response-status]")]
        .filter(renderedInDom);
      // Captured Activity uses the same Markdown component for public action summaries
      // and assistant commentary, including summaries outside activity-header rows.
      // Its explicit tone distinguishes these within the agent's progress section;
      // a final-answer search unit remains an answer regardless of its text tone.
      const activitySummaryRoots = new Set(allMarkdownRoots.filter(candidate => (
        candidate.getAttribute("data-markdown-text-tone") === "tertiary"
        && !candidate.closest("[data-content-search-unit-key]")
        && activityContainers.some(container => container.contains(candidate))
      )));
      // CHATGPT_COMMENTARY_CLASSIFIER_BEGIN
      // Self-contained so the test suite can execute this exact source against a synthetic DOM;
      // it must not close over anything from the surrounding evaluate scope.
      const selectChatGptAnswerRoots = (
        markdownRoots: HTMLElement[],
        statusContainers: HTMLElement[],
        activityContainers: HTMLElement[] = [],
      ): { commentaryRoots: HTMLElement[]; answerRoots: HTMLElement[] } => {
        const firstStatusContainer = statusContainers[0];
        const commentary = markdownRoots.filter(candidate => (
          (!candidate.closest("[data-content-search-unit-key]")
            && activityContainers.some(container => container.contains(candidate)))
          || candidate.closest("[data-streaming-response-status]") !== null
          // Chain-of-thought components carry reasoning, never the final answer, so containment is
          // a position-independent commentary signal. Position alone cannot separate "commentary
          // between two status containers" from "answer between two tool calls".
          || candidate.closest('[data-testid^="cot-v5"]') !== null
          // Only Markdown that precedes the FIRST status container is prior commentary. Keying
          // this on "some status follows me" silently reclassified answer text as commentary as
          // soon as a second tool call opened another status container below it, which both zeroed
          // the visible text and dropped every answer chunk emitted between tool calls.
          || (firstStatusContainer !== undefined && Boolean(
            // 4 is Node.DOCUMENT_POSITION_FOLLOWING, inlined to keep this function standalone.
            candidate.compareDocumentPosition(firstStatusContainer) & 4,
          ))
        ));
        return {
          commentaryRoots: commentary,
          answerRoots: markdownRoots.filter(candidate => !commentary.includes(candidate)),
        };
      };
      // CHATGPT_COMMENTARY_CLASSIFIER_END
      const classified = selectChatGptAnswerRoots(
        allMarkdownRoots.filter(candidate => !activitySummaryRoots.has(candidate)),
        streamingStatusContainers,
        activityContainers,
      );
      const commentaryRoots = classified.commentaryRoots;
      const renderedRoots = classified.answerRoots;
      // CHATGPT_MARKDOWN_CONTENT_BEGIN
      const chatGptMarkdownContent = (markdownRoot: HTMLElement): HTMLElement => {
        const content = markdownRoot.cloneNode(true) as HTMLElement;
        // These are embedded renderers, not Markdown answer text. Their loading labels, controls
        // and plot axes change independently of generation (including after a later paragraph).
        // Keep their UI out of both the emitted HTML and the text consistency fingerprint.
        // Also remove the media already excluded by chatGptHtmlToMarkdown, so their
        // accessibility labels cannot become consistency fingerprints for untransmitted text.
        // Ordinary code blocks, surrounding prose and the original observed DOM remain intact.
        for (const widget of Array.from(content.querySelectorAll(
          ".chart-widget-container, [data-code-block-preview-pane], script, style, svg, img, picture, source",
        ))) widget.remove();
        for (const button of Array.from(content.querySelectorAll("button"))) {
          // Observed file-reference controls have a label but no authoritative download URL.
          // Keep only their text; never carry button attributes or infer a link from the name.
          if (button.matches(".behavior-btn.entity-underline")
            && !button.closest('[hidden], [aria-hidden="true"]')) {
            for (const hidden of Array.from(button.querySelectorAll('[hidden], [aria-hidden="true"], .sr-only, [role="tooltip"]'))) {
              hidden.remove();
            }
            button.replaceWith(content.ownerDocument.createTextNode(button.textContent ?? ""));
          } else {
            button.remove();
          }
        }
        // The new renderer wraps code in DIVs, including a localized toolbar that can
        // disappear on completion. Project only the code into PRE before fingerprinting
        // and Markdown conversion; otherwise the toolbar changes the committed text and
        // Turndown collapses code newlines as if they were ordinary inline whitespace.
        const codeBlockSelector = 'pre, [data-markdown-copy="code-block"]';
        for (const block of Array.from(content.querySelectorAll(codeBlockSelector))) {
          if (block.parentElement?.closest(codeBlockSelector)) continue;
          const codes = block.querySelectorAll("code");
          if (codes.length !== 1) continue;
          const code = codes[0]!.cloneNode(true);
          const pre = block.tagName === "PRE" ? block : content.ownerDocument.createElement("pre");
          block.textContent = "";
          pre.appendChild(code);
          if (pre !== block) block.appendChild(pre);
        }
        return content;
      };
      // ChatGPT may merge adjacent `.markdown` roots or virtualize an earlier prefix while a streamed
      // answer is finalized. Root boundaries and visible indices therefore are not identity:
      // flatten semantic blocks and preserve ChatGPT's source ranges across that reparenting.
      const flattenedMarkdownSegments: Array<{
        tag: string;
        html: string;
        text: string;
        pendingLinks: boolean;
        linkTargets: string[];
        group?: string;
        sourceStart?: number;
        sourceEnd?: number;
      }> = [];
      const blockMarkdownTags = new Set([
        "address", "article", "aside", "blockquote", "div", "dl", "fieldset", "figcaption",
        "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
        "li", "main", "nav", "ol", "p", "pre", "section", "table", "ul",
      ]);
      const markdownText = (element: HTMLElement): string => {
        // Detached content has no layout-derived innerText. Preserve textual line boundaries
        // explicitly: plain textContent would conflate "A<br>B" with "AB" in the guard.
        const parts: string[] = [];
        const blockBoundary = () => {
          if (parts.length > 0 && !parts.at(-1)!.endsWith("\n")) parts.push("\n");
        };
        const visit = (node: Node) => {
          if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? "");
          if (!(node instanceof HTMLElement)) return;
          const tag = node.tagName.toLowerCase();
          const block = blockMarkdownTags.has(tag);
          if (block) blockBoundary();
          if (tag === "br") parts.push("\n");
          node.childNodes.forEach(visit);
          if (block) blockBoundary();
        };
        visit(element);
        return parts.join("").trim();
      };
      // CHATGPT_MARKDOWN_CONTENT_END
      let listGroupIndex = 0;
      const sourceRange = (candidate: Element): { sourceStart: number; sourceEnd: number } | undefined => {
        const startAttribute = candidate.getAttribute("data-start");
        const endAttribute = candidate.getAttribute("data-end");
        if (startAttribute === null || endAttribute === null) return undefined;
        if (!startAttribute.trim() || !endAttribute.trim()) return undefined;
        const sourceStart = Number(startAttribute);
        const sourceEnd = Number(endAttribute);
        return Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd >= sourceStart
          ? { sourceStart, sourceEnd }
          : undefined;
      };
      const linkState = (element: HTMLElement): { pendingLinks: boolean; linkTargets: string[] } => {
        // ChatGPT may paint a link label before supplying its destination. An append-only
        // response cannot add that destination back after committing the label as plain text.
        const anchors = [element, ...element.querySelectorAll<HTMLElement>("a")]
          .filter(candidate => candidate.tagName === "A" && Boolean(candidate.textContent?.trim()));
        return {
          pendingLinks: anchors.some(candidate => !candidate.getAttribute("href")?.trim()),
          linkTargets: anchors.flatMap(candidate => {
            const href = candidate.getAttribute("href");
            return href?.trim() ? [href] : [];
          }),
        };
      };
      const appendBlockSegment = (child: HTMLElement) => {
        const tag = child.tagName.toLowerCase();
        const childRange = sourceRange(child);
        const listItems = tag === "ol" || tag === "ul"
          ? [...child.children].filter(candidate => candidate.tagName === "LI") as HTMLElement[]
          : [];
        if (listItems.length === 0) {
          flattenedMarkdownSegments.push({
            tag,
            html: child.outerHTML,
            text: markdownText(child),
            ...linkState(child),
            ...childRange,
          });
          return;
        }

        const group = childRange
          ? `list:${childRange.sourceStart}:${tag}`
          : `list:${listGroupIndex++}:${tag}`;
        const orderedStart = tag === "ol" ? Number(child.getAttribute("start") ?? "1") : undefined;
        listItems.forEach((item, itemIndex) => {
          const shell = child.cloneNode(false) as HTMLElement;
          shell.removeAttribute("data-is-last-node");
          if (orderedStart !== undefined && Number.isFinite(orderedStart)) {
            shell.setAttribute("start", String(orderedStart + itemIndex));
          }
          shell.append(item.cloneNode(true));
          flattenedMarkdownSegments.push({
            tag: `${tag}:item`,
            html: shell.outerHTML,
            text: markdownText(item),
            ...linkState(item),
            group,
            ...sourceRange(item),
          });
        });
      };
      renderedRoots.map(chatGptMarkdownContent).forEach((markdownRoot) => {
        const children = [...markdownRoot.children] as HTMLElement[];
        const hasBlockChildren = children.some(child => blockMarkdownTags.has(child.tagName.toLowerCase()));
        if (!hasBlockChildren) {
          if (markdownRoot.innerHTML.trim()) flattenedMarkdownSegments.push({
            tag: "root",
            html: markdownRoot.innerHTML,
            text: markdownText(markdownRoot),
            ...linkState(markdownRoot),
            ...sourceRange(markdownRoot),
          });
          return;
        }

        let inlineRun: Node[] = [];
        const flushInlineRun = () => {
          if (inlineRun.length === 0) return;
          const nodes = inlineRun;
          inlineRun = [];
          const shell = document.createElement("span");
          nodes.forEach(node => shell.append(node.cloneNode(true)));
          const text = markdownText(shell);
          if (text) {
            const rangedElements = nodes.flatMap(node => node instanceof Element
              ? [node, ...node.querySelectorAll<HTMLElement>("[data-start][data-end]")]
              : []);
            const ranges = rangedElements
              .map(sourceRange)
              .filter((range): range is { sourceStart: number; sourceEnd: number } => range !== undefined);
            flattenedMarkdownSegments.push({
              tag: "inline",
              html: shell.outerHTML,
              text,
              ...linkState(shell),
              ...(ranges.length > 0 ? {
                sourceStart: Math.min(...ranges.map(range => range.sourceStart)),
                sourceEnd: Math.max(...ranges.map(range => range.sourceEnd)),
              } : {}),
            });
          }
        };

        markdownRoot.childNodes.forEach((node) => {
          if (node instanceof HTMLElement && blockMarkdownTags.has(node.tagName.toLowerCase())) {
            flushInlineRun();
            appendBlockSegment(node);
            return;
          }
          inlineRun.push(node);
        });
        flushInlineRun();
      });
      const markdownSegments = flattenedMarkdownSegments.map((segment, index, segments) => ({
        key: segment.sourceStart !== undefined
          ? `${segment.sourceStart}:${segment.tag}`
          : `${index}:${segment.tag}`,
        tag: segment.tag,
        html: segment.html,
        text: segment.text,
        ...(segment.group ? { group: segment.group } : {}),
        ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
        ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
        streamable: index < segments.length - 1 && !segment.pendingLinks,
        linkTargets: segment.linkTargets,
      }));
      const rendered = renderedRoots.at(-1);
      const completionAction = rendered
        ? [...root.querySelectorAll<HTMLElement>(options.completionActionSelector)]
          .filter(renderedInDom)
          .find(candidate => !rendered.contains(candidate)
            && Boolean(rendered.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING))
        : undefined;
      const completionActionSet = new Set(completionAction ? [completionAction] : []);
      const candidates = new Map<HTMLElement, ChatGptVisibleTraceBlock["kind"]>();
      renderedRoots.forEach(candidate => candidates.set(candidate, "answer"));
      commentaryRoots.forEach(candidate => candidates.set(candidate, "commentary"));
      activitySummaryRoots.forEach(candidate => candidates.set(candidate, "status"));
      const overlapsRenderedAnswer = (candidate: HTMLElement): boolean => renderedRoots.some(rendered => (
        candidate.contains(rendered) || rendered.contains(candidate)
      ));
      const overlapsCommentary = (candidate: HTMLElement): boolean => commentaryRoots.some(commentary => (
        candidate.contains(commentary) || commentary.contains(candidate)
      ));
      const overlapsActivitySummary = (candidate: HTMLElement): boolean => [...activitySummaryRoots].some(summary => (
        candidate.contains(summary) || summary.contains(candidate)
      ));
      const statusSemantic = (candidate: HTMLElement): HTMLElement => {
        // Current cot-v5 action rows expose the semantic text on their item anchor while the
        // discoverable data-testid lives on a textless icon below it. Promote that descendant to
        // the owned row; otherwise every non-button action is silently filtered as empty text.
        return candidate.closest<HTMLElement>("button")
          ?? candidate.closest<HTMLElement>("[data-item-anchor]")
          ?? candidate;
      };
      const traceText = (candidate: HTMLElement): string => {
        const ariaLabel = candidate.getAttribute("aria-label")?.trim();
        if (ariaLabel) return ariaLabel;
        // Animated ChatGPT action counters visually split a phrase around the changing number, so
        // `innerText` can become `Searching websites\n3`. The button's screen-reader label already
        // carries the stable semantic phrase (`Searching 3 websites`) without enclosing unrelated
        // commentary from the surrounding streaming-status container.
        const screenReaderText = [...candidate.querySelectorAll<HTMLElement>(".sr-only")]
          .map(element => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
          .find(Boolean);
        return screenReaderText || candidate.innerText.trim();
      };
      const traceKey = (candidate: HTMLElement, kind: ChatGptVisibleTraceBlock["kind"]): string | undefined => {
        const statusContainer = candidate.closest<HTMLElement>("[data-streaming-response-status]");
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        if (!statusContainer || !itemAnchor) return undefined;
        const anchorIndex = [...statusContainer.querySelectorAll<HTMLElement>("[data-item-anchor]")]
          .indexOf(itemAnchor);
        return anchorIndex >= 0 ? `${kind}:anchor:${anchorIndex}` : undefined;
      };
      const hasFollowingRenderedSibling = (candidate: HTMLElement): boolean => {
        const itemAnchor = candidate.closest<HTMLElement>("[data-item-anchor]");
        for (
          let sibling = itemAnchor?.nextElementSibling;
          sibling;
          sibling = sibling.nextElementSibling
        ) {
          if (sibling instanceof HTMLElement && renderedInDom(sibling) && sibling.innerText.trim()) {
            return true;
          }
        }
        return false;
      };
      root.querySelectorAll<HTMLElement>(
        'button, [role="status"], [aria-busy="true"], [data-testid*="cot"], [data-testid*="reason"], [data-testid*="thought"]',
      ).forEach(candidate => {
        if (completionActionSet.has(candidate)) return;
        if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)) return;
        const semantic = statusSemantic(candidate);
        // A renderer may wrap the final Markdown in a reason/status container. That wrapper and
        // its descendants still belong exclusively to the final-answer stream; assigning either
        // side to the trace stream duplicates or truncates the answer under Codex's `Working` UI.
        if (!overlapsRenderedAnswer(semantic)
          && !overlapsCommentary(semantic)
          && !overlapsActivitySummary(semantic)
          && !candidates.has(semantic)) {
          candidates.set(semantic, "status");
        }
      });
      root.querySelectorAll<HTMLElement>("[data-streaming-response-status]").forEach(container => {
        if (!overlapsRenderedAnswer(container)
          && !overlapsCommentary(container)
          && ![...candidates.keys()].some(candidate => container.contains(candidate))) {
          candidates.set(container, "status");
        }
      });
      const traceByKey = new Map<string, ChatGptVisibleTraceBlock>();
      [...candidates]
        .filter(([candidate]) => renderedInDom(candidate))
        .sort(([left], [right]) => left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1)
        .map(([candidate, kind]) => ({
          kind,
          text: traceText(candidate),
          key: traceKey(candidate, kind),
          ...(kind === "commentary" ? { complete: hasFollowingRenderedSibling(candidate) } : {}),
          // Footer controls such as the model picker and overflow menu are siblings of the final
          // Markdown inside the assistant turn. They are UI, not model trace. Real action buttons
          // are scoped by ChatGPT's streaming-status container.
          uiControl: candidate.matches("button")
            && candidate.closest("[data-streaming-response-status]") === null,
        }))
        .filter(block => block.text.length > 0)
        .forEach((block, index) => {
          const key = block.key ?? `${block.kind}:fallback:${index}`;
          const previous = traceByKey.get(key);
          if (!previous || block.text.length > previous.text.length) traceByKey.set(key, block);
        });
      const traceBlocks = [...traceByKey.values()].map((block, index, blocks) => ({
        ...block,
        ...(block.kind === "commentary" ? {
          complete: block.complete === true || index < blocks.length - 1,
        } : {}),
      }));
      const stoppedThinkingVisible = (() => {
        // Only ChatGPT UI in the bound response may terminate the turn. A model quoting this
        // phrase in its answer or reasoning is ordinary content, not a stopped-thinking status.
        // Match the site's observed labels regardless of the account/document language.
        const labels = new Set<string>(options.stoppedThinkingLabels);
        const isStoppedLabel = (value: string | null): boolean => labels.has(value?.replace(/\s+/g, " ").trim() ?? "");
        const isStatus = (candidate: HTMLElement): boolean => {
          if (overlapsRenderedAnswer(candidate) || overlapsCommentary(candidate)
            || candidate.closest("pre, code, blockquote")) return false;
          for (let element: HTMLElement | null = candidate; element; element = element.parentElement) {
            if (!renderedInDom(element)) return false;
          }
          return true;
        };
        const ariaMatch = Array.from(root.querySelectorAll<HTMLElement>("[aria-label]"))
          .some(candidate => isStoppedLabel(candidate.getAttribute("aria-label")) && isStatus(candidate));
        if (ariaMatch) return true;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!isStoppedLabel(node.textContent)) continue;
          const parent = node.parentElement;
          if (parent && isStatus(parent)) return true;
        }
        return false;
      })();
      return {
        key: observerKey,
        snapshot: {
          responsePresent: true,
          visibleText: renderedRoots.map(candidate => candidate.innerText.trim()).filter(Boolean).join("\n\n"),
          fullHtml: renderedRoots.map(candidate => candidate.innerHTML).join(""),
          markdownSegments,
          completionActionVisible: completionAction !== undefined,
          stoppedThinkingVisible,
          traceBlocks,
        },
      };
    };
    const options: ResponseOptions = {
      completionActionSelector: CHATGPT_COMPLETION_ACTION_SELECTOR,
      stoppedThinkingLabels: [...CHATGPT_STOPPED_THINKING_LABELS],
      knownKey: cache?.key,
      attributeFilter: [...CHATGPT_DOM_REVISION_ATTRIBUTES],
    };
    // Electron's hidden owned pages can resolve Locator handles several seconds after the DOM
    // is readable. Inspect the already-bound identity in one page transaction instead. A genuine
    // observation timeout belongs to bounded page recovery, never to the missing-response grace.
    const ownedPageRead = this.config?.browserHost === "launcher" && identity !== undefined;
    const observed = await (ownedPageRead
      ? withChatGptBrowserObservationTimeout(responseTurn.page().evaluate(inspect, {
        ...options, rootSelector: chatGptAssistantTurnSelector(identity),
      }))
      : responseTurn.evaluate(inspect, options, { timeout: 2_000 })
    ).catch(error => {
      if (error instanceof ChatGptBrowserObservationTimeoutError
        || (error instanceof Error && error.message.includes("duplicate DOM nodes for the bound assistant turn"))) throw error;
      return undefined;
    });
    if (!observed) {
      if (responseTurn.page().isClosed()) {
        throw chatGptBrowserTabClosedError();
      }
      return absentResponseDomSnapshot();
    }
    const snapshot = observed.snapshot ?? cache?.snapshot ?? absentResponseDomSnapshot();
    if (observed.snapshot && cache) {
      cache.key = observed.key;
      cache.snapshot = observed.snapshot;
      cache.fullScans = (cache.fullScans ?? 0) + 1;
    } else if (!observed.snapshot && cache?.snapshot) {
      cache.cacheHits = (cache.cacheHits ?? 0) + 1;
    }
    snapshot.traceBlocks = snapshot.traceBlocks
      .map(stripChatGptTraceControlSuffix)
      .filter(block => block.text.length > 0 && !isChatGptTraceControl(block));
    return snapshot;
  }

  private async stalledTurnDiagnostic(page: Page, responseTurn: Locator): Promise<string> {
    const responseState = await responseTurn.count()
      ? await responseTurn.evaluate(element => {
        const root = element as HTMLElement;
        const descriptors = [...root.querySelectorAll<HTMLElement>("[role], [data-testid], button, [aria-label]")]
          .filter(candidate => {
            const style = getComputedStyle(candidate);
            return style.visibility !== "hidden" && style.display !== "none";
          })
          .slice(-80)
          .map(candidate => ({
            tag: candidate.tagName.toLowerCase(),
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            titleChars: candidate.getAttribute("title")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          }));
        return {
          textChars: (root.innerText ?? root.textContent ?? "").trim().length,
          htmlChars: root.innerHTML.length,
          descriptors,
        };
      })
      : { text: "", descriptors: [] };
    const overlays = await page.locator('[role="dialog"], [role="alert"], [role="status"]').evaluateAll(elements => (
      elements
        .filter(element => {
          const candidate = element as HTMLElement;
          const style = getComputedStyle(candidate);
          return style.visibility !== "hidden" && style.display !== "none";
        })
        .slice(-30)
        .map(element => {
          const candidate = element as HTMLElement;
          return {
            role: candidate.getAttribute("role"),
            testId: candidate.getAttribute("data-testid"),
            ariaLabelChars: candidate.getAttribute("aria-label")?.length ?? 0,
            textChars: (candidate.innerText ?? candidate.textContent ?? "").trim().length,
          };
        })
    )).catch(() => [] as Array<Record<string, string | null>>);
    return redactChatGptUiDiagnostic(JSON.stringify({ response: responseState, overlays }));
  }

  private async runExclusive(turn: BrowserTurn): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if (this.config.browserHost !== "launcher") return this.runBrowserTurn(turn);

    const lease = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
      phase: "start",
      traceId: turn.traceId,
      helperPid: process.pid,
      ...(turn.conversationKey ? { conversationKey: turn.conversationKey } : {}),
      ...((turn.conversationKey
        && (turn.nativeConnector || turn.capabilities.localToolsEnabled || turn.requireRetainedConversation))
        ? { connectorIdentity: this.config.appName }
        : {}),
      ...(turn.requireRetainedConversation ? { requireRetainedConversation: true } : {}),
    }, undefined, turn.abortSignal).catch(error => {
      if (error instanceof LauncherBrowserTurnCancelledError) throw chatGptBrowserTabClosedError();
      if (error instanceof LauncherRetainedConversationUnavailableError) {
        throw chatGptRetainedConversationUnavailableError();
      }
      throw error;
    });
    const surfaceId = lease.surfaceId;
    const reused = lease.reused === true;
    let terminal: "completed" | "failed" | "aborted" = "completed";
    let terminalMessage: string | undefined;
    let originalError: unknown;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let heartbeatInFlight = false;
    let lastHeartbeatFailureAt = 0;
    const sendHeartbeat = () => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = true;
      void notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
        phase: "heartbeat",
        traceId: turn.traceId,
        helperPid: process.pid,
      }, LAUNCHER_TURN_HEARTBEAT_TIMEOUT_MS).catch(error => {
        const now = Date.now();
        if (now - lastHeartbeatFailureAt < 30_000) return;
        lastHeartbeatFailureAt = now;
        console.warn(
          `[chatgpt-web] launcher turn heartbeat failed for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        heartbeatInFlight = false;
      });
    };
    try {
      if (!surfaceId) throw new Error("Launcher did not lease a browser tab for the ChatGPT turn");
      if (turn.requireRetainedConversation && !reused) {
        throw chatGptRetainedConversationUnavailableError();
      }
      if (reused && !turn.prepareResume) {
        throw new Error("Launcher reused a ChatGPT conversation without a continuation prompt");
      }
      await turn.onPreparedSelected?.(reused);
      heartbeatTimer = setInterval(sendHeartbeat, LAUNCHER_TURN_HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref?.();
      return await this.runBrowserTurn(turn, surfaceId, undefined, reused, lease.trackUsage === true);
    } catch (error) {
      originalError = error;
      terminal = error instanceof ChatGptCompactionHandoffAccepted
        ? "completed"
        : (error instanceof DOMException && error.name === "AbortError")
        || (error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")
        ? "aborted"
        : "failed";
      terminalMessage = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      throw error;
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      try {
        const release = await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
          phase: "end",
          traceId: turn.traceId,
          helperPid: process.pid,
          status: terminal,
          ...(terminalMessage ? { message: terminalMessage } : {}),
          ...(terminal === "completed" && turn.retainConversation ? { retain: true } : {}),
          ...(terminal === "completed" && (turn.nativeConnector || turn.capabilities.localToolsEnabled)
            ? { connectorBound: true }
            : {}),
        });
        if (release.cancelledByUser) throw chatGptBrowserTabClosedError();
        if (release.authenticationRequired && terminal !== "aborted") {
          throw new ChatGptWebAdapterError(
            "ChatGPT requested sign-in. Open sign in in the launcher, then retry.",
            { status: 401, errorType: "authentication_error", code: "chatgpt_sign_in_required", retryable: false },
          );
        }
      } catch (controlError) {
        if (controlError instanceof ChatGptWebAdapterError
          && ["client_cancelled", "chatgpt_sign_in_required"].includes(controlError.code)) {
          throw controlError;
        }
        if (!originalError) throw controlError;
        console.error(
          `[chatgpt-web] launcher turn-end notification failed after browser error: ${controlError instanceof Error ? controlError.message : String(controlError)}`,
        );
      }
    }
  }

  private async runBrowserTurn(
    turn: BrowserTurn,
    launcherSurfaceId?: string,
    maintenancePage?: Page,
    reuseConversation = false,
    trackUsage = false,
  ): Promise<string> {
    if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
    if ((turn.externalProgress !== undefined) !== (turn.completionFence !== undefined)) {
      throw new Error("Tool-capable ChatGPT turns require both progress and terminal-fence transports");
    }
    if ((turn.captureLunaCheckpoint === true) !== (turn.onLunaCheckpoint !== undefined)) {
      throw new Error("ChatGPT Luna checkpoint capture requires exactly one checkpoint callback");
    }
    if (turn.captureLunaCheckpoint && turn.modelId !== CHATGPT_WEB_LUNA_MODEL_ID) {
      throw new Error("Private rolling checkpoint capture is valid only for ChatGPT Luna");
    }
    const browserCapabilities = turn.nativeConnector
      ? { ...turn.capabilities, localToolsEnabled: true }
      : turn.capabilities;
    const requestedMode = resolveChatGptWebModelMode(turn.modelId, turn.reasoning, browserCapabilities);
    const prepare = reuseConversation ? turn.prepareResume : turn.prepare;
    if (!prepare) throw new Error("The retained ChatGPT conversation has no continuation prompt");
    const prepared = await prepare();
    const diagnostics = new ChatGptBrowserDiagnostics(
      turn.traceId,
      this.config.browserDiagnosticsPath ?? join(getConfigDir(), "diagnostics", "browser-turns"),
      this.config.appName,
    );
    let turnConnection: Browser | undefined;
    let managedPage: Page | undefined;
    let diagnosticPage: Page | undefined;
    const usageWrites: Promise<void>[] = [];
    const submissionRejection = new ChatGptSubmissionRejectionObserver();
    try {
      if (turn.abortSignal?.aborted) throw new DOMException("ChatGPT web turn aborted", "AbortError");
      // Validate only the selected physical message, not canonical history used for usage estimates.
      assertChatGptPromptAttachments(prepared);
      const multipartTransactionId = prepared.multipart
        ? `ctx_${randomUUID().replaceAll("-", "")}`
        : undefined;
      const multipartStages = prepared.multipart && multipartTransactionId
        ? prepared.multipart.parts.slice(0, -1).map((payload, index) => formatChatGptWebMultipartStage(
          payload,
          multipartTransactionId,
          index + 1,
          prepared.multipart!.parts.length,
        ))
        : undefined;
      const multipartFinalPrompt = prepared.multipart && multipartTransactionId
        ? formatChatGptWebMultipartCommit(prepared.multipart, multipartTransactionId)
        : undefined;
      const estimatedInputTokens = estimateCompiledChatGptWebInputTokens(prepared, turn.modelId);
      const estimatedMessageTokens = estimateCompiledChatGptWebMessageTokens(prepared, turn.modelId);
      const maxMessageChars = compiledChatGptWebMaxMessageChars(prepared);
      const maxStageMessageTokens = multipartStages
        ? Math.max(...multipartStages.map(stage => estimateTokens(stage.text, turn.modelId)))
        : undefined;
      const maxStageChars = multipartStages
        ? Math.max(...multipartStages.map(stage => stage.text.length))
        : undefined;
      const stagingMode = multipartStages
        ? resolveChatGptWebMultipartStagingMode(
          turn.modelId,
          browserCapabilities,
          maxStageMessageTokens!,
          maxStageChars!,
        )
        : requestedMode;
      if (prepared.multipart) {
        assertChatGptWebMultipartInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          browserCapabilities,
          maxMessageChars,
          prepared.multipart.parts.length,
          multipartStages
            && multipartFinalPrompt
            && maxStageMessageTokens !== undefined
            && maxStageChars !== undefined ? {
            stagingEffort: stagingMode.effort,
            maxStageMessageTokens,
            maxStageChars,
            finalMessageTokens: estimateTokens(multipartFinalPrompt, turn.modelId) + skillFileTokens(prepared.skillFiles, turn.modelId),
            finalMessageChars: multipartFinalPrompt.length,
            finalImageTokens: estimateChatGptWebImageTokens(prepared),
          } : undefined,
        );
      } else {
        assertChatGptWebInputWithinLimits(
          estimatedInputTokens,
          estimatedMessageTokens,
          turn.modelId,
          requestedMode.effort,
          browserCapabilities,
          maxMessageChars,
        );
      }
      const deadline = this.config.turnTimeoutMs === undefined
        ? undefined
        : Date.now() + this.config.turnTimeoutMs;
      let page = await this.runStage(turn.traceId, "browser_page", browserStageTimeouts.browserPage, async (abortSignal) => {
        if (maintenancePage) return maintenancePage;
        if (!launcherSurfaceId) {
          const managed = await this.pageForNewTurn();
          if (abortSignal.aborted) {
            await managed.close().catch(() => {});
            throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
          }
          return managed;
        }
        if (reuseConversation) {
          // The previous CDP disconnect can clear Chromium's effective emulation while
          // Electron retains its cached size. Refresh this exact lease before reconnecting,
          // just as observation recovery already does; no navigation or new Send is needed.
          await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
            phase: "heartbeat",
            traceId: turn.traceId,
            helperPid: process.pid,
            refreshViewport: true,
          });
        }
        const connection = await connectLauncherBrowserHost(
          this.config.browserHostDescriptorPath!,
          browserStageTimeouts.browserPage,
          launcherSurfaceId,
          abortSignal,
        );
        if (abortSignal.aborted) {
          await connection.browser.close().catch(() => {});
          throw new DOMException("ChatGPT browser page acquisition aborted", "AbortError");
        }
        turnConnection = connection.browser;
        diagnosticPage = connection.page;
        await waitForOperationalChatGptViewport(connection.page, abortSignal);
        return connection.page;
      });
      if (!maintenancePage && !launcherSurfaceId) managedPage = page;
      diagnosticPage = page;
      const rebindLauncherPage = async (
        attempt: number,
        cause: Error,
        callerSignal?: AbortSignal,
      ): Promise<void> => {
        if (!launcherSurfaceId || !this.config.browserHostDescriptorPath) throw cause;
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} is rebinding its existing launcher page after a stalled DOM probe:`
          + ` ${redactChatGptUiDiagnostic(cause.message)}`,
        );
        const previousConnection = turnConnection;
        // The observation timeout races the Playwright operation but cannot cancel the underlying
        // page.evaluate by itself. A failed disconnect is terminal: opening a replacement while
        // the stale probe still owns its transport would recreate the contention this rebind is
        // meant to remove.
        const connection = await connectAfterClosingBrowserConnection(
          previousConnection,
          () => {
            turnConnection = undefined;
            return this.runStage(
              turn.traceId,
              `response_page_rebind_${attempt}`,
              browserStageTimeouts.browserPage,
              async (stageSignal) => {
                const signal = callerSignal
                  ? AbortSignal.any([stageSignal, callerSignal])
                  : turn.abortSignal
                    ? AbortSignal.any([stageSignal, turn.abortSignal])
                    : stageSignal;
                await notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
                  phase: "heartbeat",
                  traceId: turn.traceId,
                  helperPid: process.pid,
                  refreshViewport: true,
                });
                const rebound = await connectLauncherBrowserHost(
                  this.config.browserHostDescriptorPath!,
                  browserStageTimeouts.browserPage,
                  launcherSurfaceId,
                  signal,
                );
                // Own the connection before validating its page: viewport failure still needs
                // the outer diagnostic capture and finally block to release this exact transport.
                turnConnection = rebound.browser;
                diagnosticPage = rebound.page;
                await waitForOperationalChatGptViewport(rebound.page, signal);
                return rebound;
              },
            );
          },
        );
        turnConnection = connection.browser;
        page = connection.page;
        diagnosticPage = page;
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} rebound its existing launcher page after a stalled DOM probe`,
        );
      };
      const recoverPageObservation = async (
        attempt: number,
        cause: ChatGptBrowserObservationTimeoutError,
        baseline: ChatGptSubmissionBaseline,
        checkpoint: "submission-page-rebound" | "assistant-page-rebound",
        abortSignal?: AbortSignal,
      ): Promise<ChatGptSubmissionObservationRecovery> => {
        await rebindLauncherPage(attempt, cause, abortSignal);
        const reboundBaseline: ChatGptSubmissionBaseline = {
          ...baseline,
          userTurns: page.locator(CHATGPT_USER_TURN_SELECTOR),
          responseTurns: page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR),
          domCache: {},
        };
        await diagnostics.capture(page, checkpoint);
        return { page, baseline: reboundBaseline };
      };
      const recoverSubmissionObservation: ChatGptObservationRecovery = (
        attempt,
        cause,
        baseline,
        abortSignal,
      ) => recoverPageObservation(
        attempt,
        cause,
        baseline,
        "submission-page-rebound",
        abortSignal,
      );
      const recoverAssistantObservation: ChatGptObservationRecovery = (
        attempt,
        cause,
        baseline,
        abortSignal,
      ) => recoverPageObservation(
        attempt,
        cause,
        baseline,
        "assistant-page-rebound",
        abortSignal,
      );
      // Rebinding the exact leased page is a browser-ownership operation. Read-only
      // compaction needs it too; acquiring MCP tools is not a prerequisite.
      const launcherObservationRecovery = launcherSurfaceId !== undefined
        && this.config.browserHostDescriptorPath !== undefined;
      await diagnostics.capture(page, "browser-page-acquired");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} opened (transport=${prepared.multipart ? `multipart-${prepared.multipart.parts.length}` : "inline"}, maxMessageChars=${maxMessageChars}, estimatedInputTokens=${estimatedInputTokens}, images=${prepared.images.length}, compactionTrimmedMessages=${prepared.trimmedCompactionMessages ?? 0})`,
      );
      if (multipartStages) {
        console.info(
          `[chatgpt-web] browser turn ${turn.traceId} multipart staging effort=${stagingMode.effort}`
          + ` maxStageMessageTokens=${maxStageMessageTokens} maxStageChars=${maxStageChars}`,
        );
      }
      if (!reuseConversation) {
        await this.runStage(
          turn.traceId,
          "temporary_chat_preparation",
          browserStageTimeouts.temporaryChatPreparation,
          () => this.prepareChatSurface(
            page,
            checkpoint => diagnostics.capture(page, checkpoint),
            // The saved-chat home can expose the unified Chat/Work composer
            // without model controls. A new, read-only summary uses the same
            // account's verified Temporary Chat; retained handoffs skip navigation.
            this.config.useSavedChats && !turn.compaction,
          ),
        );
      }
      // A retained lease proves the connector binding, not the current model selection.
      // Reconcile the live control before every submission, including retained continuations.
      const selectStagingMode = () => (
        this.selectModelAndEffort(
          page,
          turn.modelId,
          stagingMode.effort,
          browserCapabilities,
          checkpoint => diagnostics.capture(page, checkpoint),
          trackUsage,
          turn.modelFamily,
        )
      );
      let mode = await this.runStage(turn.traceId, "effort_selection", browserStageTimeouts.effortSelection, selectStagingMode);
      await diagnostics.capture(page, "effort-selection-complete");

      // One receipt per physical Send, not per native tool call or stream attachment.
      // The ID survives observation recovery; a new actual Send receives a new ID.
      const usageSubmission = async () => {
        if (!trackUsage) return undefined;
        const id = randomUUID();
        let accountKey: string | undefined;
        try {
          const account = await readChatGptUsageAccount(page);
          if (supportsChatGptUsageTracking(account)) accountKey = account.accountKey;
        } catch {
          // A missing identity is reported as a tracking gap, never charged to the previous account.
        }
        const model = mode.usageModel ?? (mode.effort === "max" ? "pro-unknown" : "other");
        return () => {
          // Do not spend the Send observation deadline waiting for optional local accounting.
          // Drain these bounded writes before releasing this turn's launcher lease.
          const write = notifyLauncherTurn(this.config.browserHostDescriptorPath!, {
            phase: "usage", traceId: turn.traceId, helperPid: process.pid,
            ...(accountKey ? { receipt: { id, accountKey, model, at: Date.now() } }
              : { trackingError: "account-unavailable" as const }),
          }).then(() => {}, () => {
            // Approximate accounting must not turn an already accepted model message into a retry.
            console.warn(`[chatgpt-web] Limits could not persist a submission receipt for ${turn.traceId}`);
          });
          usageWrites.push(write);
        };
      };

      let finalPrompt = prepared.text;
      if (prepared.multipart && multipartStages && multipartTransactionId && multipartFinalPrompt) {
        for (let index = 0; index < multipartStages.length; index += 1) {
          const stage = multipartStages[index]!;
          // Each acknowledgement can replace the picker controls. Establish a fresh model/effort
          // proof for the next physical submission, retaining family selection and usage evidence.
          if (index > 0) mode = await this.runStage(
            turn.traceId, `multipart_stage_${index + 1}_effort_selection`,
            browserStageTimeouts.effortSelection, selectStagingMode,
          );
          let stageBaseline = await this.captureSubmissionBaseline(page, stage.text);
          await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_attachment`,
            browserStageTimeouts.promptAttachment,
            (stageSignal) => this.attachPrompt(
              page,
              stage.text,
              false,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
            ),
            chatGptSuspensionClock,
            true,
          );
          await diagnostics.capture(page, `multipart-stage-${index + 1}-attachment-complete`);
          const recordStageUsage = await usageSubmission();
          const evidence = await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_send`,
            browserStageTimeouts.multipartStageSend,
            (stageSignal) => this.sendAttachedPrompt(
              page,
              stageBaseline,
              checkpoint => diagnostics.capture(page, `multipart-${index + 1}-${checkpoint}`),
              turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal,
              undefined,
              { onSubmitted: recordStageUsage, onSendActivated: async () => {
                await this.assertSelectedEffort(page, mode);
                submissionRejection.begin(page);
              } },
              undefined,
              launcherObservationRecovery
                ? async (...args) => {
                  const recovered = await recoverSubmissionObservation(...args);
                  stageBaseline = recovered.baseline;
                  return recovered;
                }
                : undefined,
            ),
          );
          console.info(
            `[chatgpt-web] browser turn ${turn.traceId} multipart part ${index + 1}/${prepared.multipart.parts.length} submission accepted evidence=${evidence}`,
          );
          await this.runStage(
            turn.traceId,
            `multipart_stage_${index + 1}_acknowledgement`,
            browserStageTimeouts.multipartStageAcknowledgement,
            async (stageSignal) => {
              const acknowledgementSignal = turn.abortSignal
                ? AbortSignal.any([stageSignal, turn.abortSignal])
                : stageSignal;
              const responseTurn = await this.waitForNewAssistantTurn(
                page,
                stageBaseline,
                deadline,
                acknowledgementSignal,
                // A part still being ingested has produced no MCP activity, so there is no progress
                // to consult here; the dedicated acknowledgement stage owns this wait.
                undefined,
                CHATGPT_MULTIPART_RESPONSE_DOM_GRACE_MS,
                undefined,
                launcherObservationRecovery
                  ? async (...args) => {
                    const recovered = await recoverAssistantObservation(...args);
                    stageBaseline = recovered.baseline;
                    return recovered;
                  }
                  : undefined,
              );
              await this.waitForMultipartAcknowledgement(
                page,
                responseTurn,
                stageBaseline,
                stage,
                deadline,
                acknowledgementSignal,
                turn.externalProgress,
              );
            },
            chatGptSuspensionClock,
          );
          const stageRejection = await submissionRejection.failure();
          if (stageRejection) throw stageRejection;
          await diagnostics.capture(page, `multipart-stage-${index + 1}-acknowledged`);
          await turn.onMultipartStageAcknowledged?.(index + 1);
        }
        // The first saved message changes / to /c/<id>. Re-prove the selection on
        // that conversation even when staging and final effort are identical.
        if (mode.effort !== requestedMode.effort || (mode.selection && mode.selection.url !== page.url())) {
          mode = await this.runStage(
            turn.traceId,
            "final_part_effort_selection",
            browserStageTimeouts.effortSelection,
            () => this.selectModelAndEffort(
              page,
              turn.modelId,
              requestedMode.effort,
              browserCapabilities,
              checkpoint => diagnostics.capture(page, `final-part-${checkpoint}`),
              trackUsage,
              turn.modelFamily,
            ),
          );
          await diagnostics.capture(page, "final-part-effort-selected");
        }
        finalPrompt = multipartFinalPrompt;
      }

      let submissionBaseline = await this.captureSubmissionBaseline(page, finalPrompt);
      let catalogRefreshAvailable = mode.localTools && !reuseConversation && !prepared.multipart;
      const connectorAttemptBudget: ChatGptConnectorAttemptBudget = { triggerAttempts: 0 };
      for (;;) {
        try {
          await this.runStage(
            turn.traceId,
            "prompt_attachment",
            browserStageTimeouts.promptAttachment,
            (stageSignal) => {
              const promptAbortSignal = turn.abortSignal
                ? AbortSignal.any([stageSignal, turn.abortSignal])
                : stageSignal;
              return this.attachPromptWithCompactionRetry(
                page,
                finalPrompt,
                mode.localTools,
                turn.compaction === true,
                submissionBaseline,
                checkpoint => diagnostics.capture(page, checkpoint),
                promptAbortSignal,
                catalogRefreshAvailable,
                connectorAttemptBudget,
                reuseConversation,
                mode.thinkEnabled,
              );
            },
            chatGptSuspensionClock,
            true,
          );
          break;
        } catch (error) {
          if (!(error instanceof ChatGptConnectorCatalogStaleError) || !catalogRefreshAvailable) throw error;
          catalogRefreshAvailable = false;
          await diagnostics.capture(page, "connector-catalog-stale");
          await this.runStage(
            turn.traceId,
            "connector_catalog_refresh",
            browserStageTimeouts.temporaryChatPreparation,
            async () => {
              await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
              await this.prepareChatSurface(
                page,
                checkpoint => diagnostics.capture(page, checkpoint),
                this.config.useSavedChats && !turn.compaction,
              );
              mode = await this.selectModelAndEffort(
                page,
                turn.modelId,
                turn.reasoning,
                turn.capabilities,
                checkpoint => diagnostics.capture(page, checkpoint),
                trackUsage,
                turn.modelFamily,
              );
              submissionBaseline = await this.captureSubmissionBaseline(page, finalPrompt);
            },
          );
          await diagnostics.capture(page, "connector-catalog-refreshed");
        }
      }
      await diagnostics.capture(page, "prompt-attachment-complete");
      await this.runStage(turn.traceId, "file_attachment", browserStageTimeouts.fileAttachment, () => (
        this.attachFiles(page, prepared)
      ));
      await diagnostics.capture(page, "file-attachment-complete");
      const completionTracker = new ChatGptCompletionTracker();
      const recordFinalUsage = await usageSubmission();
      const sendFinalPrompt = (abortSignal?: AbortSignal) => this.sendAttachedPrompt(
          page,
          submissionBaseline,
          checkpoint => diagnostics.capture(page, checkpoint),
          abortSignal,
          turn.externalProgress,
          { ...turn, onSubmitted: () => {
            recordFinalUsage?.();
            return turn.onSubmitted?.();
          }, onSendActivated: async () => {
            await this.assertSelectedEffort(page, mode);
            submissionRejection.begin(page);
            await turn.onSendActivated?.();
          } },
          completionTracker,
          launcherObservationRecovery
            ? async (...args) => {
              const recovered = await recoverSubmissionObservation(...args);
              submissionBaseline = recovered.baseline;
              return recovered;
            }
            : undefined,
          prepared.multipart ? undefined : {
            traceId: turn.traceId,
            activationTimeoutMs: browserStageTimeouts.send,
            confirmationTimeoutMs: CHATGPT_RESPONSE_DOM_GRACE_MS,
          },
      );
      // Keep the existing combined 180-second budget for multipart commits. Ordinary submissions
      // give their single activation and same-page confirmation independent stage signals.
      const finalSubmissionEvidence = prepared.multipart
        ? await this.runStage(turn.traceId, "send", browserStageTimeouts.multipartStageSend,
          stageSignal => sendFinalPrompt(turn.abortSignal ? AbortSignal.any([stageSignal, turn.abortSignal]) : stageSignal))
        : await sendFinalPrompt(turn.abortSignal);
      console.info(`[chatgpt-web] browser turn ${turn.traceId} submission accepted evidence=${finalSubmissionEvidence}`);
      await diagnostics.capture(page, "submission-accepted");
      let responseTurn = await this.waitForNewAssistantTurn(
        page,
        submissionBaseline,
        deadline,
        turn.abortSignal,
        turn.externalProgress,
        CHATGPT_RESPONSE_DOM_GRACE_MS,
        completionTracker,
        launcherObservationRecovery
          ? async (...args) => {
            const recovered = await recoverAssistantObservation(...args);
            submissionBaseline = recovered.baseline;
            return recovered;
          }
          : undefined,
      );
      await diagnostics.capture(page, "send-accepted");

      let lastHeartbeat = 0;
      let finalText = "";
      let sawRunning = false;
      let loggedCompletionWait = false;
      let capturedResponse = false;
      const sentAt = Date.now();
      const visibleTrace = new ChatGptVisibleTraceTracker();
      const markdownBuffer = new ChatGptMarkdownBuffer();
      const checkpointStream = turn.captureLunaCheckpoint
        ? new ChatGptLunaCheckpointStream()
        : undefined;
      const emitMarkdownDelta = (delta: string): void => {
        const visible = checkpointStream ? checkpointStream.push(delta) : delta;
        if (visible) turn.onTextDelta(visible);
      };
      const throwMarkdownConsistencyError = (error: unknown): never => {
        if (!(error instanceof ChatGptMarkdownConsistencyError)) throw error;
        if (error.diagnostic) {
          console.error(
            `[chatgpt-web] browser turn ${turn.traceId} Markdown conflict: ${JSON.stringify(error.diagnostic)}`,
          );
        }
        throw new ChatGptWebAdapterError(error.message, {
          status: 502,
          errorType: "server_error",
          code: "browser_stream_inconsistent",
          retryable: false,
        });
      };
      const domHealthTracker = new ChatGptTurnDomHealthTracker();
      const responseDomCache: ChatGptResponseDomCache = {};
      let consecutiveObservationRebinds = 0;
      let internalObservationFaults = 0;
      let observedThisIteration = false;
      let completionFenceRevision: number | undefined;
      const bodyErrorRecovery={reloaded:false};
      for (;;) {
        // The heartbeat is a consumer callback, so it stays outside the observation-fault region:
        // a defect in the caller must not be retried as though the page could not be read.
        if (Date.now() - lastHeartbeat >= 10_000) {
          turn.onHeartbeat?.();
          lastHeartbeat = Date.now();
        }
       try {
        observedThisIteration = false;
        if (page.isClosed()) {
          throw chatGptBrowserTabClosedError();
        }
        if (turn.abortSignal?.aborted) {
          const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
          if (await stop.isVisible().catch(() => false)) await stop.press("Enter").catch(() => {});
          throw new DOMException("ChatGPT web turn aborted", "AbortError");
        }
        if (deadline !== undefined && Date.now() >= deadline) {
          throw new Error("ChatGPT web turn timed out");
        }
        await throwIfChatGptSessionFailureAlert(page);
        if(await recoverChatGptInvalidConversationBody(page,bodyErrorRecovery))continue;
        await throwIfChatGptTerminalErrorAlert(responseTurn.locator);

        if (mode.localTools && await resolveChatGptToolConfirmation(
          page,
          this.config.appName,
          this.config.autoApproveToolCalls,
          turn.abortSignal,
          CHATGPT_TOOL_CONFIRMATION_TIMEOUT_MS,
          () => diagnostics.capture(page, "tool-confirmation-visible"),
          this.config.browserHost === "launcher",
        )) {
          internalObservationFaults = 0;
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }

        let snapshot: ChatGptResponseDomSnapshot;
        try {
          snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache, responseTurn.identity);
          if (submissionBaseline.pendingUserRekeySince !== undefined) {
            const state = await this.submissionDomState(page, submissionBaseline.domCache, turn.abortSignal);
            if (!await this.rememberSubmittedUserIdentity(page, submissionBaseline, state, turn.abortSignal)) {
              await new Promise(resolveSleep => setTimeout(resolveSleep, 100));
              continue;
            }
          }
          if (!snapshot.responsePresent) {
            const rebound = await withChatGptBrowserObservationTimeout(
              this.reconcileAssistantTurnBinding(
                page,
                submissionBaseline,
                responseTurn,
                turn.abortSignal,
              ),
            );
            if (rebound.identity !== responseTurn.identity) {
              responseTurn = rebound;
              responseDomCache.key = undefined;
              responseDomCache.snapshot = undefined;
              snapshot = await this.responseDomSnapshot(responseTurn.locator, responseDomCache, responseTurn.identity);
            }
          }
        } catch (error) {
            if (!(error instanceof ChatGptBrowserObservationTimeoutError) || !launcherSurfaceId) throw error;
            consecutiveObservationRebinds += 1;
            if (consecutiveObservationRebinds > MAX_CHATGPT_BROWSER_PAGE_REBINDS) {
              throw new Error(
                `ChatGPT browser DOM remained unresponsive after ${MAX_CHATGPT_BROWSER_PAGE_REBINDS} same-page rebinds`,
                { cause: error },
              );
            }
            await rebindLauncherPage(consecutiveObservationRebinds, error, turn.abortSignal);
            submissionBaseline = {
              ...submissionBaseline,
              userTurns: page.locator(CHATGPT_USER_TURN_SELECTOR),
              responseTurns: page.locator(CHATGPT_ASSISTANT_TURN_SELECTOR),
              domCache: {},
            };
            responseTurn = {
              ...responseTurn,
              locator: page.locator(chatGptAssistantTurnSelector(responseTurn.identity)),
            };
            responseDomCache.key = undefined;
            responseDomCache.snapshot = undefined;
            await diagnostics.capture(page, "response-page-rebound");
            continue;
        }
        if (snapshot.stoppedThinkingVisible) throw chatGptStoppedThinkingError();
        if (snapshot.responsePresent) consecutiveObservationRebinds = 0;
        // The page was read successfully, so the fault budget is genuinely consecutive even when
        // this iteration goes on to `continue` for a rebind, confirmation, or liveness pause.
        internalObservationFaults = 0;
        observedThisIteration = true;
        // Liveness may postpone a verdict, never waive it: once activity goes stale the DOM alone
        // decides, so a tool call that never returns cannot hold a turn with no explicit deadline open forever.
        const externalProgressSnapshot = turn.externalProgress?.snapshot();
        if (turn.externalProgress
          && externalProgressSnapshot
          && completionTracker.needsToolBatchObservation(externalProgressSnapshot.lastToolBatchRevision)) {
          completionTracker.observeToolBatch(
            externalProgressSnapshot.lastToolBatchRevision,
            snapshot.visibleText,
          );
          await turn.externalProgress.acknowledgeToolBatch(externalProgressSnapshot.lastToolBatchRevision);
        }
        const externalProgressLive = chatGptExternalProgressSuppressesDomHealth(
          externalProgressSnapshot,
          Date.now(),
        );
        const externalToolCallsInFlight = chatGptExternalToolCallsAreInFlight(externalProgressSnapshot);
        if (!snapshot.responsePresent && externalProgressLive) {
          // Current-turn MCP activity proves that ChatGPT is still executing even if its renderer
          // temporarily cannot expose the response subtree. DOM remains authoritative for text and
          // completion; this only prevents a live turn from being misclassified as vanished.
          domHealthTracker.clearMissingResponse();
          await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
          continue;
        }
        const stop = page.locator(CHATGPT_STOP_BUTTON_SELECTOR).last();
        const running = await stop.isVisible().catch(() => false);
        if (running) sawRunning = true;
        if (snapshot.responsePresent) {
          if (!capturedResponse) {
            capturedResponse = true;
            await diagnostics.capture(page, "response-visible");
          }
          const textDelta = (() => {
            try {
              return markdownBuffer.observe(snapshot.markdownSegments);
            } catch (error) {
              return throwMarkdownConsistencyError(error);
            }
          })();
          for (const trace of visibleTrace.observe(snapshot.traceBlocks, snapshot.completionActionVisible)) {
            if (trace.kind === "commentary") turn.onCommentary?.(trace.text, trace.continuation === true);
            else turn.onReasoningSummary?.(trace.text, trace.continuation === true);
          }
          if (textDelta) emitMarkdownDelta(textDelta);
          const domError = domHealthTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            completionActionVisible: snapshot.completionActionVisible,
            externalProgressLive,
          });
          if (domError) throw new Error(domError);
          const completionReady = completionTracker.update({
            responsePresent: snapshot.responsePresent,
            running,
            currentText: snapshot.visibleText,
            currentHtml: snapshot.fullHtml,
            completionActionVisible: snapshot.completionActionVisible,
            externalToolCallsInFlight,
          });
          if (!completionReady) completionFenceRevision = undefined;
          if (completionReady) {
            if (turn.completionFence) {
              if (completionFenceRevision === undefined) {
                const revision = await turn.completionFence.begin();
                if (revision === undefined) {
                  await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                  continue;
                }
                completionFenceRevision = revision;
                // The fence revision is captured after this DOM projection. Force one fresh read
                // before commit so an MCP activity that just settled cannot disappear between a
                // stale cached completion and the broker's terminal decision.
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
              if (!await turn.completionFence.commit(completionFenceRevision)) {
                completionFenceRevision = undefined;
                responseDomCache.key = undefined;
                responseDomCache.snapshot = undefined;
                await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
                continue;
              }
            }
            if (snapshot.visibleText === "api_tool unavailable") {
              throw new Error("ChatGPT selected mode rejected the Codex Native MCP tool (api_tool unavailable)");
            }
            const final = (() => {
              try {
                return markdownBuffer.finish();
              } catch (error) {
                return throwMarkdownConsistencyError(error);
              }
            })();
            if (!final.markdown && snapshot.visibleText) {
              throw new Error("ChatGPT completed with visible text that could not be serialized as Markdown");
            }
            if (final.delta) emitMarkdownDelta(final.delta);
            if (checkpointStream) {
              const completed = checkpointStream.finishOptional(snapshot.visibleText);
              if (completed.visibleRemainder) turn.onTextDelta(completed.visibleRemainder);
              if (completed.captured) turn.onLunaCheckpoint!(completed.captured);
              else console.warn(`[chatgpt-web] browser turn ${turn.traceId} completed without a Luna rolling checkpoint; preserving full native history`);
              finalText = completed.answer;
            } else {
              finalText = final.markdown;
            }
            break;
          }
          if (!loggedCompletionWait && Date.now() - sentAt >= 60_000) {
            loggedCompletionWait = true;
            await diagnostics.capture(page, "response-stalled-60s");
            const diagnostic = await this.stalledTurnDiagnostic(page, responseTurn.locator).catch(error => JSON.stringify({
              diagnosticError: error instanceof Error ? error.message : String(error),
            }));
            console.warn(
              `[chatgpt-web] waiting for completed-turn evidence (running=${running}, sawRunning=${sawRunning}, textChars=${snapshot.visibleText.length}, completionActionVisible=${snapshot.completionActionVisible}, ui=${diagnostic})`,
            );
          }
        } else {
          const domError = domHealthTracker.update({
            responsePresent: false,
            running,
            currentText: "",
            completionActionVisible: false,
            externalProgressLive,
          });
          if (domError) throw new Error(domError);
        }
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
       } catch (error) {
        // Only a defect in this worker is retried here. Every deliberate signal — adapter errors,
        // aborts, closed tabs, DOM-health verdicts — still fails the turn immediately.
        // Retry only faults raised while reading the page. Once observation succeeded, a
        // TypeError belongs to a consumer - Markdown buffering, text/trace callbacks, checkpoint
        // capture - and retrying it would rerun an iteration whose side effects already happened.
        if (!(error instanceof TypeError) || observedThisIteration) throw error;
        internalObservationFaults += 1;
        if (internalObservationFaults > MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS) {
          throw new Error(
            `ChatGPT browser observation failed ${internalObservationFaults} times in a row: ${error.message}`,
            { cause: error },
          );
        }
        console.warn(
          `[chatgpt-web] browser turn ${turn.traceId} tolerated internal observation fault`
          + ` ${internalObservationFaults}/${MAX_CHATGPT_INTERNAL_OBSERVATION_FAULTS}: ${error.message}`,
        );
        await diagnostics.capture(page, "internal-observation-fault");
        responseDomCache.key = undefined;
        responseDomCache.snapshot = undefined;
        await new Promise(resolveSleep => setTimeout(resolveSleep, 250));
       }
      }

      const finalRejection = await submissionRejection.failure();
      if (finalRejection) throw finalRejection;
      if (this.context && this.config.browserHost === "managed-chrome") {
        const state = await this.context.storageState();
        atomicWriteFile(this.config.storageStatePath, `${JSON.stringify(state)}\n`);
      }
      await diagnostics.capture(page, "turn-completed");
      console.info(
        `[chatgpt-web] browser turn ${turn.traceId} completed`
        + ` (markdownChars=${finalText.length}, domFullScans=${responseDomCache.fullScans ?? 0}, domCacheHits=${responseDomCache.cacheHits ?? 0})`,
      );
      return finalText;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")
        && !(error instanceof ChatGptWebAdapterError && error.code === "client_cancelled")) {
        error = await submissionRejection.failure() ?? error;
      }
      if (error instanceof DOMException && error.name === "AbortError"
        && turn.abortSignal?.reason instanceof ChatGptCompactionHandoffAccepted) {
        console.info(`[chatgpt-web] browser turn ${turn.traceId} ended after accepted structured compaction handoff`);
        if (diagnosticPage && !diagnosticPage.isClosed()) {
          await diagnostics.capture(diagnosticPage, "compaction-handoff-accepted");
        }
        throw turn.abortSignal.reason;
      }
      console.error(
        `[chatgpt-web] browser turn ${turn.traceId} failed:`
        + ` ${redactChatGptUiDiagnostic(error instanceof Error ? error.message : String(error))}`,
      );
      if (diagnosticPage && !diagnosticPage.isClosed()) {
        await diagnostics.capture(diagnosticPage, "turn-failed", error);
      }
      throw error;
    } finally {
      submissionRejection.dispose();
      await Promise.all(usageWrites);
      prepared.release();
      if (turnConnection) {
        await turnConnection.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to release launcher browser connection for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      } else if (managedPage && !managedPage.isClosed()) {
        await managedPage.close().catch(error => {
          console.error(
            `[chatgpt-web] failed to close managed browser tab for ${turn.traceId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        });
      }
    }
  }
}
