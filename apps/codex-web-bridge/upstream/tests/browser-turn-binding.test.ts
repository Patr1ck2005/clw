import { expect, test } from "bun:test";
import { chromium, type Locator, type Page } from "playwright-core";
import { ChatGptBrowserWorker, ChatGptBrowserObservationTimeoutError } from "../src/adapters/chatgpt-web/browser-worker";
import { readFileSync } from "node:fs";

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("owned response reads the bound page through slow transport without Locator handles", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    worker.config = { browserHost: "launcher" };
    const group = (key: string, answer: string) => `<div data-turn-key="${key}">
      <div data-content-search-unit-key="${key}:user"><div data-user-message-bubble><div class="markdown">${"Long user input. ".repeat(4000)}</div></div><div class="turn-action-controls"><button>User copy</button></div></div>
      <div data-content-search-unit-key="${key}:assistant"><h4 data-conversation-role="assistant"></h4><div data-markdown-text-style="assistant-message"><p>${answer}</p></div></div>
      <div class="turn-action-controls"><button>Copy answer</button></div></div>`;
    await page.setContent(group("owned", "Bound answer.") + group("foreign", "Another task."));
    const evaluate = page.evaluate.bind(page);
    let pageReads = 0;
    (page as any).evaluate = async (...args: any[]) => {
      if (++pageReads === 1) await new Promise(resolve => setTimeout(resolve, 2200));
      return evaluate(...args);
    };
    const locator = { page: () => page, evaluate: () => { throw new Error("Locator handles are unavailable"); } };
    const cache = {};
    const snapshot = await worker.responseDomSnapshot(locator, cache, "group:assistant:owned");
    expect(snapshot.responsePresent).toBeTrue();
    expect(snapshot.visibleText).toBe("Bound answer.");
    expect(snapshot.completionActionVisible).toBeTrue();
    expect((await worker.responseDomSnapshot(locator, cache, "group:assistant:owned")).visibleText).toBe("Bound answer.");
    expect(cache).toMatchObject({ fullScans: 1, cacheHits: 1 });
    await page.locator('[data-turn-key="owned"]').evaluate(element => element.remove());
    const missing = await worker.responseDomSnapshot(locator, cache, "group:assistant:owned");
    expect(missing.responsePresent).toBeFalse();
    expect(missing.visibleText).toBe("");
    expect(missing.completionActionVisible).toBeFalse();
    await page.locator("body").evaluate((element, html) => { element.insertAdjacentHTML("beforeend", html); }, group("foreign", "Competing duplicate."));
    await expect(worker.responseDomSnapshot(locator, {}, "group:assistant:foreign")).rejects.toThrow("duplicate DOM nodes");
  } finally { await browser.close(); }
}, 15_000);

