import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: { path?: string[] } | Promise<{ path?: string[] }> };
type JsonRecord = Record<string, unknown>;

const APIMART_BASE_URL = (process.env.APIMART_BASE_URL || "https://api.apib.ai/v1").replace(/\/+$/, "");
const TASK_POLL_TIMEOUT_MS = Number(process.env.APIMART_TASK_POLL_TIMEOUT_MS || 300000);
const TASK_POLL_INTERVAL_MS = Number(process.env.APIMART_TASK_POLL_INTERVAL_MS || 3000);

export async function GET(request: NextRequest, context: RouteContext) {
    return handleProxyRequest(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
    return handleProxyRequest(request, context);
}

export async function HEAD(request: NextRequest, context: RouteContext) {
    return handleProxyRequest(request, context);
}

async function handleProxyRequest(request: NextRequest, context: RouteContext) {
    const path = await requestPath(context);
    if (!process.env.APIMART_API_KEY?.trim()) return Response.json({ error: { message: "APIMART_API_KEY is not configured" } }, { status: 500 });

    if (request.method === "POST" && (path === "v1/images/generations" || path === "v1/images/edits")) return handleImageRequest(request, path);
    if (request.method === "POST" && path === "v1/videos") return handleVideoCreate(request);
    if (request.method === "GET" && /^v1\/videos\/[^/]+$/.test(path)) return handleVideoStatus(path.split("/").pop() || "");
    if (request.method === "GET" && /^v1\/videos\/[^/]+\/content$/.test(path)) return handleVideoContent(path.split("/")[2] || "");

    return forwardToApimart(request, path);
}

async function handleImageRequest(request: NextRequest, path: string) {
    const contentType = request.headers.get("content-type") || "";
    const targetPath = path.replace(/^v1\//, "");
    let response: Response;

    if (contentType.includes("application/json")) {
        const payload = normalizeImagePayload((await request.json()) as JsonRecord);
        response = await fetch(apimartUrl(targetPath), {
            method: "POST",
            headers: upstreamHeaders("application/json"),
            body: JSON.stringify(payload),
        });
    } else if (path === "v1/images/edits") {
        const payload = await imageEditFormToGenerationPayload(await request.formData());
        response = await fetch(apimartUrl("images/generations"), {
            method: "POST",
            headers: upstreamHeaders("application/json"),
            body: JSON.stringify(payload),
        });
    } else {
        response = await fetch(apimartUrl(targetPath), {
            method: "POST",
            headers: upstreamHeaders(contentType),
            body: await request.arrayBuffer(),
        });
    }

    const payload = await readJson(response);
    if (!response.ok) return Response.json(payload, { status: response.status });

    const taskId = extractTaskId(payload);
    if (!taskId) return Response.json(payload, { status: response.status });

    const taskPayload = await pollTask(taskId);
    const imageUrls = collectUrls(taskPayload, "image");
    if (!imageUrls.length) {
        return Response.json({ error: { message: "APIMart task completed without image URLs" }, task: taskPayload }, { status: 502 });
    }

    const data = await Promise.all(imageUrls.map(imageUrlToOpenAiData));
    return Response.json({ created: Math.floor(Date.now() / 1000), data });
}

async function handleVideoCreate(request: NextRequest) {
    const formData = await request.formData();
    const model = String(formData.get("model") || "sora-2");
    const size = String(formData.get("size") || "");
    const imageUrls = await formFilesToDataUrls(formData.getAll("input_reference[]"));
    const payload: JsonRecord = {
        model,
        prompt: String(formData.get("prompt") || ""),
        duration: normalizeDuration(formData.get("seconds")),
        resolution: normalizeResolution(formData.get("resolution_name")),
        aspect_ratio: normalizeAspectRatio(size),
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
    };

    const response = await fetch(apimartUrl("videos/generations"), {
        method: "POST",
        headers: upstreamHeaders("application/json"),
        body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    if (!response.ok) return Response.json(body, { status: response.status });

    const taskId = extractTaskId(body);
    if (!taskId) return Response.json(body, { status: response.status });
    return Response.json({ id: taskId, status: "queued" });
}

async function handleVideoStatus(taskId: string) {
    const taskPayload = await getTask(taskId);
    const task = taskData(taskPayload);
    const status = String(task.status || "").toLowerCase();
    if (isCompletedStatus(status)) return Response.json({ id: taskId, status: "completed" });
    if (isFailedStatus(status)) return Response.json({ id: taskId, status: "failed", error: { message: taskError(task) || "Video generation failed" } });
    return Response.json({ id: taskId, status: status || "running" });
}

async function handleVideoContent(taskId: string) {
    const taskPayload = await getTask(taskId);
    const task = taskData(taskPayload);
    const status = String(task.status || "").toLowerCase();
    if (!isCompletedStatus(status)) return Response.json({ id: taskId, status: status || "running" }, { status: 202 });

    const [videoUrl] = collectUrls(taskPayload, "video");
    if (!videoUrl) return Response.json({ error: { message: "APIMart task completed without a video URL" }, task: taskPayload }, { status: 502 });

    const response = await fetch(videoUrl);
    if (!response.ok) return Response.json({ error: { message: `Failed to download generated video: ${response.status}` } }, { status: 502 });
    return new Response(response.body, {
        status: response.status,
        headers: responseHeaders(response.headers),
    });
}

async function forwardToApimart(request: NextRequest, path: string) {
    const target = new URL(apimartUrl(path.replace(/^v1\//, "")));
    target.search = request.nextUrl.search;
    const method = request.method.toUpperCase();
    const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();
    const response = await fetch(target, {
        method,
        headers: upstreamHeaders(request.headers.get("content-type") || undefined, request.headers.get("accept") || undefined),
        body,
    });

    return new Response(method === "HEAD" ? null : response.body, {
        status: response.status,
        headers: responseHeaders(response.headers),
    });
}

async function requestPath(context: RouteContext) {
    const params = await context.params;
    return (params.path || []).join("/");
}

function apimartUrl(path: string) {
    return `${APIMART_BASE_URL}/${path.replace(/^\/+/, "")}`;
}

function upstreamHeaders(contentType?: string, accept?: string) {
    const headers = new Headers();
    headers.set("Authorization", `Bearer ${process.env.APIMART_API_KEY}`);
    if (contentType) headers.set("Content-Type", contentType);
    if (accept) headers.set("Accept", accept);
    return headers;
}

function responseHeaders(headers: Headers) {
    const result = new Headers();
    ["content-type", "cache-control", "etag", "last-modified"].forEach((key) => {
        const value = headers.get(key);
        if (value) result.set(key, value);
    });
    return result;
}

async function readJson(response: Response): Promise<JsonRecord> {
    const text = await response.text();
    if (!text) return {};
    try {
        return JSON.parse(text) as JsonRecord;
    } catch {
        return { error: { message: text } };
    }
}

function normalizeImagePayload(payload: JsonRecord) {
    const next = { ...payload };
    const size = typeof next.size === "string" ? next.size : "";
    if (/^\d+x\d+$/i.test(size)) next.size = pixelSizeToRatio(size);
    if (!next.resolution) next.resolution = qualityToResolution(typeof next.quality === "string" ? next.quality : "");
    delete next.response_format;
    delete next.output_format;
    return next;
}

async function imageEditFormToGenerationPayload(formData: FormData) {
    const imageUrls = await formValuesToDataUrls(formData.getAll("image"));
    const maskUrl = await formValueToDataUrl(formData.get("mask"));
    const payload = normalizeImagePayload({
        model: formString(formData, "model") || "gpt-image-2",
        prompt: formString(formData, "prompt"),
        n: normalizeImageCount(formData.get("n")),
        ...(formString(formData, "size") ? { size: formString(formData, "size") } : {}),
        ...(formString(formData, "quality") ? { quality: formString(formData, "quality") } : {}),
        ...(imageUrls.length ? { image_urls: imageUrls } : {}),
        ...(maskUrl ? { mask_url: maskUrl } : {}),
    });
    delete payload.response_format;
    if (!imageUrls.length) throw new Error("Image edit request is missing reference image files");
    return payload;
}

function pixelSizeToRatio(size: string) {
    const [width, height] = size.split("x").map((value) => Number(value));
    if (!width || !height) return "1:1";
    const divisor = gcd(width, height);
    return `${Math.round(width / divisor)}:${Math.round(height / divisor)}`;
}

function qualityToResolution(quality: string) {
    const normalized = quality.toLowerCase();
    if (normalized === "high" || normalized === "4k") return "4k";
    if (normalized === "medium" || normalized === "hd" || normalized === "2k") return "2k";
    return "1k";
}

function gcd(a: number, b: number): number {
    return b ? gcd(b, a % b) : a;
}

async function pollTask(taskId: string) {
    const startedAt = Date.now();
    let lastPayload: JsonRecord = {};
    while (Date.now() - startedAt < TASK_POLL_TIMEOUT_MS) {
        lastPayload = await getTask(taskId);
        const task = taskData(lastPayload);
        const status = String(task.status || "").toLowerCase();
        if (isCompletedStatus(status)) return lastPayload;
        if (isFailedStatus(status)) throw new Error(taskError(task) || `APIMart task ${taskId} failed`);
        await delay(TASK_POLL_INTERVAL_MS);
    }
    throw new Error(`APIMart task ${taskId} timed out`);
}

async function getTask(taskId: string) {
    const response = await fetch(`${apimartUrl(`tasks/${encodeURIComponent(taskId)}`)}?language=en`, {
        headers: upstreamHeaders(),
    });
    const payload = await readJson(response);
    if (!response.ok) throw new Error(errorMessage(payload) || `APIMart task query failed: ${response.status}`);
    return payload;
}

function extractTaskId(payload: JsonRecord): string {
    const data = recordValue(payload.data);
    const [firstDataItem] = Array.isArray(payload.data) ? payload.data : [];
    const firstData = recordValue(firstDataItem);
    return stringValue(payload.task_id) || stringValue(payload.id) || stringValue(data?.task_id) || stringValue(data?.id) || stringValue(firstData?.task_id) || stringValue(firstData?.id);
}

function taskData(payload: JsonRecord) {
    return recordValue(payload.data) || payload;
}

function isCompletedStatus(status: string) {
    return ["completed", "succeeded", "success", "done"].includes(status);
}

function isFailedStatus(status: string) {
    return ["failed", "cancelled", "canceled", "expired", "error"].includes(status);
}

function taskError(task: JsonRecord) {
    const error = recordValue(task.error);
    return stringValue(task.message) || stringValue(task.msg) || stringValue(error?.message);
}

function errorMessage(payload: JsonRecord) {
    const error = recordValue(payload.error);
    return stringValue(payload.msg) || stringValue(error?.message);
}

function collectUrls(value: unknown, kind: "image" | "video", urls = new Set<string>()) {
    if (typeof value === "string") {
        if (/^https?:\/\//i.test(value) && matchesMediaKind(value, kind)) urls.add(value);
        return Array.from(urls);
    }
    if (!value || typeof value !== "object") return Array.from(urls);
    if (Array.isArray(value)) {
        value.forEach((item) => collectUrls(item, kind, urls));
        return Array.from(urls);
    }
    Object.values(value).forEach((item) => collectUrls(item, kind, urls));
    return Array.from(urls);
}

function matchesMediaKind(url: string, kind: "image" | "video") {
    const lower = url.toLowerCase().split("?")[0];
    if (kind === "image") return /\.(png|jpe?g|webp|gif|avif)$/.test(lower) || lower.includes("/image/");
    return /\.(mp4|webm|mov|m4v)$/.test(lower) || lower.includes("/video/");
}

async function imageUrlToOpenAiData(url: string) {
    try {
        const response = await fetch(url);
        if (!response.ok) return { url };
        const bytes = Buffer.from(await response.arrayBuffer());
        return { b64_json: bytes.toString("base64") };
    } catch {
        return { url };
    }
}

async function formFilesToDataUrls(values: FormDataEntryValue[]) {
    const files = values.filter((value): value is File => typeof value !== "string" && value.size > 0);
    return Promise.all(files.map(fileToDataUrl));
}

async function formValuesToDataUrls(values: FormDataEntryValue[]) {
    const results = await Promise.all(values.map(formValueToDataUrl));
    return results.filter((value): value is string => Boolean(value));
}

async function formValueToDataUrl(value: FormDataEntryValue | null) {
    if (!value) return "";
    if (typeof value === "string") return value.trim();
    if (!value.size) return "";
    return fileToDataUrl(value);
}

async function fileToDataUrl(file: File) {
    const bytes = Buffer.from(await file.arrayBuffer());
    return `data:${file.type || "application/octet-stream"};base64,${bytes.toString("base64")}`;
}

function formString(formData: FormData, key: string) {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
}

function normalizeImageCount(value: FormDataEntryValue | null) {
    const count = Number(value || 1);
    return Math.max(1, Math.min(4, Math.floor(Number.isFinite(count) ? count : 1)));
}

function normalizeDuration(value: FormDataEntryValue | null) {
    const duration = Number(value || 8);
    return Math.max(1, Math.min(20, Math.floor(Number.isFinite(duration) ? duration : 8)));
}

function normalizeResolution(value: FormDataEntryValue | null) {
    const resolution = String(value || "720p").toLowerCase();
    if (resolution === "480" || resolution === "480p") return "480p";
    if (resolution === "1080" || resolution === "1080p") return "1080p";
    return "720p";
}

function normalizeAspectRatio(size: string) {
    if (size.includes(":")) return size;
    const ratio = pixelSizeToRatio(size || "1280x720");
    if (["1:1", "9:16", "16:9", "4:3", "3:4", "21:9"].includes(ratio)) return ratio;
    return ratio.includes("9:16") ? "9:16" : "16:9";
}

function recordValue(value: unknown): JsonRecord | undefined {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : undefined;
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
