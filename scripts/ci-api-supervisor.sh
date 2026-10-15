#!/usr/bin/env bash
# 🚨 CI-only API supervisor — the API webServer command runs this instead of
# `bun src/server.ts` directly. Local sessions keep their own command.
#
# Why it exists: on 2026-10-14 the `browser-media` job red-gated the merge queue on
# four pull requests whose every implicated spec passed in local isolation, and the
# failed runs' logs carried the mechanism. The API process dies mid-run under Bun
# 1.3.9's uWS segfault (a Bun bug the pipeline has known since 2026-08-08 — see
# `apps/web/playwright.config.ts`'s webServer comment), and Bun's crash handler
# **hangs about 81 seconds between printing the panic and the process actually
# dying**. The previous inline restart loop restarted after the death but printed
# its restart notice to stdout, which never appears in the captured job log —
# so the run's only evidence was a dead-API window (rotate-affecting failures:
# whatever spec's requests crossed the window) after four crash reports in one day.
#
# Three differences from the loop it replaces:
#
# - **Every act logs to stderr, one line each.** stderr is what Playwright's
#   [WebServer] capture demonstrably carries (the crash reports arrive on it); a
#   silent run is a healthy run, and a crash run reads as a timeline of acts, not a
#   forensic chase.
# - **A child that stays alive but stops answering `/health` is SIGKILLed** after a
#   short consecutive-miss window — Bun's crash-handler hang cut to seconds instead
#   of the ~90s hang-and-die. Before the first healthy answer the watchdog is
#   inert, so a slow startup is never judged; the webServer `url` gate owns
#   startup exactly as before.
# - **The child runs in its own process group when `setsid` exists**, so a wedge
#   SIGKILL reaps Bun's spawned transcode children along with it instead of
#   orphaning them. Without `setsid` the plain `bun` is used and only the child is
#   killed — degraded behavior, never a broken one.
#
# The restart budget is bounded: a genuinely un-startable API fails the job fast
# instead of spinning, and the budget is never spent by a healthy run.
set -u

cd "$(dirname "$0")/../apps/api"

PORT="${PORT:-8000}"
HEALTH_URL="http://localhost:${PORT}/health"
MAX_RESTARTS=6
WEDGED_POLLS=5  # consecutive unanswered health checks on a LIVE child (5 × (3s sleep + up to 2s curl) ≈ 15–25s before the SIGKILL)

restarts=0
child=0
own_group=0

kill_child() {
	[ "$child" = 0 ] && return 0
	if [ "$own_group" = 1 ]; then
		kill -9 -- "-${child}" 2>/dev/null
	fi
	kill -9 "$child" 2>/dev/null
}

# Playwright tears the run's process tree down at cleanup; the trap makes the same
# guarantee true in a local sandbox too.
trap 'kill_child; exit 0' TERM INT

health_answered() {
	curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

while [ "$restarts" -lt "$MAX_RESTARTS" ]; do
	if command -v setsid >/dev/null 2>&1; then
		setsid bun src/server.ts &
		own_group=1
	else
		bun src/server.ts &
		own_group=0
	fi
	child=$!
	echo "[api] supervisor: started (pid ${child}, start $((restarts + 1))/${MAX_RESTARTS})" >&2
	healthy=0
	misses=0
	wedge_killed=0
	beats=0
	while kill -0 "$child" 2>/dev/null; do
		sleep 3
		beats=$((beats + 1))
		if health_answered; then
			healthy=1
			misses=0
			# A heartbeat every 20 polls (~1 minute): the run's own timeline. A silent
			# suite window that outlives these beats carries its start and length in the
			# log itself — the 2026-10-14 stall gave 26 minutes of captured silence with
			# nothing to read between its first line and the ceiling, and this beat is
			# what makes the next one readable to the second.
			if [ $((beats % 20)) = 0 ]; then
				echo "[api] supervisor: t+$((beats * 3))s — child alive, ${HEALTH_URL} answering" >&2
			fi
		elif [ "$healthy" = 1 ]; then
			misses=$((misses + 1))
			if [ "$misses" -ge "$WEDGED_POLLS" ] && [ "$wedge_killed" = 0 ]; then
				wedge_killed=1
				echo "[api] supervisor: alive but stopped answering ${HEALTH_URL} for ${misses} polls — SIGKILL wedged child (Bun's crash-handler hang)" >&2
				kill_child
			fi
		fi
	done
	wait "$child" 2>/dev/null
	exit_code=$?
	restarts=$((restarts + 1))
	if [ "$restarts" -lt "$MAX_RESTARTS" ]; then
		if [ "$exit_code" = 137 ]; then
			echo "[api] supervisor: wedged child was SIGKILLed (137) — restarting" >&2
		else
			echo "[api] supervisor: process exited unexpectedly (status ${exit_code}) — restarting" >&2
		fi
	else
		echo "[api] supervisor: process exited (status ${exit_code})" >&2
	fi
	sleep 1
	child=0
done

echo "[api] supervisor: restart budget (${MAX_RESTARTS}) spent — giving up; the API is genuinely un-startable this run" >&2
exit 1