// In production (behind reverse proxy), use relative URLs.
// In local dev (localhost), default to http://localhost:8000.
// Can always be overridden via window.__API_URL__.
const isLocalDev =
  typeof location !== "undefined" &&
  (location.hostname === "localhost" || location.hostname === "127.0.0.1");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const BASE_URL: string =
  (globalThis as any).__API_URL__ || (isLocalDev ? "http://localhost:8000" : "");

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
  atproto_did: string | null;
  atproto_handle: string;
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
  creator_id: number;
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
  view_count: number;
  download_count: number;
  creator_has_stripe: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProjectListItem {
  id: number;
  creator: string;
  creator_id: number;
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
  view_count: number;
  download_count: number;
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
  creator_id: number;
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
  access_granted?: boolean;
  created_at: string;
  updated_at: string;
}

export interface PostListItem {
  id: number;
  creator: string;
  creator_id: number;
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

// ─── Subscription Types ───

export type SubscriptionTier =
  | "free"
  | "root"
  | "sprout"
  | "petal"
  | "bloom";

export interface SubscriptionTierOption {
  tier: SubscriptionTier;
  name: string;
  price: string;
  creator_pool: string;
  boost_pool: string;
  content_hours: number | null;
  gate_access: boolean;
}

export interface AttentionSummary {
  hours_used: number;
  hours_cap: number | null;
  seconds_used: number;
  tier: SubscriptionTier;
  cycle_start: string | null;
}

export interface PoolDistributionItem {
  id: number;
  creator: number;
  creator_username: string;
  creator_display_name: string;
  billing_cycle: string;
  pool_amount: string;
  boost_amount: string;
  total_amount: string;
  attention_seconds: number;
  created_at: string;
}

export interface MyDistributionsResponse {
  distributions: PoolDistributionItem[];
  total_pool: string;
  total_boost: string;
  total: string;
}

export interface CreatorEarningsResponse {
  total_pool: string;
  total_boost: string;
  total: string;
  subscriber_count: number;
  cycle: string | null;
}

export interface BoostAllocation {
  id: number;
  creator: number;
  creator_username: string;
  creator_display_name: string;
  creator_avatar: string | null;
  amount: string;
  billing_cycle: string;
  is_locked: boolean;
  created_at: string;
  updated_at: string;
}

export interface BoostListResponse {
  allocations: BoostAllocation[];
  remaining: string;
  total_budget: string;
}

export interface ContentAccessResponse {
  access: boolean;
  reason: string;
  required_boost?: string;
  current_boost?: string;
}

export interface SubscriptionStatus {
  id?: number;
  tier: SubscriptionTier;
  tier_display: string;
  is_active: boolean;
  is_paid: boolean;
  has_boost_pool: boolean;
  has_gate_access: boolean;
  monthly_content_hours: number | null;
  creator_pool_amount: string;
  boost_pool_amount: string;
  current_period_start: string | null;
  current_period_end: string | null;
  canceled_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// ─── ATProto Types ───

export interface ATProtoAuthInitResponse {
  authorization_url: string;
}

// ─── Analytics / Integrations Types ───

export interface AnalyticsOverview {
  period_days: number;
  metrics: {
    total_events: number;
    total_views: number;
    total_plays: number;
    total_watches: number;
    total_reads: number;
    total_listens: number;
    total_duration_seconds: number;
    total_duration_hours: number;
    unique_viewers: number;
  };
  content: {
    published_projects: number;
    published_posts: number;
  };
  cross_publishing: {
    total_published: number;
    connected_platforms: string[];
  };
}

export interface ContentAnalyticsItem {
  type: "project" | "post";
  id: number;
  title: string;
  slug?: string;
  media_type?: string;
  content_type?: string;
  views: number;
  duration_seconds: number;
  duration_hours: number;
  unique_viewers: number;
}

export interface ContentAnalyticsResponse {
  period_days: number;
  content: ContentAnalyticsItem[];
}

export interface TimeseriesEntry {
  date: string;
  views: number;
  plays: number;
  watches: number;
  reads: number;
  listens: number;
  total_events: number;
  duration_seconds: number;
  unique_viewers: number;
}

export interface TimeseriesResponse {
  period_days: number;
  timeseries: TimeseriesEntry[];
}

export interface CrossPlatformComparison {
  period_days: number;
  anthers: {
    views: number;
    duration_seconds: number;
    unique_viewers: number;
  };
  platforms: Record<
    string,
    {
      views: number;
      likes: number;
      watch_time_seconds: number;
      revenue_cents: number;
      content_count: number;
      revenue_per_view: number;
    }
  >;
}

export interface PlatformConnectionItem {
  id: number;
  platform: string;
  platform_display: string;
  platform_user_id: string;
  platform_username: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CrossPublishResultItem {
  id: number;
  platform: string;
  platform_display: string;
  content_title: string | null;
  content_type: "project" | "post" | null;
  external_id: string;
  external_url: string;
  status: "pending" | "published" | "failed";
  error_message: string;
  published_at: string | null;
  created_at: string;
}

// ─── Jam Types ───

export interface GameJam {
  id: number;
  creator: number;
  creator_username: string;
  title: string;
  slug: string;
  description: string;
  theme: string | null;
  cover_image: string | null;
  start_at: string;
  end_at: string;
  voting_end_at: string;
  max_team_size: number;
  allow_late_submissions: boolean;
  status: "upcoming" | "active" | "voting" | "ended";
  entry_count: number;
  created_at: string;
  updated_at: string;
}

export interface GameJamListItem {
  id: number;
  creator_username: string;
  title: string;
  slug: string;
  cover_image: string | null;
  start_at: string;
  end_at: string;
  voting_end_at: string;
  status: "upcoming" | "active" | "voting" | "ended";
  entry_count: number;
  created_at: string;
}

export interface JamEntry {
  id: number;
  jam: number;
  project: number;
  project_title: string;
  project_slug: string;
  project_cover: string | null;
  submitted_by: number;
  submitted_by_username: string;
  average_score: number | null;
  vote_count: number;
  user_vote: number | null;
  created_at: string;
}

export interface JamEntryResult extends JamEntry {
  rank: number;
}

export interface JamResultsResponse {
  jam: GameJam;
  results: JamEntryResult[];
}

export interface CrossPublishInitRequest {
  platform: string;
  project_id?: number;
  post_id?: number;
}

// ─── CRF Types ───

export interface CRFSubsidyItem {
  id: number;
  billing_cycle: string;
  estimated_hosting_cost: string;
  creator_earnings: string;
  subsidy_amount: string;
  storage_bytes: number;
  project_count: number;
  post_count: number;
  created_at: string;
}

export interface CRFStatusResponse {
  crf_balance: string;
  subsidies: CRFSubsidyItem[];
}

export interface ATProtoClientMetadata {
  client_id: string;
  client_name: string;
  client_uri: string;
  redirect_uris: string[];
  scope: string;
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: string;
  application_type: string;
  dpop_bound_access_tokens: boolean;
}
