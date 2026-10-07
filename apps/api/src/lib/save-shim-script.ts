// SPDX-License-Identifier: Apache-2.0
/**
 * The save shim — the script Anthers serves INSIDE the build's frame, which hooks the
 * engine's persistent-filesystem flushes and carries save bytes over postMessage to
 * the parent page. This module builds that script as a string; the delivery route
 * injects it into served HTML entries (the playlist-rewrite precedent: content shaped
 * at the checked endpoint, never stored that way).
 *
 * 🚨 **The shim never speaks to Anthers.** No fetch, no cookie, no credential — it has
 * two capabilities and exactly two: read/write the frame's own IndexedDB (which is
 * the build's own per-origin storage, the floor), and postMessage to the parent that
 * framed it. The parent holds the session and makes every API call. A build that
 * strips the shim saves locally; a malicious build gains nothing it could not already
 * do, because the shim's authority on Anthers is zero.
 *
 * 🚨 **The restore path is deliberately engine-shaped.** Godot's web runtime mounts
 * IDBFS at `/userfs` and pulls it with `FS.syncfs(true)` at boot — so restoring means
 * writing the cloud blob into the frame's IndexedDB under the engine's OWN record
 * shape BEFORE the engine's pull runs, and the engine then restores itself with no
 * Godot-specific code here beyond the record format. The record shape (`/userfs` +
 * Emscripten's IDBFS store naming) is what the tests pin.
 *
 * The engine-agnostic limit, stated in the settled design: an engine that bypasses
 * IDBFS (own IndexedDB store, own transport) simply saves locally — the shim rides
 * the dominant convention, and nothing else.
 */

/**
 * Build the shim script for one play session.
 *
 * `runtime` names the engine family the save row carries ("godot" today), only so the
 * restore knows which IndexedDB record shape to write. The message vocabulary is
 * `save-shim.ts`'s contract, verbatim.
 */
export function saveShimScript(runtime: string): string {
	return `(function () {
	"use strict";
	var RUNTIME = ${JSON.stringify(runtime)};
	var PREFIX = "anthers-save:";

	function post(msg) {
		// The parent is the page that framed us; "*" is safe because the parent
		// validates us by frame source, and we hold no secrets to leak to a forger —
		// but the PARENT's origin is what we cannot know from inside, so the
		// validation burden is deliberately theirs.
		window.parent.postMessage(msg, "*");
	}

	function send(msg) { post(Object.assign({ source: "anthers-save-shim", runtime: RUNTIME }, msg)); }

	// ── The engine's own store ────────────────────────────────────────────────
	// Emscripten's IDBFS persists one database ("/deep/sky" naming varies by engine
	// build); Godot mounts at /userfs. We read/write the records the engine's own
	// syncfs loop uses, so a restored blob is indistinguishable from a local one.
	function openStore() {
		return new Promise(function (resolve, reject) {
			var req = indexedDB.open("/userfs");
			req.onupgradeneeded = function () {
				try { req.result.createObjectStore("FILE_DATA"); } catch (e) { /* exists */ }
			};
			req.onsuccess = function () { resolve(req.result); };
			req.onerror = function () { reject(req.error); };
		});
	}

	function storeAll(db, records) {
		return new Promise(function (resolve, reject) {
			var tx = db.transaction("FILE_DATA", "readwrite");
			var store = tx.objectStore("FILE_DATA");
			for (var key in records) store.put(records[key], key);
			tx.oncomplete = function () { resolve(); };
			tx.onerror = function () { reject(tx.error); };
		});
	}

	function readAll(db) {
		return new Promise(function (resolve, reject) {
			var tx = db.transaction("FILE_DATA", "readonly");
			var req = tx.objectStore("FILE_DATA").getAll();
			var keysReq = tx.objectStore("FILE_DATA").getAllKeys();
			var out = {};
			req.onsuccess = function () {
				keysReq.onsuccess = function () {
					for (var i = 0; i < req.result.length; i++) {
						var v = req.result[i];
						out[keysReq.result[i]] = v instanceof ArrayBuffer ? btoa(String.fromCharCode.apply(null, new Uint8Array(v))) : v;
					}
					resolve(out);
				};
			};
			tx.onerror = function () { reject(tx.error); };
		});
	}

	// ── Boot: ask for the cloud save; write it in before the engine pulls ────────
	var dbReady = openStore();
	send({ type: PREFIX + "load" });

	var loaded = false;
	window.addEventListener("message", function (event) {
		var d = event.data;
		if (!d || typeof d !== "object" || typeof d.type !== "string") return;
		if (!d.type.lastIndexOf) return;
		if (d.type.indexOf(PREFIX) !== 0) return;

		if (d.type === PREFIX + "loaded" && !loaded) {
			loaded = true;
			if (d.blob) {
				dbReady.then(function (db) {
					try {
						var records = JSON.parse(d.blob);
						return storeAll(db, records);
					} catch (e) { /* a save we cannot parse is ignored; local state stands */ }
				}).catch(function () {});
			}
		}
	});

	// ── Flushing: hook the engine's sync points and hand the bytes up ────────────
	// The engine calls FS.syncfs; Emscripten exposes the flush through its own
	// IDBFS.syncfs. Rather than monkey-patch internals that move between engine
	// releases, the shim flushes on a quiet cadence AND on teardown — the newest
	// complete snapshot wins, so cadence is a freshness dial, not a correctness one.
	function snapshot() {
		return dbReady.then(readAll).then(function (records) {
			if (Object.keys(records).length === 0) return;
			send({ type: PREFIX + "put", blob: JSON.stringify(records) });
		}).catch(function () {});
	}

	setInterval(snapshot, 30000);
	window.addEventListener("pagehide", snapshot);
	window.addEventListener("beforeunload", snapshot);
	// The engine's own exit path (Godot quits cleanly on request_quit).
	if (typeof GodotOS !== "undefined" && GodotOS && GodotOS.atexit) {
		GodotOS.atexit(function () { return snapshot().then(function () {})["catch"](function () {}); });
	}
})();`;
}
