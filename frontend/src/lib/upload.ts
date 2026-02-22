import { api } from "./api";

interface UploadUrlResponse {
  method: "presigned" | "direct";
  upload_url: string;
  storage_key: string | null;
}

interface DirectUploadResponse {
  storage_key: string;
  url: string;
}

/**
 * Upload a media file (video/audio) using presigned URL (S3) or direct upload (local dev).
 * Returns the storage key for the uploaded file.
 */
export async function uploadMediaFile(
  file: File,
  mediaType: "video" | "audio",
  onProgress?: (percent: number) => void,
): Promise<string> {
  // Step 1: Get upload URL
  const urlInfo = await api.post<UploadUrlResponse>(
    "/api/v1/content/media-upload/url/",
    { filename: file.name, media_type: mediaType },
  );

  if (urlInfo.method === "presigned" && urlInfo.storage_key) {
    // S3 presigned upload
    await xhrUpload(urlInfo.upload_url, file, "PUT", onProgress);
    return urlInfo.storage_key;
  } else {
    // Direct multipart upload (local dev)
    const formData = new FormData();
    formData.append("file", file);
    formData.append("media_type", mediaType);
    const result = await xhrUploadFormData<DirectUploadResponse>(
      urlInfo.upload_url,
      formData,
      onProgress,
    );
    return result.storage_key;
  }
}

function xhrUpload(
  url: string,
  file: File,
  method: string,
  onProgress?: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.send(file);
  });
}

function xhrUploadFormData<T>(
  url: string,
  formData: FormData,
  onProgress?: (percent: number) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    // Handle relative URLs
    const fullUrl = url.startsWith("/")
      ? `${(globalThis as any).__API_URL__ || "http://localhost:8000"}${url}`
      : url;
    xhr.open("POST", fullUrl);
    xhr.withCredentials = true;

    // Include CSRF token
    const csrfMatch = document.cookie.match(/csrftoken=([^;]+)/);
    if (csrfMatch) {
      xhr.setRequestHeader("X-CSRFToken", csrfMatch[1]);
    }

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(JSON.parse(xhr.responseText));
      } else {
        reject(new Error(`Upload failed with status ${xhr.status}`));
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.send(formData);
  });
}
