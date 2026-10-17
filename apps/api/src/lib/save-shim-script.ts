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
	// 🚨 **Never hold a connection and never name a version.** The engine opens this
	// same database at its own fixed DB_VERSION (emscripten IDBFS: 21) and carries no
	// onblocked handler — a shim connection still open across that open, or a shim
	// database created at version 1 while the engine's open waits on its versionchange,
	// blocks forever, and the engine's boot pull never resolves: the build downloads
	// everything, instantiates, and never prints its banner (found live, 2026-10-17).
	// So every access is one unversioned open, one transaction, an immediate close;
	// a write may create the store, and a read against a never-mounted store finds
	// nothing to read and opens nothing but the db it then closes.
	function openStore(mayCreate) {
		return new Promise(function (resolve, reject) {
			var req = indexedDB.open("/userfs");
			req.onupgradeneeded = function () {
				if (mayCreate) {
					try { req.result.createObjectStore("FILE_DATA"); } catch (e) { /* exists */ }
				}
			};
			req.onsuccess = function () {
				var db = req.result;
				var empty = db.objectStoreNames.length === 0;
				if (empty && !mayCreate) {
					// The engine has never persisted here; nothing to read, and its
					// database's version is the engine's to set.
					db.close();
					resolve(null);
					return;
				}
				resolve(db);
			};
			req.onerror = function () { reject(req.error); };
		});
	}

	function storeAll(records) {
		return openStore(true).then(function (db) {
			if (db == null) return;
			return new Promise(function (resolve, reject) {
				var tx = db.transaction("FILE_DATA", "readwrite");
				var store = tx.objectStore("FILE_DATA");
				for (var key in records) {
					var rec = records[key];
					// 🚨 **The engine's own shapes, not the wire's.** The cloud blob carried
					// records through JSON, and JSON demotes the engine's shapes: IDBFS's
					// Date timestamps arrive as ISO strings (its reconcile calls
					// timestamp.getTime()) and its Uint8Array file bytes arrive as an
					// index-keyed object map. Rebuild each record the engine's storeEntry
					// and reconcile expect before it is put — else the record sits in the
					// store and the engine's pull neither copies it nor errs.
					if (!(rec.timestamp instanceof Date) && rec.timestamp != null) {
						rec.timestamp = new Date(rec.timestamp);
					}
					var contents = rec.contents;
					if (typeof contents === "string") {
						rec.contents = Uint8Array.from(atob(contents), function (c) { return c.charCodeAt(0); });
					} else if (contents != null && !ArrayBuffer.isView(contents)) {
						var bytes = new Uint8Array(Object.keys(contents).length);
						for (var i in contents) { bytes[i] = contents[i]; }
						rec.contents = bytes;
					}
					store.put(rec, key);
				}
				tx.oncomplete = function () { resolve(); };
				tx.onerror = function () { reject(tx.error); };
			}).then(function () { db.close(); }, function (e) { db.close(); throw e; });
		});
	}

	function readAll() {
		return openStore(false).then(function (db) {
			if (db == null) return {};
			return new Promise(function (resolve, reject) {
				var tx = db.transaction("FILE_DATA", "readonly");
				var req = tx.objectStore("FILE_DATA").getAll();
				var keysReq = tx.objectStore("FILE_DATA").getAllKeys();
				var out = {};
				req.onsuccess = function () {
					keysReq.onsuccess = function () {
						for (var i = 0; i < req.result.length; i++) {
							var v = req.result[i];
							// File bytes leave as base64, the form the JSON blob can carry and
							// the restore reads back to a Uint8Array; the engine's own record
							// shape (a mountpoint-keyed record with timestamp/mode/contents)
							// is otherwise preserved through the round trip.
							if (v && v.contents && (v.contents instanceof ArrayBuffer || v.contents instanceof Uint8Array)) {
								v.contents = btoa(String.fromCharCode.apply(null, new Uint8Array(v.contents)));
							}
							if (v && v.timestamp instanceof Date) {
								v.timestamp = v.timestamp.toISOString();
							}
							out[keysReq.result[i]] = v;
						}
						resolve(out);
					};
				};
				tx.onerror = function () { reject(tx.error); };
			}).then(function (out) { db.close(); return out; }, function (e) { db.close(); throw e; });
		});
	}

	// ── Boot: ask for the cloud save; write it in before the engine pulls ────────
	if (typeof console !== "undefined") console.log("SHIMDBG boot: sending load ask");
	send({ type: PREFIX + "load" });

	var loaded = false;
	window.addEventListener("message", function (event) {
		var d = event.data;
		if (typeof console !== "undefined") console.log("SHIMDBG msg: " + JSON.stringify(d));
		if (!d || typeof d !== "object" || typeof d.type !== "string") return;
		if (!d.type.lastIndexOf) return;
		if (d.type.indexOf(PREFIX) !== 0) return;

		if (d.type === PREFIX + "loaded" && !loaded) {
			loaded = true;
			if (d.blob) {
				try {
					var records = JSON.parse(d.blob);
					if (typeof console !== "undefined") console.log("SHIMDBG writing " + Object.keys(records).length + " records");
					storeAll(records).catch(function (e) { if (typeof console !== "undefined") console.log("SHIMDBG write err " + e); });
				} catch (e) {
					if (typeof console !== "undefined") console.log("SHIMDBG parse err " + e);
				}
			} else if (typeof console !== "undefined") {
				console.log("SHIMDBG loaded with null blob");
			}
		}
	});

	// ── Flushing: hook the engine's sync points and hand the bytes up ────────────
	// The engine calls FS.syncfs; Emscripten exposes the flush through its own
	// IDBFS.syncfs. Rather than monkey-patch internals that move between engine
	// releases, the shim flushes on a quiet cadence AND on teardown — the newest
	// complete snapshot wins, so cadence is a freshness dial, not a correctness one.
	function snapshot() {
		return readAll().then(function (records) {
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

	// ── The presence heartbeat ──────────────────────────────────────────────────
	// 🚨 The frame's input never reaches the parent's idle detector — keyboard and
	// pointer events do not cross the frame boundary — so a game being ACTIVELY played
	// looks idle to the parent after its idle timeout and stops earning. The shim is
	// the one trusted observer on the served side: it listens to the same interaction
	// family the parent's own detector does and reports ALIVE, throttled hard.
	//
	// The message carries no content — not which key, not where the pointer is, only
	// "input happened" — at most one per second, inside the channel that already
	// exists for exactly this class of message. Nothing here scores time: the parent
	// (which holds the session and the policy) decides what aliveness means.
	var lastBeat = 0;
	function beat() {
		var now = Date.now();
		if (now - lastBeat < 1000) return;
		lastBeat = now;
		send({ type: PREFIX + "alive" });
	}
	["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (type) {
		window.addEventListener(type, beat, { passive: true, capture: true });
	});
})();`;
}
