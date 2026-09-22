// SPDX-License-Identifier: Apache-2.0
/**
 * The web-game-build test harness page — dev-only, and self-contained on purpose.
 *
 * It previews the shape of the hosted-build delivery route before that feature ships (the
 * task *Host web game builds through the access-checked route*): point it at a directory of
 * build files, drop a Godot export in, and it plays the build in a sandboxed iframe whose
 * base URLs come from the API's `/api/dev/build/…` route rather than a Work. No Work, no
 * account, no upload — this is the fastest loop for checking a build's delivery behavior.
 *
 * This module exists so the page is served by BOTH dev front doors — `dev.ts` (HMR, what
 * `make dev` runs) and `serve.ts` (the static preview the browser suite drives) — without
 * either keeping a copy. The page is a plain HTML shell rather than a React route so the
 * production app, which has no dev-only page pattern today, gains no new surface.
 *
 * ⚠️ **The page carries no secrets and no client logic the real feature needs.** It fetches
 * the same delivery path with cookies, which only works because it is dev: production keeps
 * the session cookie off `anthers.run` and authorizes each file by a signed URL instead.
 * This page is *not* the player UI the feature ships with — that lives in the Work page.
 *
 * `api` is the inline script's only configurable input: it is the API origin the page calls,
 * resolved server-side so the shell carries no host-sniffing of its own. Two shapes matter:
 *   - a port or unnamed dev (127.0.0.1:3000) — the API is the same host, another port, and
 *     serve.ts announces that port in a meta tag;
 *   - portless (https://<worktree>.anthers.localhost) — the proxy routes by hostname, and the
 *     API is the sibling hostname `<worktree>.api.anthers.localhost`. Deriving it in the page
 *     keeps cookies sharing the `.anthers.localhost` parent and the CORS preflight clean.
 */

const PAGE_TITLE = "Web Build Test Harness";

/** The API origin the harness page calls, from the request it was served for. */
export function devBuildApiOrigin(req: Request, announcePort?: string): string {
	// Bun's router may hand the handler the listen origin in req.url rather than the proxied
	// host, so the proxy's hostname is read from the Host header first — that is the one the
	// browser asked for, the one the API call has to share a parent with for cookies to follow.
	const hostHeader = req.headers.get("host") ?? "";
	const host = hostHeader !== "" ? hostHeader : new URL(req.url).host;
	const h = host.split(":")[0];
	const protocol =
		req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
	if (h === "localhost" || h === "127.0.0.1") {
		const port = /^\d{2,5}$/.test(announcePort ?? "") ? announcePort : "8000";
		return `http://${h}:${port}`;
	}
	// Portless: <worktree>.anthers.localhost → <worktree>.api.anthers.localhost; the apex dev
	// site anthers.localhost → api.anthers.localhost.
	if (h === "anthers.localhost") return `${protocol}://api.anthers.localhost`;
	if (h.endsWith(".anthers.localhost")) {
		return `${protocol}://${h.replace(/\.anthers\.localhost$/, ".api.anthers.localhost")}`;
	}
	return "";
}

