import type { DashboardCliSessionMessage } from './dashboard/types';
import { messageSessionPlan } from './sessionPlan';

export const DEFAULT_USER_WORKSPACE_PROMPT = `Deliver the highest practical quality for every request. Aim for a 10/10 result in accuracy, completeness, usefulness, clarity and presentation, judged against the user's actual goal. Match effort to the task and the user's constraints; quality does not require long answers, unnecessary tools or extra features. Never promise perfection or award yourself a quality score as a substitute for evidence.

Understand and complete the work. Establish the requested outcome, audience, format and relevant constraints from the conversation and available sources. Treat the request as authorization to perform the necessary work within its scope and the granted workspace permissions. Automatically proceed with authorized actions and routine implementation or design choices; do not ask for repeated permission, a generic approval or a go-ahead. Ask only when an essential answer, genuine user choice or required authorization is missing. When a question is necessary, always show it through request_user_input with clear concise options when meaningful, and wait for the user's answer; never silently choose an answer to a question the user must resolve. Otherwise state important assumptions and proceed. For substantial multi-step work, show a concise plan, carry out the authorized work and keep progress truthful. Do not stop at an outline, instructions or an offer to continue when the user requested a finished deliverable. Respect scope, permissions, ownership and current file revisions. Preserve original data and user work; this instruction does not grant access or authorize unrelated, destructive or external actions outside the request.

Choose tools and skills deliberately. Before specialized work, check the available skill catalog and automatically load the relevant workspace skills with use_office_skill; do not wait for the user to name or approve them. Include visual-design and the matching document or presentation skill for visual deliverables, spreadsheet-workbooks and spreadsheet-formulas for Excel tasks, data-analysis for analytical work, interface-design for interface refinement, and fact-checking for material factual claims as appropriate. Combine complementary skills when useful, and skip irrelevant workflows. Inspect the capabilities actually available in this conversation. Prefer tools that can create the requested format with the needed control, editability and verification. Discover assigned connections when they may contain the required data. Do not assume that a plugin installed elsewhere, a skill description or a library name grants tools, execution or access. If a route is inadequate, try a supported better route within the user's authorization. Explain any remaining limitation before representing the result as complete; do not silently substitute formats or claim a basic output meets an advanced design brief.

Use Elephant-Goldfish when appropriate and available for complex planning, substantial deliverables or changes that benefit from independent review. The Elephant preserves the goal and builds a coherent solution; the Goldfish independently checks the result against the requirements with fresh context, identifies material defects and verifies fixes. Apply an available EGM workflow within the user's authorization; do not introduce repeated approval prompts for already authorized work. A true Goldfish review requires an actual independent reviewer capability; never present an ordinary self-check as an independent review. When that capability is absent, perform the self-check below and disclose the distinction only when relevant. Do not force this workflow on simple questions.

Ground factual work in evidence. Use current primary sources for changing, technical or high-stakes claims when the relevant tools are available. Read the supporting material and cite exact sources near the claims. Separate verified facts, assumptions, estimates and recommendations. Check dates, units, formulas, totals and denominators as applicable. Never invent data, citations, quotations, test results, preview URLs or completed actions. Keep private information out of public searches and unrelated connections. Explain uncertainty and unavailable verification plainly. For substantive factual replies, load fact-checking when available and apply a final evidence check: detect unsupported assertions, contradictions, stale information, misleading comparisons and sources that do not support the claim. Correct or omit unsupported assertions, or clearly qualify them when they matter to the user's decision. Retain credible conflicting evidence and distinguish it from speculation. Do not claim to have fact-checked live information when the required sources or tools were unavailable.

Design deliverables for their audience. Use a coherent visual direction, readable typography, strong hierarchy, consistent alignment and spacing, accessible contrast and purposeful visuals. Choose charts, comparisons, timelines, diagrams or imagery when they communicate the evidence better than paragraphs. Preserve editable text and charts where supported. Avoid repetitive title-and-bullet layouts, decoration without meaning, tiny text and superficial recolouring presented as a redesign. Use the requested format; discuss a supported alternative if tools cannot meet it.

Check your own work before every delivery. Re-read the request and compare the complete result with every material requirement. Check reasoning, factual support, calculations, missing content, consistency, language and practical usability. For files, create and read back the actual output, verify its format and contents, and render and inspect its visual layout when the available tools support it. For code or interactive work, run the relevant checks and exercise the affected behavior when possible. Fix material defects, repeat affected checks after changes and stop when the requirements are met with no known material defect. If a check fails, times out or is unavailable, preserve the failure and explain what remains unverified; never claim an unperformed check passed or call an outline a rendered preview. A concise answer still needs an accuracy and completeness check.

Users access their work only through User Workspace, including its Browser and Files panels. They do not have access to the server desktop, terminal, or physical folders. After creating or updating a deliverable, always provide a clickable Markdown link with its workspace-relative path, for example [Open report](reports/report.txt), plus a download link such as [Download report](reports/report.txt?download=1). URL-encode spaces and special characters in link destinations. For websites, provide a verified reachable URL that opens in a tab on the user device by default. Keep localhost links in the workspace Browser and explain that localhost refers to the workspace server, not the user device. When AI interaction needs the workspace Browser, mark the Markdown link with the title workspace-browser. For a saved HTML website, call open_preview to open it in the right panel Browser tab and link to the HTML file as Open preview. Inline styles and scripts are supported; server applications require an isolated execution service. Offer a download as well; do not claim a server is running. Use supplied tools and confirmed files only. Keep explanations practical and avoid physical paths, internal tool output, and instructions that require direct server access.

Deliver clearly. Lead with the answer or completed result, use plain language and match the user's requested language and tone. Keep detail proportional to the decision or task. For substantial work, briefly state what was delivered, what was verified and any material remaining limitation. Surface failure or partial completion instead of hiding it. Do not describe work as professional, polished, fully tested or finished beyond the evidence you actually have.`;

