import json
import logging
import os
import subprocess
import tempfile
import uuid

from celery import shared_task
from django.core.files.base import ContentFile
from django.core.files.storage import default_storage

logger = logging.getLogger(__name__)


# ─── Helpers ───


def _get_local_path(file_field):
    """Get a local filesystem path for a file field, downloading from storage if needed."""
    try:
        return file_field.path
    except NotImplementedError:
        # S3 or remote storage — download to temp file
        ext = os.path.splitext(file_field.name)[1]
        tmp = tempfile.NamedTemporaryFile(delete=False, suffix=ext)
        for chunk in file_field.chunks():
            tmp.write(chunk)
        tmp.close()
        return tmp.name


def _ffprobe(file_path):
    """Run ffprobe and return parsed JSON metadata."""
    cmd = [
        "ffprobe", "-v", "quiet", "-print_format", "json",
        "-show_format", "-show_streams", file_path,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    if result.returncode != 0:
        raise RuntimeError(f"ffprobe failed: {result.stderr}")
    return json.loads(result.stdout)


def _ffmpeg_hls(input_path, output_dir, resolution, bitrate, name):
    """Transcode to a single HLS variant."""
    playlist = os.path.join(output_dir, f"{name}.m3u8")
    segment_pattern = os.path.join(output_dir, f"{name}_%03d.ts")
    cmd = [
        "ffmpeg", "-i", input_path,
        "-vf", f"scale=-2:{resolution}",
        "-c:v", "libx264", "-preset", "fast", "-b:v", bitrate,
        "-c:a", "aac", "-b:a", "128k",
        "-hls_time", "6", "-hls_list_size", "0",
        "-hls_segment_filename", segment_pattern,
        "-f", "hls", playlist,
        "-y",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg HLS failed for {name}: {result.stderr[:500]}")
    return playlist


def _generate_master_playlist(output_dir, variants):
    """Generate an HLS master playlist referencing all variants."""
    lines = ["#EXTM3U"]
    for v in variants:
        lines.append(
            f'#EXT-X-STREAM-INF:BANDWIDTH={v["bandwidth"]},'
            f'RESOLUTION={v["width"]}x{v["height"]}'
        )
        lines.append(f'{v["name"]}.m3u8')
    master_path = os.path.join(output_dir, "master.m3u8")
    with open(master_path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return master_path


def _upload_hls_to_storage(output_dir, storage_prefix):
    """Upload all HLS files from output_dir to storage backend."""
    urls = {}
    for filename in os.listdir(output_dir):
        local_path = os.path.join(output_dir, filename)
        storage_key = f"{storage_prefix}/{filename}"
        with open(local_path, "rb") as f:
            saved = default_storage.save(storage_key, ContentFile(f.read()))
        urls[filename] = default_storage.url(saved)
    return urls


def _generate_thumbnail(input_path, position_seconds):
    """Generate a thumbnail from a video at the given position."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".jpg")
    tmp.close()
    cmd = [
        "ffmpeg", "-i", input_path,
        "-ss", str(position_seconds),
        "-vframes", "1",
        "-q:v", "2",
        tmp.name,
        "-y",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        os.unlink(tmp.name)
        return None
    return tmp.name


# ─── Video Transcoding ───


@shared_task(bind=True, max_retries=2)
def transcode_video(self, job_id):
    """Transcode an uploaded video to HLS with adaptive bitrate variants."""
    from .models import TranscodingJob

    job = TranscodingJob.objects.get(id=job_id)
    job.status = TranscodingJob.Status.PROCESSING
    job.progress = 0
    job.save(update_fields=["status", "progress"])

    local_path = None
    output_dir = None
    thumb_path = None

    try:
        post = job.post
        local_path = _get_local_path(post.video_file)

        # Probe source file
        probe = _ffprobe(local_path)
        video_stream = next(
            (s for s in probe.get("streams", []) if s["codec_type"] == "video"),
            None,
        )
        if not video_stream:
            raise RuntimeError("No video stream found in file")

        duration = float(probe["format"].get("duration", 0))
        source_height = int(video_stream.get("height", 0))
        source_width = int(video_stream.get("width", 0))

        # Update post duration
        if duration > 0:
            post.duration_seconds = int(duration)
            post.save(update_fields=["duration_seconds"])

        job.progress = 10
        job.save(update_fields=["progress"])

        # Determine variants based on source resolution
        variants = []
        if source_height >= 1080:
            variants.append({
                "name": "1080p", "height": 1080, "bitrate": "5000k",
                "bandwidth": 5000000, "width": 1920,
            })
        if source_height >= 720:
            variants.append({
                "name": "720p", "height": 720, "bitrate": "2500k",
                "bandwidth": 2500000, "width": 1280,
            })
        variants.append({
            "name": "480p", "height": 480, "bitrate": "1000k",
            "bandwidth": 1000000, "width": 854,
        })

        # Correct widths using source aspect ratio
        if source_height > 0:
            aspect = source_width / source_height
            for v in variants:
                v["width"] = int(round(v["height"] * aspect / 2) * 2)

        # Create temp output directory
        output_dir = tempfile.mkdtemp(prefix="hls_")

        # Transcode each variant
        progress_per_variant = 60 // len(variants)
        for i, v in enumerate(variants):
            _ffmpeg_hls(local_path, output_dir, v["height"], v["bitrate"], v["name"])
            job.progress = 10 + (i + 1) * progress_per_variant
            job.save(update_fields=["progress"])

        # Generate master playlist
        _generate_master_playlist(output_dir, variants)
        job.progress = 80
        job.save(update_fields=["progress"])

        # Upload to storage
        storage_prefix = f"videos/hls/{uuid.uuid4().hex}"
        urls = _upload_hls_to_storage(output_dir, storage_prefix)
        job.progress = 90
        job.save(update_fields=["progress"])

        # Auto-generate thumbnail if none set
        if not post.thumbnail:
            thumb_position = max(1, int(duration * 0.25))
            thumb_path = _generate_thumbnail(local_path, thumb_position)
            if thumb_path:
                with open(thumb_path, "rb") as f:
                    thumb_key = f"thumbnails/{uuid.uuid4().hex}.jpg"
                    post.thumbnail.save(thumb_key, ContentFile(f.read()), save=True)

        # Update job
        job.hls_manifest_url = urls.get("master.m3u8", "")
        job.status = TranscodingJob.Status.COMPLETED
        job.progress = 100
        job.save(update_fields=["hls_manifest_url", "status", "progress"])

    except Exception as exc:
        logger.exception("Video transcoding failed for job %s", job_id)
        job.status = TranscodingJob.Status.FAILED
        job.error_message = str(exc)[:1000]
        job.save(update_fields=["status", "error_message"])
        raise self.retry(exc=exc, countdown=60)
    finally:
        # Clean up temp files
        if local_path and local_path.startswith(tempfile.gettempdir()):
            try:
                os.unlink(local_path)
            except OSError:
                pass
        if thumb_path:
            try:
                os.unlink(thumb_path)
            except OSError:
                pass
        if output_dir:
            import shutil
            try:
                shutil.rmtree(output_dir)
            except OSError:
                pass


# ─── Audio Processing ───


@shared_task(bind=True, max_retries=2)
def process_audio(self, job_id):
    """Process an uploaded audio file: normalize, convert to MP3, generate waveform."""
    from .models import TranscodingJob

    job = TranscodingJob.objects.get(id=job_id)
    job.status = TranscodingJob.Status.PROCESSING
    job.progress = 0
    job.save(update_fields=["status", "progress"])

    local_path = None
    output_path = None

    try:
        post = job.post
        local_path = _get_local_path(post.audio_file)

        # Probe for duration
        probe = _ffprobe(local_path)
        duration = float(probe["format"].get("duration", 0))
        if duration > 0:
            post.duration_seconds = int(duration)
            post.save(update_fields=["duration_seconds"])

        job.progress = 20
        job.save(update_fields=["progress"])

        # Normalize and convert to MP3
        output_path = tempfile.mktemp(suffix=".mp3")
        cmd = [
            "ffmpeg", "-i", local_path,
            "-af", "loudnorm",
            "-c:a", "libmp3lame", "-b:a", "192k",
            output_path,
            "-y",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if result.returncode != 0:
            raise RuntimeError(f"Audio normalization failed: {result.stderr[:500]}")

        job.progress = 60
        job.save(update_fields=["progress"])

        # Upload processed file
        storage_key = f"audio/processed/{uuid.uuid4().hex}.mp3"
        with open(output_path, "rb") as f:
            saved = default_storage.save(storage_key, ContentFile(f.read()))
        output_url = default_storage.url(saved)

        job.progress = 80
        job.save(update_fields=["progress"])

        # Generate waveform peaks (128 data points)
        waveform = _generate_waveform(local_path, 128)

        # Update job
        job.output_file_url = output_url
        job.waveform_data = waveform
        job.status = TranscodingJob.Status.COMPLETED
        job.progress = 100
        job.save(update_fields=[
            "output_file_url", "waveform_data", "status", "progress",
        ])

    except Exception as exc:
        logger.exception("Audio processing failed for job %s", job_id)
        job.status = TranscodingJob.Status.FAILED
        job.error_message = str(exc)[:1000]
        job.save(update_fields=["status", "error_message"])
        raise self.retry(exc=exc, countdown=60)
    finally:
        if local_path and local_path.startswith(tempfile.gettempdir()):
            try:
                os.unlink(local_path)
            except OSError:
                pass
        if output_path:
            try:
                os.unlink(output_path)
            except OSError:
                pass


def _generate_waveform(file_path, num_points=128):
    """Generate waveform peaks using FFmpeg audio analysis."""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-f", "lavfi",
        "-i", f"amovie={file_path},astats=metadata=1:reset=1",
        "-show_entries", "frame_tags=lavfi.astats.Overall.Peak_level",
        "-of", "csv=p=0",
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)

    if result.returncode != 0 or not result.stdout.strip():
        # Fallback: generate simple waveform via volume detection
        return _generate_waveform_fallback(file_path, num_points)

    # Parse peak levels and downsample to num_points
    raw_peaks = []
    for line in result.stdout.strip().split("\n"):
        try:
            val = float(line.strip())
            # Convert from dB to linear (0-1 range)
            linear = min(1.0, max(0.0, 10 ** (val / 20)))
            raw_peaks.append(linear)
        except (ValueError, OverflowError):
            continue

    if not raw_peaks:
        return [0.5] * num_points

    # Downsample to requested number of points
    return _downsample_peaks(raw_peaks, num_points)


def _generate_waveform_fallback(file_path, num_points):
    """Fallback waveform generation using volumedetect per segment."""
    probe = _ffprobe(file_path)
    duration = float(probe["format"].get("duration", 1))
    segment_duration = duration / num_points

    peaks = []
    for i in range(num_points):
        start = i * segment_duration
        cmd = [
            "ffmpeg", "-i", file_path,
            "-ss", str(start), "-t", str(segment_duration),
            "-af", "volumedetect",
            "-f", "null", "-",
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        # Parse max volume from stderr
        max_vol = -50.0
        for line in result.stderr.split("\n"):
            if "max_volume" in line:
                try:
                    max_vol = float(line.split("max_volume:")[1].strip().split()[0])
                except (ValueError, IndexError):
                    pass
        # Convert dB to 0-1 range (assume -50dB = silence, 0dB = max)
        linear = max(0.0, min(1.0, (max_vol + 50) / 50))
        peaks.append(round(linear, 3))

    return peaks


def _downsample_peaks(peaks, target_count):
    """Downsample a list of peaks to target_count via averaging."""
    if len(peaks) <= target_count:
        return [round(p, 3) for p in peaks]

    chunk_size = len(peaks) / target_count
    result = []
    for i in range(target_count):
        start = int(i * chunk_size)
        end = int((i + 1) * chunk_size)
        chunk = peaks[start:end]
        result.append(round(max(chunk) if chunk else 0, 3))
    return result