export function devBuildPage(apiOrigin: string): Response {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><title>${PAGE_TITLE}</title>
<style>
  body{font:14px/1.5 ui-sans-serif,system-ui,sans-serif;background:#0b0d10;color:#e6edf3;max-width:62rem;margin:0 auto;padding:1.25rem 1.25rem 3rem}
  h1{font-size:1.05rem;margin:0 0 .25rem}
  .dim{color:#9aa4b2}code{background:#161b22;padding:.08em .3em;border-radius:4px}
  .help{background:#11161d;border:1px solid #232830;border-radius:8px;padding:.8rem 1rem;margin:1rem 0;font-size:.85rem}
  .row{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem;margin:.9rem 0}
  button{background:#1f6feb;color:#fff;border:0;border-radius:6px;padding:.5rem .8rem;font:inherit;cursor:pointer}
  button.ghost{background:#161b22;color:#c9d1d9;border:1px solid #30363d}
  button:disabled{opacity:.45;cursor:default}
  table{border-collapse:collapse;width:100%;font-size:.82rem;margin:.4rem 0}
  td{padding:.2rem .8rem .2rem 0;vertical-align:top}
  td.k{color:#9aa4b2;width:9rem}
  td.m{font-family:ui-monospace,SFMono-Regular,monospace;word-break:break-all;font-size:.76rem}
  li{margin:.14rem 0;font-family:ui-monospace,monospace;font-size:.78rem}
  #frameWrap{display:none;margin-top:1rem;background:#000;border:1px solid #232830;border-radius:8px;overflow:hidden}
  #bar{display:flex;justify-content:flex-end;padding:.3rem;background:#161b22}
  #frame{width:100%;height:540px;border:0;display:block;background:#000}
</style>
</head>
<body>
  <h1>${PAGE_TITLE}</h1>
  <p class="dim">Dev-only preview of access-checked build delivery. See the task
    <em>Host web game builds through the access-checked route</em>.</p>
  <div class="help">
    Drop a web build into a directory the API serves, then choose it below. A Godot export at
    <code>/tmp/foo/</code> works: <code>mkdir -p builds/web-test/foo && cp /tmp/foo/* builds/web-test/foo/</code>,
    or point <code>WEB_TEST_BUILD_DIR</code> at a directory of builds. Every file the runtime
    requests — <code>.wasm</code>, <code>.pck</code>, the loader — resolves against the delivery
    route below, so nothing the build loads escapes the access check.
  </div>
  <div class="row">
    <span>Build</span>
    <select id="builds" class="ghost" style="background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:.4rem .6rem;font:inherit"></select>
    <button id="refresh" class="ghost">Refresh</button>
    <button id="play" disabled>Play in Browser</button>
    <button id="clearSaves" class="ghost" title="Clear this origin's storage">Clear Saves</button>
  </div>
  <div class="row dim" id="status">Loading available builds…</div>
  <table>
    <tr><td class="k">Delivery URL</td><td class="m" id="deliveryUrl">—</td></tr>
    <tr><td class="k">API origin</td><td class="m" id="apiOrigin">—</td></tr>
  </table>
  <div class="help dim" style="margin-top:.6rem">
    A threaded (shared-array-buffer) build needs cross-origin isolation this harness does not
    provide; serve single-threaded builds. Saves are per this dev origin and shared by every
    build here — the production design isolates each Work on its own <code>anthers.run</code>
    subdomain instead.
  </div>
  <div id="frameWrap"><div id="bar"><button id="close" class="ghost">Close</button></div>
    <iframe id="frame" sandbox="allow-scripts allow-same-origin allow-popups" allowfullscreen></iframe></div>
<script>
// The API origin is resolved server-side (devBuildApiOrigin) and handed down, so the shell
// carries no host-sniffing of its own — portless and a port dev land in the same shape.
(function(){
  var api=${JSON.stringify(apiOrigin)};
  var sel=document.getElementById("builds"),refresh=document.getElementById("refresh"),
      play=document.getElementById("play"),frame=document.getElementById("frame"),
      frameWrap=document.getElementById("frameWrap"),status=document.getElementById("status"),
      deliveryUrl=document.getElementById("deliveryUrl"),apiOriginEl=document.getElementById("apiOrigin"),
      clearSaves=document.getElementById("clearSaves"),close=document.getElementById("close");
  function say(t){status.textContent=t} apiOriginEl.textContent=api||"—";
  function chosen(){return sel.value}
  function entry(id){return api+"/api/dev/build/"+id+"/index.html"}
  async function load(){
    say("Loading available builds…");
    try{
      var r=await fetch(api+"/api/dev/build",{credentials:"include"});
      var d=await r.json();
      sel.innerHTML="";
      if(!d.builds||!d.builds.length){say("No builds in "+(d.root||"builds/web-test")+". Drop one in and Refresh.");play.disabled=true;deliveryUrl.textContent="—";return}
      d.builds.forEach(function(b){var o=document.createElement("option");o.value=b;o.textContent=b;sel.appendChild(o)});
      play.disabled=false; current();
      say("Ready. Every file resolves against the delivery URL below.");
    }catch(e){say("Could not reach "+(api||"<the API>")+"/api/dev/build — is the dev API running?")}
  }
  function current(){var id=chosen(); deliveryUrl.textContent=id?entry(id):"—"}
  refresh.addEventListener("click",load);
  sel.addEventListener("change",current);
  play.addEventListener("click",function(){var id=chosen(); if(!id)return;
    frame.src=entry(id); frameWrap.style.display="block"; say("Playing "+id+" — every asset resolved against "+entry(id))});
  close.addEventListener("click",function(){frameWrap.style.display="none"; frame.src="about:blank"});
  clearSaves.addEventListener("click",async function(){try{if(window.caches){var ks=await caches.keys(); await Promise.all(ks.map(function(k){return caches.delete(k)}))}
    var done=function(){say("Cleared this origin's storage (cookies/local/indexedDB)")};
    if(indexedDB&&indexedDB.databases){var ds=await indexedDB.databases(); await Promise.all((ds||[]).map(function(info){return new Promise(function(res){ var rq=indexedDB.deleteDatabase(info.name); rq.onsuccess=rq.onerror=rq.onblocked=function(){res()}; }); }))}
    localStorage.clear();done()}catch(e){say("Clear failed: "+e.message)}});
  load();
})();
</script>
</body>
</html>`;
	return new Response(html, { headers: { "Content-Type": "text/html;charset=utf-8" } });
}