test("owned response observation timeouts remain recovery signals instead of missing DOM", async () => {
  const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
  worker.config = { browserHost: "launcher" };
  const error = new ChatGptBrowserObservationTimeoutError(30000);
  const page = { evaluate: async () => { throw error; }, isClosed: () => false };
  const locator = { page: () => page, evaluate: () => { throw new Error("unexpected Locator evaluation"); } };
  await expect(worker.responseDomSnapshot(locator, {}, "group:assistant:owned")).rejects.toBe(error);
});

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("rich user rekey preserves exact content across connector layout and fallback escapes", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = 'Read fixture.\n' + String.raw`{"quote":"say \"go\"", "code":"\`x\`", "path":"C:\\a\\b", "regex":"\\.", "literal":"<tag>*"}`;
    const escapeHtml = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const rich = (text: string, padding = '  ') => {
      const [head, ...rest] = text.split('\n');
      // Captured rich-text-user-turn: spans keep source; bare P text escapes
      // quotes/backticks/</*. Connector has its own layout newline in innerText.
      const tail = rest.join('\n').replace(/(?<=\\)"|[`<*]/g, '\\$&');
      return `<div data-user-message-bubble><div data-search-result-target><div class="rich-text-user-turn" data-markdown-text-tone="user-message"><p style="white-space:pre-wrap"><a><span data-prompt-link-href="app://fixture" style="display:block">Local-MCP</span></a><span>${padding}${escapeHtml(head!)}</span><br>${escapeHtml(tail)}</p></div></div></div>`;
    };
    for (const scenario of ['same', 'changed-text', 'changed-space', 'changed-slash', 'wrong-padding', 'missing-padding', 'competing-turn', 'old-group'] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      if (scenario !== 'missing-padding') baseline.submittedConnectorPadding = '  ';
      await page.locator('main').evaluate((e, html) => { e.innerHTML = html; }, `<div data-turn-key="optimistic">${rich(prompt)}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe('user_turn');
      const text = scenario === 'changed-text' ? prompt.replace('fixture', 'foreign')
        : scenario === 'changed-space' ? prompt.replace('say ', 'say  ')
        : scenario === 'changed-slash' ? prompt.replace('\\\\a', '\\a') : prompt;
      let html = `<div data-turn-key="saved">${rich(text, scenario === 'wrong-padding' ? ' ' : '  ')}</div>`;
      if (scenario === 'competing-turn') html += `<div data-turn-key="other">${rich(prompt)}</div>`;
      if (scenario === 'old-group') html += '<div data-turn-key="optimistic"></div>';
      await page.locator('main').evaluate((e, value) => { e.innerHTML = value; }, html);
      if (scenario === 'same') {
        expect(await worker.currentSubmissionEvidence(page, baseline)).toBe('user_turn');
        expect(baseline.acceptedUserIdentity).toBe('group:user:saved');
      } else await expect(worker.currentSubmissionEvidence(page, baseline)).rejects.toThrow(
        scenario === 'competing-turn' ? '2 new conversation turns' : 'changed the user turn');
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("generation acknowledgement still records the user while waiting for Activity", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    await page.setContent('<main></main><form data-chatgpt-composer><button aria-label="Stop" type="button">Stop</button></form>');
    const baseline = await worker.captureSubmissionBaseline(page, 'Read fixture.');
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe('generation_running');
    expect(baseline.acceptedUserIdentity).toBeUndefined();
    // Real failure: Send was acknowledged before the user mounted; the next
    // observation saw this rich bubble, then Activity replaced it for 60 seconds.
    const user = '<div data-user-message-bubble><div data-search-result-target><span data-prompt-link-href="app://fixture">Local-MCP-B</span> Read fixture.</div></div>';
    await page.locator('main').evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="accepted">${user}</div>`);
    const original = worker.submissionDomState.bind(worker);
    let observations = 0;
    worker.submissionDomState = async (...args: any[]) => {
      const state = await original(...args);
      if (++observations === 1) await page.locator('main').evaluate(node => {
        node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>';
      });
      return state;
    };
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
    expect(binding.identity).toBe('group:assistant:fallback-turn-0');
    expect(baseline.acceptedUserIdentity).toBe('group:user:accepted');
    await page.locator('main').evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="accepted">${user}<div data-content-search-unit-key="accepted:assistant"><h4 data-conversation-role="assistant"></h4><div data-markdown-text-style="assistant-message"><p>Done.</p></div></div><div class="turn-action-controls"><button>Copy</button></div></div>`);
    expect((await worker.reconcileAssistantTurnBinding(page, baseline, binding)).identity).toBe('group:assistant:accepted');
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("optimistic user identity rekeys only after the exact rich prompt is visible", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read fixture.\nReturn its contents.";
    const richPrompt = '<span data-prompt-link-href="app://test">Codex Native</span> Read fixture.<br>Return its contents.';
    const user = (content: string) => `<div data-user-message-bubble><div data-search-result-target>${content}</div></div>`;
    const page = await browser.newPage();
    await page.setContent('<main></main><form data-chatgpt-composer><button aria-label="Stop" type="button">Stop</button></form>');
    const baseline = await worker.captureSubmissionBaseline(page, prompt);
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; },
      `<div data-turn-key="optimistic">${user('Read fixture.<br>Return its contents.')}</div>`);
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(baseline.acceptedUserIdentity).toBe("group:user:optimistic");

    // The saved group mounts before its rich content. This observation must stay
    // pending, while the original submission remains confirmed and non-replayable.
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; },
      '<div data-turn-key="persisted"><div data-user-message-bubble></div></div>');
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(baseline.acceptedUserIdentity).toBe("group:user:optimistic");
    await page.locator("main").evaluate((node, html) => { node.innerHTML = html; },
      `<div data-turn-key="persisted">${user('<span data-prompt-link-href="app://test">Codex Native</span> Read fixture.')}</div>`);
    expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
    expect(baseline.acceptedUserIdentity).toBe("group:user:optimistic");
    await page.locator("main").evaluate((node, html) => {
      setTimeout(() => { node.innerHTML = html; }, 50);
    }, `<div data-turn-key="persisted">${user(richPrompt)}<span hidden data-chatgpt-agent-turn-start></span></div>`);
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2_000);
    expect(binding.identity).toBe("group:assistant:persisted");
    expect(baseline.acceptedUserIdentity).toBe("group:user:persisted");
    await page.close();

    const unverifiedPage = await browser.newPage();
    await unverifiedPage.setContent('<main></main><form data-chatgpt-composer><button aria-label="Stop" type="button">Stop</button></form>');
    const unverifiedBaseline = await worker.captureSubmissionBaseline(unverifiedPage, prompt);
    await unverifiedPage.locator("main").evaluate((node, html) => { node.innerHTML = html; },
      `<div data-turn-key="optimistic">${user('Read fixture.<br>Return its contents.')}</div>`);
    expect(await worker.currentSubmissionEvidence(unverifiedPage, unverifiedBaseline)).toBe("user_turn");
    await unverifiedPage.locator("main").evaluate(node => {
      node.innerHTML = '<div data-turn-key="persisted"><div data-user-message-bubble></div></div>';
    });
    expect(await worker.currentSubmissionEvidence(unverifiedPage, unverifiedBaseline)).toBe("user_turn");
    unverifiedBaseline.pendingUserRekeySince = Date.now() - 60_001;
    await unverifiedPage.locator("main").evaluate(node => {
      node.innerHTML = '<div data-turn-key="fallback"><span hidden data-chatgpt-agent-turn-start></span></div>';
    });
    await expect(worker.waitForNewAssistantTurn(unverifiedPage, unverifiedBaseline, Date.now() + 2_000))
      .rejects.toThrow("could not verify the rekeyed user turn");
    await unverifiedPage.close();

    for (const scenario of ["changed-prompt", "partial-mismatch", "competing-turn", "old-group-remains"] as const) {
      const foreignPage = await browser.newPage();
      await foreignPage.setContent('<main></main>');
      const foreignBaseline = await worker.captureSubmissionBaseline(foreignPage, prompt);
      await foreignPage.locator("main").evaluate((node, html) => { node.innerHTML = html; },
        `<div data-turn-key="optimistic">${user('Read fixture.<br>Return its contents.')}</div>`);
      expect(await worker.currentSubmissionEvidence(foreignPage, foreignBaseline)).toBe("user_turn");
      const content = scenario === "changed-prompt" ? "Different task."
        : scenario === "partial-mismatch" ? "Read fixture. X" : richPrompt;
      let html = `<div data-turn-key="persisted">${user(content)}</div>`;
      if (scenario === "competing-turn") html += '<div data-turn-key="foreign"><span hidden data-chatgpt-agent-turn-start></span></div>';
      if (scenario === "old-group-remains") html += '<div data-turn-key="optimistic"></div>';
      await foreignPage.locator("main").evaluate((node, next) => { node.innerHTML = next; }, html);
      await expect(worker.currentSubmissionEvidence(foreignPage, foreignBaseline))
        .rejects.toThrow("ChatGPT changed the user turn that acknowledged the submission");
      await foreignPage.close();
    }
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("activity tone and collapsed content invalidate the response cache", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(readFileSync(new URL("./fixtures/chatgpt-activity-summaries.html", import.meta.url), "utf8"));
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const cache = {};
    const turn = page.locator("#turn");
    const observe = () => worker.responseDomSnapshot(turn, cache);
    const first = await observe();
    expect(first.traceBlocks.filter((block: any) => block.kind === "status")).toHaveLength(10);
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
    const summary = page.locator('[data-markdown-text-style="assistant-message"]')
      .filter({ has: page.getByText("status 1", { exact: true }) });
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "primary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("commentary");
    await summary.evaluate(node => node.setAttribute("data-markdown-text-tone", "tertiary"));
    expect((await observe()).traceBlocks.find((block: any) => block.text === "status 1")?.kind).toBe("status");
    await summary.evaluate(node => { node.parentElement!.hidden = true; });
    const collapsed = await observe();
    expect(collapsed.traceBlocks.some((block: any) => block.kind === "status" || block.kind === "commentary")).toBeFalse();
    expect(collapsed.visibleText).toBe("answer 1");
    await summary.evaluate(node => { node.parentElement!.hidden = false; });
    expect((await observe()).traceBlocks).toEqual(first.traceBlocks);
  } finally { await browser.close(); }
}, 15_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("preserves the accepted user identity across Activity's temporary fallback group", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    const prompt = "Read first.txt.\n\nReturn its contents.";
    // Captured on the installed launcher: the user group appears at Send, disappears
    // during Activity, then returns with the same ID and a rich-text user bubble.
    const user = '<div data-user-message-bubble><div data-search-result-target><p><span data-prompt-link-href="app://test">Codex Native</span> Read first.txt.<br>Return its contents.</p></div></div>';
    const answer = '<div data-content-search-unit-key="fallback-turn-0:2:assistant"><div data-conversation-role="assistant"></div><div data-markdown-text-style="assistant-message"><p>FIRST fixture-marker</p></div></div><div class="turn-action-controls"><button>Copy</button></div>';
    for (const scenario of ["same-user", "rekeyed-user", "different-user", "competing-turn", "old-group-remains", "unfinished"] as const) {
      const page = await browser.newPage();
      await page.setContent('<main></main>');
      const baseline = await worker.captureSubmissionBaseline(page, prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, `<div data-turn-key="submitted">${user}</div>`);
      expect(await worker.currentSubmissionEvidence(page, baseline)).toBe("user_turn");
      await page.locator("main").evaluate(node => { node.innerHTML = '<div data-turn-key="fallback-turn-0"><span hidden data-chatgpt-agent-turn-start></span></div>'; });
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
      expect(binding.identity).toBe("group:assistant:fallback-turn-0");
      const key = scenario === "rekeyed-user" || scenario === "different-user" ? "persisted" : "submitted";
      const renderedUser = scenario === "different-user"
        ? '<div data-user-message-bubble><div data-search-result-target>Different task.</div></div>'
        : scenario === "rekeyed-user" ? user.replace("<br>", "<br><br>")
        : user;
      if (scenario === "rekeyed-user") {
        await page.locator("main").evaluate(node => {
          node.innerHTML = '<div data-turn-key="persisted"><div data-user-message-bubble></div><div data-conversation-role="assistant"></div></div>';
        });
        // The fallback binding stays untrusted while the persisted bubble has
        // no content target; a later observation can still rebind it.
        expect((await worker.reconcileAssistantTurnBinding(page, baseline, binding)).identity)
          .toBe("group:assistant:fallback-turn-0");
      }
      let replacement = `<div data-turn-key="${key}">${renderedUser}${scenario === "unfinished" ? '<span hidden data-chatgpt-agent-turn-start></span>' : answer}</div>`;
      if (scenario === "competing-turn") replacement += `<div data-turn-key="other">${user}</div>`;
      if (scenario === "old-group-remains") replacement += '<div data-turn-key="fallback-turn-0"></div>';
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, replacement);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "same-user" || scenario === "rekeyed-user") {
        expect((await result).identity).toBe(`group:assistant:${key}`);
      } else {
        await expect(result).rejects.toThrow(scenario === "different-user"
          ? "changed the user turn that acknowledged the submission" : "another user turn");
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 15_000);

// Execute the real observation/rebinding code against the reported renderer transition.
// No account, network requests, or model submissions are used.
test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("completed exchange rekeys only with the exact submitted prompt and no competing turn", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const worker = Object.create(ChatGptBrowserWorker.prototype) as {
      captureSubmissionBaseline(page: Page, submittedText?: string): Promise<unknown>;
      waitForNewAssistantTurn(page: Page, baseline: unknown, deadline: number): Promise<Binding>;
      reconcileAssistantTurnBinding(page: Page, baseline: unknown, binding: Binding): Promise<Binding>;
    };
    type Binding = { identity: string; locator: Locator; acceptedTurnIdentities: string[] };
    const prompt = "Explain one thing.\nKeep  two spaces.";
    const group = (key: string, text?: string, complete = false) => `<div data-turn-key="${key}">
      ${text === undefined ? "" : `<div data-user-message-bubble><div data-search-result-target style="white-space:pre-wrap">${text}</div><span aria-hidden="true">\u200b</span><button>Show more</button></div>`}
      <div data-content-search-unit-key="${key}:assistant"><div data-conversation-role="assistant"></div>
      <div data-markdown-text-style="assistant-message"><p>Answer.</p></div></div>
      ${complete ? '<div class="turn-action-controls"><button>Copy</button></div>' : ""}</div>`;
    for (const scenario of ["matching", "history", "foreign", "prefix-only", "changed-spaces", "changed-edges", "two-turns", "old-group-remains", "unfinished", "no-prompt", "same-key"] as const) {
      const page = await browser.newPage();
      const history = scenario === "history" ? group("earlier", prompt, true) : "";
      await page.setContent(`<main>${history}</main>`);
      const baseline = await worker.captureSubmissionBaseline(page, scenario === "no-prompt" ? undefined : prompt);
      await page.locator("main").evaluate((node, html) => { node.innerHTML = html; }, history + group("optimistic"));
      const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 5000);
      expect(binding.identity).toBe("group:assistant:optimistic");
      const text = scenario === "foreign" ? "Different task."
        : scenario === "prefix-only" ? prompt + " Another request."
        : scenario === "changed-spaces" ? prompt.replace("  ", " ")
        : scenario === "changed-edges" ? " " + prompt : prompt;
      let html = history + group(scenario === "same-key" ? "optimistic" : "persisted", text, scenario !== "unfinished");
      if (scenario === "two-turns") html += group("foreign", prompt, true);
      if (scenario === "old-group-remains") html += '<div data-turn-key="optimistic"><div data-user-message-bubble>Earlier</div></div>';
      await page.locator("main").evaluate((node, next) => { node.innerHTML = next; }, html);
      const result = worker.reconcileAssistantTurnBinding(page, baseline, binding);
      if (scenario === "matching" || scenario === "history" || scenario === "same-key") {
        const rebound = await result;
        expect(rebound.identity).toBe(`group:assistant:${scenario === "same-key" ? "optimistic" : "persisted"}`);
        expect(await rebound.locator.count()).toBe(1);
      } else {
        await expect(result).rejects.toThrow();
      }
      await page.close();
    }
  } finally { await browser.close(); }
}, 30_000);

test.skipIf(!process.env.CHATGPT_DOM_TEST_BROWSER)("binds captured Activity before an answer exists and recognizes uploaded native-button tiles", async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHATGPT_DOM_TEST_BROWSER, headless: true });
  try {
    const page = await browser.newPage();
    const worker = Object.create(ChatGptBrowserWorker.prototype) as any;
    await page.setContent('<main></main>');
    const baseline = await worker.captureSubmissionBaseline(page, "Prompt");
    const html = readFileSync(new URL("./fixtures/chatgpt-power-activity.html", import.meta.url), "utf8");
    await page.locator("main").evaluate((node, content) => { node.innerHTML = content; }, html);
    const binding = await worker.waitForNewAssistantTurn(page, baseline, Date.now() + 2000);
    expect(binding.identity).toBe("group:assistant:activity");
    expect((await worker.responseDomSnapshot(binding.locator)).traceBlocks.some((block: { kind: string }) => block.kind === "commentary")).toBeTrue();
    for (const tile of ['button', 'div role="button"']) {
      await page.setContent(`<form data-chatgpt-composer><div data-composer-markdown contenteditable="true" role="textbox" style="height:40px">Prompt</div>
        <input type="file" multiple><${tile} class="composer-attachment-surface" aria-label="codex-input-image-1.png">File</${tile.split(' ')[0]}>
        <button type="submit">Send</button></form>`);
      await worker.attachFiles(page, { images: [{ ref: "codex-input-image-1", imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==" }] });
      expect(await page.locator('input[type="file"]').evaluate(input => (input as HTMLInputElement).files?.[0]?.name)).toBe("codex-input-image-1.png");
    }
  } finally { await browser.close(); }
}, 15_000);