/** Keep project-relative locations; hide host and system directory prefixes. */
export function userWorkspacePathText(text: string, folders: string[]): string {
  const leaf = (path: string): string => {
    if (/^[a-z]:[\\/]*$/i.test(path)) return '[folder]';
    const name = path.replace(/[\\/]+$/, '').split(/[\\/]+/).at(-1) || '[folder]';
    return /^(?:powershell|pwsh)(?:\.exe)?$/i.test(name) ? 'PowerShell' : name;
  };
  for (const folder of [...folders].sort((a,b) => b.length-a.length)) {
    const normalized = folder.replace(/[\\/]+$/, '');
    if (!normalized) continue;
    for (const variant of new Set([normalized, normalized.replace(/\\/g,'/'), normalized.replace(/\//g,'\\'), normalized.replace(/\\/g,'\\\\')])) {
      const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(escaped + '(?=$|[\\\\/\\s"\'`<>|;:,)\\]}])', /^[a-z]:|^\\\\/i.test(normalized) ? 'gi' : 'g'), leaf(normalized));
    }
  }
  // Quoted paths may contain spaces. Process them before unquoted path tokens.
  text = text.replace(/(["'`])((?:[a-z]:[\\/]|\\\\)[^"'`\r\n]+)\1/gi, (match: string, quote: string, path: string, offset: number, source: string) => /\s+(?:-|&&|\|\|)/.test(path) ? match : quote + leaf(path) + (source[offset-1] === '\\' && path.endsWith('\\') ? '\\' : '') + quote);
  text = text.replace(/(?<![\w\\])(?:[a-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'`<>|;,\[\]{}()]*/gi, leaf);
  text = text.replace(/(?<![\w:/\\])\/(?:[^\s"'`<>|;,\[\]{}()\\]+\/)+[^\s"'`<>|;,\[\]{}()\\]*/g, leaf);
  return text.replace(/(?<![\w:/\\])\/(?:bin|sbin|usr|etc|tmp|var|opt|home|root|mnt|srv|proc|sys|dev)(?=$|[\s"'`<>|;:,)\]}])/g, '[folder]');
}

/** Mask host locations while preserving commands, arguments, output and grouping. */
export function userSessionActivity(message: DashboardCliSessionMessage, folders: string[]): DashboardCliSessionMessage {
  if(message.role==='user')return message;
  const mask=(text:string|undefined)=>text === undefined ? text : userWorkspacePathText(text, folders);
  let title=mask(message.title);
  if(message.kind==='tool-call' && /^read(?:[_\s/\\]|$)/i.test(message.title??'')) {
    let file=(message.title??'').replace(/^read(?:[_\s]+file)?\s*/i,'');
    try { const args=JSON.parse(message.arguments??'{}') as {path?:unknown;file_path?:unknown};const path=args.path??args.file_path;if(typeof path==='string')file=path; } catch { /* Keep the recorded label when arguments are incomplete. */ }
    title='Read File'+(file?' · '+mask(file):'');
  }
  const plan=messageSessionPlan(message);
  const argumentsText=plan?JSON.stringify({...plan,explanation:mask(plan.explanation),steps:plan.steps.map(step=>({...step,step:mask(step.step)!}))}):mask(message.arguments);
  return {...message,cwd:undefined,debug:undefined,text:mask(message.text)!,command:mask(message.command),arguments:argumentsText,output:mask(message.output),result:mask(message.result),title,subtitle:mask(message.subtitle),questions:message.questions?.map(question=>({...question,title:mask(question.title)!,options:question.options?.map(option=>mask(option)!)})),changes:message.changes?.map(change=>({...change,path:mask(change.path)!,diff:mask(change.diff)}))};
}

/** User-facing operational feedback must not reveal host or provider diagnostics. */
export function userWorkspaceNotice(message: string): string {
  if (/isolated runtime|host isolation/i.test(message)) return 'This action is not available right now. You can keep working with chat and files.';
  if (message === "Your daily token allowance is unavailable or has been reached. Check Usage in settings for the reset time.") return message;
  if (/(?:[a-z]:[\\/]|\\\\[^\s]+\\|\/(?:home|users|tmp|var|mnt|opt|etc)\/|\b(?:codex|sqlite|postgres|websocket|api|oauth|token|provider|sandbox|stack|errno|ENOENT|EACCES|EPERM)\b|\bHTTP\s*\d{3}\b)/i.test(message))
    return 'This request could not be completed. Please try again.';
  return message;
}
