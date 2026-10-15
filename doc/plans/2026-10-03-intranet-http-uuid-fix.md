# Intranet HTTP comment submission compatibility

## Observed failure

DSP-4 is accessed through `http://10.60.43.53:3100`. Its composer directly calls `crypto.randomUUID()` before POSTing a comment. This method is unavailable in ordinary insecure browser contexts. The composer catches the exception and restores the draft without displaying that exception, matching the user's unsent draft and the absence of a server comment. A browser console trace was unavailable; this remains a source-based diagnosis until the user retries.

## Change

Load `ui/public/dsp7-browser-uuid.js` before the application. If native randomUUID is unavailable, implement UUID v4 using the existing Web Crypto getRandomValues method. Do not replace a native implementation and do not fall back to Math.random. This supplies request IDs and does not grant approval or change authentication.

Source changes are in the personal Paperclip fork on dsp7/main. The runtime patch is restricted to Paperclip's ui-dist/index.html and the new script; no backend, database, Nginx or Tracker changes and no restart.

## Deployment evidence

- Served DSP-4 HTML contains the compatibility script before the module entry.
- Script HTTP 200, Content-Type text/javascript.
- Script SHA256: 6f8b9c0f08865d044dcc55669009adf923466b2c03c55c7ff271b6a916fe0758.
- Tracker HTTP 200.
- JavaScript syntax check passed. No tests or full frontend build were run. Browser submission and approval processing await the user's actual comment.

## Rollback / upgrade

Remote original index backup: /home/fg/paperclip/private/ui-index-before-http-uuid.html.
Restore it to /home/fg/paperclip/runtime/node_modules/@paperclipai/server/ui-dist/index.html to remove the patch. Carry the two source files forward when building the next fork release, or retire the patch if upstream supports HTTP request IDs. Hard refresh an already open page after deployment.
