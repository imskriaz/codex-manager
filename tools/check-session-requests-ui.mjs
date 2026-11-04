import assert from "node:assert/strict";
import path from "node:path";

export async function checkSessionRequestsUi(page, width, height, output, threadId, otherId) {
  const panel = page.locator(".codex-session-request");
  const inject = async request => {
    await page.evaluate(request => {
      window.__uiCodexRequests = [...(window.__uiCodexRequests || []).filter(item => item.id !== request.id), request];
      window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:codex-request", request } }));
    }, request);
    await panel.waitFor();
    const bounds = await panel.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width && bounds.y >= 0 && bounds.y + bounds.height <= height, "Session requests fit the viewport");
    assert.equal(await page.locator(".codex-request-backdrop").count(), 0, "Browser requests stay inside the session");
  };
  const question = { id: "question-ui", threadId, kind: "question", title: "Choose how to continue", questions: [
    { id: "layout", header: "Layout", question: "Which layout?", isSecret: false, options: [{ label: "Compact", description: "Use less space" }, { label: "Comfortable", description: "More space" }] },
    { id: "secret", header: "Secret", question: "Enter the secret value", isSecret: true },
    { id: "notes", header: "Notes", question: "Add instructions", isSecret: false }
  ] };
  await inject({ id: "permission-ui", threadId, kind: "permissions", title: "Allow requested permissions?", detail: 'Network access requested for this turn\n{"network":{"enabled":true}}', cwd: "D:/demo" });
  assert.ok((await panel.getByRole("button", { name: "Approve once", exact: true }).boundingBox()).height >= (width <= 760 ? 44 : 34));
  const approvalsBefore = await page.evaluate(() => window.__uiActions.filter(item => item.action === "respondCodexServerRequest").length);
  assert.equal(approvalsBefore, 0, "A displayed permission prompt never approves itself");
  await panel.getByRole("button", { name: "Decline", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  const declined = await page.evaluate(() => window.__uiActions.filter(item => item.action === "respondCodexServerRequest").at(-1));
  assert.equal(declined.payload.codexDecision, "decline");
  assert.equal(declined.payload.codexRequestId, "permission-ui");

  await inject(question);
  const send = panel.getByRole("button", { name: "Send answer", exact: true });
  assert.equal(await send.isDisabled(), true);
  const choice = panel.locator('select[name="choice-0"]');
  const custom = panel.locator('textarea[name="answer-0"]');
  await choice.selectOption("Compact");
  assert.equal(await custom.inputValue(), "", "A selected suggestion is not duplicated in the custom answer");
  await custom.fill("Custom compact answer");
  assert.equal(await choice.inputValue(), "", "Custom answers do not leave a different suggestion selected");
  const secret = panel.locator('input[name="answer-1"]');
  assert.equal(await secret.getAttribute("type"), "password");
  assert.equal(await secret.getAttribute("autocomplete"), "off");
  await secret.fill("  private fixture value  ");
  await panel.locator('textarea[name="answer-2"]').fill("Keep icons clear\nKeep quota inline");
  assert.equal(await send.isEnabled(), true);

  await page.evaluate(otherId => { history.pushState({}, "", "/workspace/" + otherId); dispatchEvent(new PopStateEvent("popstate")); }, otherId);
  await page.getByText("Codex is waiting for input in another session.", { exact: true }).waitFor();
  if (width <= 760) {
    await page.getByRole('button',{name:'Show sessions sidebar',exact:true}).click();
    await page.locator('.codex-request-background').waitFor({state:'hidden'});
    await page.getByRole('button',{name:'Show projects and sessions',exact:true}).click();
    await page.getByRole('button',{name:'Hide sessions sidebar',exact:true}).click();
    await page.locator('.codex-request-background').waitFor({state:'visible'});
  }
  await page.goBack();
  await panel.waitFor();
  assert.equal(await custom.inputValue(), "Custom compact answer", "Navigating between sessions retains the answer draft");
  assert.equal(await secret.inputValue(), "  private fixture value  ");
  await page.evaluate(() => { window.__failNextCodexReply = true; });
  await send.click();
  await panel.getByRole("alert").filter({ hasText: "Simulated response connection failure" }).waitFor();
  assert.equal(await custom.inputValue(), "Custom compact answer");
  assert.equal(await secret.inputValue(), "  private fixture value  ");
  assert.equal(await send.isEnabled(), true, "An explicit failure permits a reviewed retry");

  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:connection", connected: false } })));
  await page.getByText("The owning system is offline. You can edit your answer; reconnect before sending.", { exact: true }).waitFor();
  assert.equal(await send.isDisabled(), true);
  await custom.fill("Edited while offline");
  const beforeReconnect = await page.evaluate(() => window.__uiActions.filter(item => item.action === "respondCodexServerRequest").length);
  await page.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:connection", connected: true } }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:codex-requests", requests: window.__uiCodexRequests } }));
  });
  await send.waitFor();
  assert.equal(await custom.inputValue(), "Edited while offline");
  assert.equal(await page.evaluate(() => window.__uiActions.filter(item => item.action === "respondCodexServerRequest").length), beforeReconnect, "Reconnect never sends an answer automatically");
  await page.screenshot({ path: path.join(output, "session-questions-" + width + ".png") });
  await send.click();
  await panel.waitFor({ state: "hidden" });
  const response = await page.evaluate(() => window.__uiActions.filter(item => item.action === "respondCodexServerRequest").at(-1));
  assert.deepEqual(response.payload.codexAnswers, { layout: "Edited while offline", secret: "  private fixture value  ", notes: "Keep icons clear\nKeep quota inline" });
  assert.equal(response.payload.codexDecision, "approve");
  await page.evaluate(request => window.dispatchEvent(new MessageEvent("message", { data: { type: "dashboard:codex-request", request } })), question);
  assert.equal(await panel.count(), 0, "A late duplicate cannot reopen a resolved question");

  await inject({ id: "command-ui", threadId, kind: "command", title: "Approve command?", detail: "echo fixture", cwd: "D:/demo" });
  await panel.getByRole("button", { name: "Approve once", exact: true }).click();
  await panel.waitFor({ state: "hidden" });
  const approved = await page.evaluate(() => window.__uiActions.filter(item => item.action === "respondCodexServerRequest").at(-1));
  assert.equal(approved.payload.codexDecision, "approve");
  assert.equal(approved.payload.codexAnswers, undefined, "Command approval carries no question answers or persistent permission choice");
}
