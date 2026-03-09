/**
 * BullMQ Bun Compatibility Verification
 * Tests inline function processors (NOT sandboxed file-path processors).
 * See migration doc: Background Jobs Decision.
 */
import { Queue, Worker } from "bullmq";

const connection = { host: "localhost", port: 6379 };
const QUEUE_NAME = "bun-verify";

const queue = new Queue(QUEUE_NAME, { connection });

let completedCount = 0;
const EXPECTED_JOBS = 3;

const worker = new Worker(
	QUEUE_NAME,
	async (job) => {
		console.log(`  Processing: ${job.name} (id=${job.id})`, job.data);
		// Simulate work (like FFmpeg transcoding)
		await Bun.sleep(500);
		return { result: "done", processedBy: "bun" };
	},
	{ connection, concurrency: 2 },
);

worker.on("completed", (job, result) => {
	console.log(`  Completed: ${job.id}`, result);
	completedCount++;

	if (completedCount === EXPECTED_JOBS) {
		console.log(`\n  All ${EXPECTED_JOBS} jobs completed successfully.`);
		cleanup();
	}
});

worker.on("failed", (job, err) => {
	console.error(`  FAILED: ${job?.id}`, err.message);
	cleanup(1);
});

// Timeout failsafe
const timeout = setTimeout(() => {
	console.error(`\n  TIMEOUT: Only ${completedCount}/${EXPECTED_JOBS} jobs completed in 15s.`);
	cleanup(1);
}, 15000);

async function cleanup(exitCode = 0) {
	clearTimeout(timeout);
	await worker.close();
	await queue.obliterate({ force: true });
	await queue.close();
	process.exit(exitCode);
}

// Queue the test jobs
console.log("BullMQ Bun Verification");
console.log("=======================");
console.log(`  Queue: ${QUEUE_NAME}`);
console.log(`  Concurrency: 2`);
console.log(`  Jobs: ${EXPECTED_JOBS}`);
console.log("");

await queue.add("transcode-video", { file: "video.mp4", resolution: "1080p" });
await queue.add("process-audio", { file: "audio.mp3", bitrate: "192k" });
await queue.add("generate-thumbnail", { file: "thumb.jpg", size: "256x256" });
