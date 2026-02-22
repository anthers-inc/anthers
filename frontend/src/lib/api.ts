// Base URL defaults to localhost:8000 for dev. Override via window.__API_URL__ if needed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BASE_URL: string = (globalThis as any).__API_URL__ || "http://localhost:8000";

function getCsrfToken(): string | null {
  const match = document.cookie.match(/csrftoken=([^;]+)/);
  return match ? match[1] : null;
}

export class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(status: number, data: unknown) {
    super(`API error ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { isFormData?: boolean },
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = {};

  if (!options?.isFormData) {
    headers["Content-Type"] = "application/json";
  }

  // Include CSRF token for mutating requests
  if (method !== "GET" && method !== "HEAD") {
    const csrf = getCsrfToken();
    if (csrf) {
      headers["X-CSRFToken"] = csrf;
    }
  }

  const response = await fetch(url, {
    method,
    headers,
    credentials: "include",
    body: body
      ? options?.isFormData
        ? (body as FormData)
        : JSON.stringify(body)
      : undefined,
  });

  // 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(response.status, data);
  }

  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
  upload: <T>(path: string, formData: FormData) =>
    request<T>("POST", path, formData, { isFormData: true }),
  uploadPatch: <T>(path: string, formData: FormData) =>
    request<T>("PATCH", path, formData, { isFormData: true }),
};

// ─── Types ───

export interface User {
  id: number;
  username: string;
  display_name: string;
  bio: string;
  is_creator: boolean;
  avatar: string | null;
  header_image: string | null;
  website_url: string;
  location: string;
}

export interface PublicUser extends User {
  follower_count: number;
  project_count: number;
  is_following: boolean;
  date_joined: string;
}

export interface Screenshot {
  id: number;
  image: string;
  caption: string;
  sort_order: number;
  created_at: string;
}

export interface Asset {
  id: number;
  project: number;
  file: string;
  filename: string;
  file_size: number;
  mime_type: string;
  platform: string;
  version: string;
  is_primary: boolean;
  created_at: string;
}

export interface Project {
  id: number;
  creator: string;
  creator_username: string;
  title: string;
  slug: string;
  description: string;
  short_description: string;
  media_type: "game" | "video" | "audio" | "text";
  tags: string[];
  is_published: boolean;
  pricing_type: "free" | "pwyw" | "paid";
  price: string | null;
  min_price: string | null;
  suggested_price: string | null;
  cover_image: string | null;
  embed_url: string;
  website_url: string;
  source_url: string;
  assets: Asset[];
  screenshots: Screenshot[];
  rating_average: number | null;
  rating_count: number;
  creator_has_stripe: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectListItem {
  id: number;
  creator: string;
  creator_username: string;
  title: string;
  slug: string;
  short_description: string;
  media_type: "game" | "video" | "audio" | "text";
  tags: string[];
  is_published: boolean;
  pricing_type: "free" | "pwyw" | "paid";
  price: string | null;
  min_price: string | null;
  suggested_price: string | null;
  cover_image: string | null;
  rating_average: number | null;
  rating_count: number;
  created_at: string;
  updated_at: string;
}

export interface TranscodingJob {
  id: number;
  post: number;
  media_type: "video" | "audio";
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  error_message: string;
  hls_manifest_url: string;
  output_file_url: string;
  waveform_data: number[] | null;
  created_at: string;
  updated_at: string;
}

export interface MediaUploadUrl {
  method: "presigned" | "direct";
  upload_url: string;
  storage_key: string | null;
}

export interface Post {
  id: number;
  creator: string;
  creator_username: string;
  creator_avatar: string | null;
  project: number | null;
  project_title: string | null;
  project_slug: string | null;
  title: string;
  body: string;
  body_html: string;
  content_type: "text" | "video" | "audio";
  video_file: string | null;
  audio_file: string | null;
  thumbnail: string | null;
  duration_seconds: number | null;
  is_premium: boolean;
  visibility: "public" | "subscribers_only" | "gated";
  is_published: boolean;
  estimated_read_minutes: number | null;
  transcoding_jobs: TranscodingJob[];
  created_at: string;
  updated_at: string;
}

export interface PostListItem {
  id: number;
  creator: string;
  creator_username: string;
  creator_avatar: string | null;
  project: number | null;
  project_title: string | null;
  project_slug: string | null;
  title: string;
  content_type: "text" | "video" | "audio";
  thumbnail: string | null;
  duration_seconds: number | null;
  is_premium: boolean;
  visibility: "public" | "subscribers_only" | "gated";
  is_published: boolean;
  estimated_read_minutes: number | null;
  latest_transcoding_status: { status: string; progress: number } | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: number;
  user: string;
  username: string;
  avatar: string | null;
  project: number | null;
  post: number | null;
  body: string;
  created_at: string;
}

export interface RatingAggregate {
  average: number | null;
  count: number;
  user_rating: number | null;
}

export interface PaginatedResponse<T> {
  count: number;
  next: string | null;
  previous: string | null;
  results: T[];
}

// ─── Payment Types ───

export interface StripeAccountStatus {
  stripe_account_id: string;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  onboarding_complete: boolean;
  created_at: string;
}

export interface CheckoutResponse {
  client_secret: string;
  amount: string;
  processing_fee: string;
  crf_fee: string;
  creator_earnings: string;
}

export interface PurchaseItem {
  id: number;
  project: number;
  project_title: string;
  project_slug: string;
  project_cover: string | null;
  amount: string;
  processing_fee: string;
  crf_fee: string;
  creator_earnings: string;
  status: string;
  created_at: string;
}

export interface OwnershipResponse {
  owns: boolean;
}
