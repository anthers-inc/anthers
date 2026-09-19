// SPDX-License-Identifier: Apache-2.0
/**
 * The frame a `<video>` element is showing, as a JPEG file, for the Studio's *Use This Frame*.
 *
 * A creator chooses a video's thumbnail, uploaded or picked from a frame (Parker, 2026-09-18), and
 * picking one is drawing the paused picture into a canvas in the creator's own browser. That keeps
 * the whole video on hand for the choice without storing stills anywhere, and the result goes up
 * through the ordinary thumbnail upload, which scans it like any other.
 *
 * ⚠️ **It works only where the page's own script fed the video**, which is how hls.js plays it.
 * A browser playing HLS natively, as older iPhones do, taints the canvas, and `toBlob` then throws
 * a `SecurityError`, which the caller turns into advice to upload an image instead.
 */
export async function frameOf(video: HTMLVideoElement): Promise<File> {
	const canvas = document.createElement("canvas");
	canvas.width = video.videoWidth;
	canvas.height = video.videoHeight;
	const context = canvas.getContext("2d");
	if (!context) throw new Error("This browser has no canvas to draw the frame into.");
	context.drawImage(video, 0, 0, canvas.width, canvas.height);
	const blob = await new Promise<Blob | null>((resolve) =>
		canvas.toBlob(resolve, "image/jpeg", 0.9),
	);
	if (!blob) throw new Error("The frame could not be encoded.");
	return new File([blob], `frame-${Math.round(video.currentTime)}s.jpg`, { type: "image/jpeg" });
}
