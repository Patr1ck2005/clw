import {isChatGptWebModelSlug} from './upstream/src/chatgpt-web-models';

// The dedicated CLW entry must never spend Codex inference quota because a
// resumed task or a client default supplied a native model. No second proxy.
export async function guardWebRoute(req: Request): Promise<Response | undefined> {
  if (req.method !== 'POST') return;
  const route = new URL(req.url).pathname;
  const reject = (message: string) => Response.json({error:{type:'invalid_request_error',code:'clw_explicit_web_route_required',message}}, {status:400});
  if (route === '/v1/responses' || route === '/v1/responses/compact') {
    let body: unknown;
    try { body = await req.clone().json(); } catch { return; } // upstream owns malformed JSON errors
    const model = body && typeof body === 'object' ? (body as {model?:unknown}).model : undefined;
    if (typeof model !== 'string' || !isChatGptWebModelSlug(model))
      return reject('CLW Codex + Web requires an explicit chatgpt-web model. Select a Web model and resume the same task; no native model was called.');
  }
  if (route === '/v1/images/generations' || route === '/v1/images/edits')
    return reject('This Web-only entry does not automatically forward image generation to the paid native API. Use an explicitly selected image workflow. Local image viewing and attachments remain available.');
}
