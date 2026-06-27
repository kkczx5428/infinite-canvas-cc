import type { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Prompt = {
    id: string;
    title: string;
    coverUrl: string;
    prompt: string;
    tags: string[];
    category: string;
    githubUrl: string;
    preview: string;
    createdAt: string;
    updatedAt: string;
};

type PromptCategory = {
    category: string;
    githubUrl: string;
    build: () => Promise<Omit<Prompt, "category" | "githubUrl">[]>;
};

const gptImage2RawBase = "https://raw.githubusercontent.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts/main";
const awesomeGptImageRawBase = "https://raw.githubusercontent.com/ZeroLu/awesome-gpt-image/main";
const awesomeGpt4oImagePromptsBase = "https://raw.githubusercontent.com/ImgEdify/Awesome-GPT4o-Image-Prompts/main";
const youMindGptImage2RawBase = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-gpt-image-2/main";
const youMindNanoBananaProRawBase = "https://raw.githubusercontent.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts/main";
const davidWuGptImage2RawBase = "https://raw.githubusercontent.com/davidwuw0811-boop/awesome-gpt-image2-prompts/main";
const gptImage2CaseFiles = ["README.md", "cases/ad-creative.md", "cases/character.md", "cases/comparison.md", "cases/ecommerce.md", "cases/portrait.md", "cases/poster.md", "cases/ui.md"];
const cacheTtlMs = 1000 * 60 * 60;
const fetchTimeoutMs = 15000;
const fallbackCoverUrl = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 600'%3E%3Crect width='800' height='600' fill='%23161616'/%3E%3Cpath d='M100 420h600M160 360h480M220 300h360' stroke='%2366d9ef' stroke-width='22' stroke-linecap='round' opacity='.75'/%3E%3Ccircle cx='400' cy='190' r='70' fill='%23f8d66d' opacity='.85'/%3E%3C/svg%3E";

const categories: PromptCategory[] = [
    { category: "gpt-image-2-prompts", githubUrl: "https://github.com/EvoLinkAI/awesome-gpt-image-2-API-and-Prompts", build: buildGptImage2Prompts },
    { category: "awesome-gpt-image", githubUrl: "https://github.com/ZeroLu/awesome-gpt-image", build: buildAwesomeGptImagePrompts },
    { category: "awesome-gpt4o-image-prompts", githubUrl: "https://github.com/ImgEdify/Awesome-GPT4o-Image-Prompts", build: buildAwesomeGpt4oImagePrompts },
    { category: "youmind-gpt-image-2", githubUrl: "https://github.com/YouMind-OpenLab/awesome-gpt-image-2", build: () => buildYouMindPrompts(youMindGptImage2RawBase, "youmind-gpt-image-2", "gpt-image-2") },
    { category: "youmind-nano-banana-pro", githubUrl: "https://github.com/YouMind-OpenLab/awesome-nano-banana-pro-prompts", build: () => buildYouMindPrompts(youMindNanoBananaProRawBase, "youmind-nano-banana-pro", "nano-banana-pro") },
    { category: "davidwu-gpt-image2-prompts", githubUrl: "https://github.com/davidwuw0811-boop/awesome-gpt-image2-prompts", build: buildDavidWuGptImage2Prompts },
];

let memoryCache: { items: Prompt[]; fetchedAt: number } | null = null;
let loadingPrompts: Promise<Prompt[]> | null = null;

export async function GET(request: NextRequest) {
    const params = request.nextUrl.searchParams;
    const keyword = (params.get("keyword") || "").trim().toLowerCase();
    const tags = params.getAll("tag").filter(Boolean);
    const category = params.get("category") || "";
    const page = Math.max(1, Number(params.get("page")) || 1);
    const pageSize = Math.max(1, Math.min(100, Number(params.get("pageSize")) || 20));
    const items = await getPrompts();
    const withoutTagFilter = filterPrompts(items, { keyword, category, tags: [] });
    const filtered = filterPrompts(items, { keyword, category, tags });

    return Response.json({
        items: filtered.slice((page - 1) * pageSize, page * pageSize),
        tags: collectTags(withoutTagFilter),
        categories: categories.map((item) => item.category),
        total: filtered.length,
    });
}

async function getPrompts() {
    if (memoryCache && Date.now() - memoryCache.fetchedAt < cacheTtlMs) return memoryCache.items;
    if (loadingPrompts) return loadingPrompts;
    loadingPrompts = loadPrompts().finally(() => {
        loadingPrompts = null;
    });
    return loadingPrompts;
}

async function loadPrompts() {
    const settled = await Promise.all(
        categories.map(async (category) => {
            try {
                const items = await category.build();
                return items.map((item) => ({ ...item, category: category.category, githubUrl: category.githubUrl }));
            } catch {
                return [];
            }
        }),
    );
    const items = settled.flat();
    if (!items.length) {
        const fallbackItems = fallbackPrompts.map((item) => ({ ...item, category: "built-in", githubUrl: "https://github.com/kkczx5428/infinite-canvas-cc" }));
        memoryCache = { items: fallbackItems, fetchedAt: Date.now() };
        return fallbackItems;
    }
    memoryCache = { items, fetchedAt: Date.now() };
    return items;
}

function filterPrompts(items: Prompt[], options: { keyword: string; category: string; tags: string[] }) {
    return items.filter((item) => {
        if (isActiveOption(options.category) && item.category !== options.category) return false;
        if (options.tags.length && !options.tags.some((tag) => item.tags.includes(tag))) return false;
        if (!options.keyword) return true;
        return [item.title, item.prompt, item.category, ...item.tags].join(" ").toLowerCase().includes(options.keyword);
    });
}

async function buildGptImage2Prompts() {
    const data = (await fetchJson<{ records?: Array<{ title?: string; tweet_url?: string; image_dir?: string; category?: string; added_at?: string }> }>(gptImage2RawBase, "data/ingested_tweets.json")).records || [];
    const cases = new Map<string, string>();
    const markdowns = await Promise.all(gptImage2CaseFiles.map((file) => fetchText(gptImage2RawBase, file)));
    markdowns.forEach((markdown) => collectGptImage2Cases(cases, markdown));
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    data.forEach((item) => {
        const prompt = cases.get(item.tweet_url || "");
        if (!item.title || !prompt || !item.image_dir) return;
        const image = `${gptImage2RawBase}/${item.image_dir}/output.jpg`;
        items.push({ id: `gpt-image-2-prompts-${leftPad(items.length + 1)}`, title: item.title, coverUrl: image, prompt, tags: tagsFromCategory(item.category || ""), preview: markdownPreview([image]), createdAt: item.added_at || "", updatedAt: item.added_at || "" });
    });
    return items;
}

function collectGptImage2Cases(cases: Map<string, string>, markdown: string) {
    for (const match of markdown.matchAll(/### Case \d+: \[[^\]]+]\(([^)]+)\).*?\*\*Prompt:\*\*\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/gs)) {
        cases.set(match[1], match[2].trim());
    }
}

async function buildAwesomeGptImagePrompts() {
    const markdown = await fetchText(awesomeGptImageRawBase, "README.zh-CN.md");
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    for (const section of splitBeforeHeading(markdown, "## ")) {
        const tags = tagsFromHeading(firstMatch(section, /^##\s+(.+)$/m));
        for (const block of splitBeforeHeading(section, "### ")) {
            const title = firstMatch(block, /^###\s+(.+)$/m).replace(/\[([^\]]+)]\([^)]+\)/g, "$1").trim();
            const prompt = firstMatch(block, /\*\*提示词:\*\*\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/s).trim();
            if (!title || !prompt) continue;
            const images = extractMarkdownImages(awesomeGptImageRawBase, block);
            items.push(defaultPrompt(`awesome-gpt-image-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", tags, markdownPreview(images)));
        }
    }
    return items;
}

async function buildAwesomeGpt4oImagePrompts() {
    const markdown = await fetchText(awesomeGpt4oImagePromptsBase, "README.zh-CN.md");
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    for (const block of splitBeforeHeading(markdown, "### ")) {
        const title = firstMatch(block, /^###\s+(.+)$/m).trim();
        const prompt = firstMatch(block, /- \*\*提示词文本：\*\*\s*`(.*?)`/s).trim();
        if (!title || !prompt) continue;
        const images = extractMarkdownImages(awesomeGpt4oImagePromptsBase, block);
        items.push(defaultPrompt(`awesome-gpt4o-image-prompts-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", ["gpt4o"], markdownPreview(images)));
    }
    return items;
}

async function buildYouMindPrompts(baseUrl: string, idPrefix: string, modelTag: string) {
    const markdown = await fetchText(baseUrl, "README_zh.md");
    const items: Omit<Prompt, "category" | "githubUrl">[] = [];
    for (const block of splitBeforeHeading(markdown, "### ")) {
        const title = firstMatch(block, /^###\s+No\.\s*\d+:\s*(.+)$/m).trim();
        const prompt = firstMatch(block, /#### .*?提示词\s*\r?\n\s*```[\w-]*\r?\n(.*?)\r?\n```/s).trim();
        if (!title || !prompt) continue;
        const images = extractMarkdownImages(baseUrl, block);
        items.push(defaultPrompt(`${idPrefix}-${leftPad(items.length + 1)}`, title, prompt, images[0] || "", youMindTags(title, modelTag), markdownPreview(images)));
    }
    return items;
}

async function buildDavidWuGptImage2Prompts() {
    const data = await fetchJson<Array<{ id?: number; title_en?: string; title_cn?: string; category?: string; category_cn?: string; prompt?: string; note?: string; author?: string; source?: string; needs_ref?: boolean; image?: string }>>(davidWuGptImage2RawBase, "prompts.json");
    return data
        .map((item, index) => {
            const title = (item.title_cn || item.title_en || "").trim();
            const prompt = (item.prompt || "").trim();
            if (!title || !prompt) return null;
            const image = absoluteImage(davidWuGptImage2RawBase, item.image || "");
            const preview = [item.title_en, item.note, image ? `![](${image})` : ""].filter(Boolean).join("\n\n");
            return defaultPrompt(`davidwu-gpt-image2-prompts-${leftPad(item.id || index + 1)}`, title, prompt, image, davidWuTags(item), preview);
        })
        .filter((item): item is Omit<Prompt, "category" | "githubUrl"> => Boolean(item));
}

function defaultPrompt(id: string, title: string, prompt: string, coverUrl: string, tags: string[], preview: string): Omit<Prompt, "category" | "githubUrl"> {
    const image = coverUrl || fallbackCoverUrl;
    return { id, title, coverUrl: image, prompt, tags, preview: preview || markdownPreview([image]), createdAt: "", updatedAt: "" };
}

async function fetchText(baseUrl: string, file: string) {
    const githubApiUrl = githubContentsUrl(baseUrl, file);
    if (githubApiUrl) {
        try {
            const response = await fetchWithTimeout(githubApiUrl, { headers: { Accept: "application/vnd.github+json", "User-Agent": "infinite-canvas-cc" } });
            if (response.ok) return decodeGithubContent(await response.json());
        } catch {
            // Fall back to the raw URL below.
        }
    }

    const response = await fetchWithTimeout(`${baseUrl}/${file}`);
    if (!response.ok) throw new Error(`${file} 拉取失败`);
    return response.text();
}

async function fetchJson<T>(baseUrl: string, file: string) {
    return JSON.parse(await fetchText(baseUrl, file)) as T;
}

function splitBeforeHeading(markdown: string, prefix: string) {
    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of markdown.split("\n")) {
        if (line.startsWith(prefix) && current.length) {
            blocks.push(current.join("\n"));
            current = [];
        }
        current.push(line);
    }
    blocks.push(current.join("\n"));
    return blocks;
}

function firstMatch(value: string, pattern: RegExp) {
    return pattern.exec(value)?.[1] || "";
}

function extractMarkdownImages(baseUrl: string, markdown: string) {
    const markdownImages = Array.from(markdown.matchAll(/!\[[^\]]*]\(([^)]+)\)/g), (match) => match[1]);
    const htmlImages = Array.from(markdown.matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi), (match) => match[1]);
    return Array.from(new Set([...markdownImages, ...htmlImages].map((image) => absoluteImage(baseUrl, image)).filter(Boolean)));
}

function absoluteImage(baseUrl: string, image: string) {
    if (!image) return "";
    if (/^https?:\/\//i.test(image)) return image;
    return `${baseUrl}/${image.replace(/^\.?\//, "")}`;
}

function tagsFromCategory(category: string) {
    return splitTags(category.replace(/\s+Cases$/i, ""), /\s*(?:&|and)\s*/);
}

function tagsFromHeading(heading: string) {
    return splitTags(heading.replace(/[^\p{L}\p{N}/&、与 ]/gu, ""), /\s*(?:\/|&|、|与)\s*/);
}

function youMindTags(title: string, modelTag: string) {
    const [, prefix] = title.match(/^(.+?) - /) || [];
    return [modelTag, ...tagsFromHeading(prefix || "")];
}

function davidWuTags(item: { category_cn?: string; category?: string; author?: string; source?: string; needs_ref?: boolean }) {
    const tags = splitTags([item.category_cn, item.category, item.author, item.source].filter(Boolean).join("/"), /\//);
    if (item.needs_ref) tags.push("需要参考图");
    return tags;
}

function splitTags(value: string, pattern: RegExp) {
    return value
        .split(pattern)
        .map((tag) => tag.trim().toLowerCase())
        .filter(Boolean);
}

function markdownPreview(images: string[]) {
    return images.filter(Boolean).map((image) => `![](${image})`).join("\n\n");
}

function collectTags(items: Prompt[]) {
    return Array.from(new Set(items.flatMap((item) => item.tags).filter(Boolean)));
}

function leftPad(value: number) {
    return String(value).padStart(4, "0");
}

function isActiveOption(value: string) {
    return value && value !== "全部" && value !== "all";
}

function githubContentsUrl(baseUrl: string, file: string) {
    const match = baseUrl.match(/^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(.*))?$/);
    if (!match) return "";
    const [, owner, repo, ref, prefix = ""] = match;
    const path = [prefix, file].filter(Boolean).join("/").replace(/^\/+/, "");
    return `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`;
}

async function fetchWithTimeout(url: string, init?: RequestInit) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
    try {
        return await fetch(url, { cache: "no-store", ...(init || {}), signal: controller.signal });
    } finally {
        clearTimeout(timeout);
    }
}

function decodeGithubContent(payload: unknown) {
    if (!payload || typeof payload !== "object" || !("content" in payload)) throw new Error("GitHub 内容为空");
    const content = String((payload as { content?: string }).content || "").replace(/\s/g, "");
    const encoding = String((payload as { encoding?: string }).encoding || "");
    if (encoding !== "base64" || !content) throw new Error("GitHub 内容格式不支持");
    return Buffer.from(content, "base64").toString("utf8");
}

const fallbackPrompts: Omit<Prompt, "category" | "githubUrl">[] = [
    defaultPrompt(
        "built-in-0001",
        "产品海报：高级科技质感",
        "为一款智能硬件产品生成一张高端电商主图海报。画面中心是产品特写，背景为干净的深色工作室灯光，加入细腻反射、柔和轮廓光、极简中文标题留白，整体质感专业、真实、可商用。",
        fallbackCoverUrl,
        ["产品", "海报", "电商"],
        "",
    ),
    defaultPrompt(
        "built-in-0002",
        "人物肖像：自然电影感",
        "生成一张自然电影感人物半身肖像。主体表情放松，柔和侧光，浅景深，真实皮肤纹理，背景是温暖的室内窗边环境，色彩克制、清晰、真实摄影风格。",
        fallbackCoverUrl,
        ["人物", "摄影", "电影感"],
        "",
    ),
    defaultPrompt(
        "built-in-0003",
        "品牌视觉：新中式茶饮",
        "为新中式茶饮品牌生成一张品牌视觉图。画面包含一杯精致茶饮、竹影、陶瓷器皿和淡雅水墨层次，构图现代简洁，留出右侧文案空间，整体清爽高级。",
        fallbackCoverUrl,
        ["品牌", "饮品", "新中式"],
        "",
    ),
    defaultPrompt(
        "built-in-0004",
        "社媒封面：AI 创作教程",
        "生成一张 16:9 社媒封面图，主题是 AI 创作教程。画面中有桌面电脑、灵感草图、生成图片缩略图和清晰的科技界面元素，整体明亮、现代、信息层级清楚，适合视频封面。",
        fallbackCoverUrl,
        ["社媒", "封面", "教程"],
        "",
    ),
];
