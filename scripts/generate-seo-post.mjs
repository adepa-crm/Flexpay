#!/usr/bin/env node
/**
 * SEO Content Engine — generates one search-optimised article per run.
 *
 * Everything site-specific lives in seo-config.json, so this file can be
 * copied unchanged between sites.
 *
 * Usage:
 *   node scripts/generate-seo-post.mjs              # generate + publish the next topic
 *   node scripts/generate-seo-post.mjs --dry-run    # generate, write nothing (offline sample if no API key)
 *   node scripts/generate-seo-post.mjs --topic "your keyword"
 *   node scripts/generate-seo-post.mjs --rebuild    # re-render HTML + sitemap from existing posts (no API call)
 *   node scripts/generate-seo-post.mjs --config path/to/seo-config.json
 *
 * Requires: npm install @anthropic-ai/sdk marked   (Node 18+)
 * Env:      ANTHROPIC_API_KEY
 */
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// CLI + config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : undefined;
};

if (flag("help")) {
  console.log(
    "Options: --dry-run  --topic \"keyword\"  --rebuild  --config <path>\nSee the header of this file for details."
  );
  process.exit(0);
}

const DRY_RUN = flag("dry-run");
const REBUILD_ONLY = flag("rebuild");
const CONFIG_PATH = path.resolve(option("config") || process.env.SEO_CONFIG || "seo-config.json");
const ROOT = path.dirname(CONFIG_PATH);

if (!fs.existsSync(CONFIG_PATH)) fail(`Config not found: ${CONFIG_PATH}`);
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

const gen = {
  model: "claude-haiku-4-5",
  maxTokens: 8000,
  wordCount: { min: 1200, max: 1800 },
  internalLinksPerPost: { min: 2, max: 3 },
  relatedPostsToConsider: 8,
  ...(config.generation || {}),
};
const siteUrl = String(config.siteUrl || "").replace(/\/+$/, "");
if (!siteUrl) fail("seo-config.json: siteUrl is required");

const contentDir = path.resolve(ROOT, config.contentDirectory || "content/blog");
const ext = config.fileExtension || ".md";
const fm = config.frontmatter || {};
const fieldNames = {
  title: "title", description: "description", date: "date", updated: "updated", slug: "slug",
  tags: "tags", author: "author", coverImage: "coverImage", summary: "summary", keyword: "keyword",
  draft: "draft",
  ...(fm.fieldNames || {}),
};
const html = { enabled: false, urlPath: "/blog", accentColor: "#0f6e56", ...(config.html || {}) };
const blogPath = "/" + String(html.urlPath || "/blog").replace(/^\/+|\/+$/g, "");

// USD per million tokens, used only for the cost log line.
const PRICING = {
  "claude-haiku-4-5": [1, 5],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-sonnet-5-5": [2, 10],
};
let totalCost = 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fail(msg) {
  console.error(`✖ ${msg}`);
  process.exit(1);
}

function slugify(s) {
  return String(s)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70)
    .replace(/-+$/g, "");
}

const normalize = (s) => slugify(s).replace(/-/g, " ");

function absoluteUrl(url) {
  if (!url) return siteUrl + "/";
  if (/^https?:\/\//i.test(url)) return url;
  return siteUrl + "/" + url.replace(/^\/+/, "");
}

function postUrl(slug) {
  return `${siteUrl}${blogPath}/${slug}/`;
}

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countWords(md) {
  return md.replace(/```[\s\S]*?```/g, "").replace(/[#>*_`|\-\[\]()]/g, " ").split(/\s+/).filter(Boolean).length;
}

function writeFile(file, contents) {
  if (DRY_RUN) {
    console.log(`  (dry run) would write ${path.relative(ROOT, file)}`);
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  console.log(`  ✔ wrote ${path.relative(ROOT, file)}`);
}

// --- Frontmatter: values are written as JSON, which is valid YAML ---------
function toFrontmatter(data) {
  const lines = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "boolean" || typeof v === "number" ? v : JSON.stringify(v)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: text };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const raw = kv[2].trim();
    let value = raw;
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw.replace(/^['"]|['"]$/g, "");
    }
    data[kv[1]] = value;
  }
  return { data, body: m[2] };
}

function loadPosts() {
  if (!fs.existsSync(contentDir)) return [];
  const f = fieldNames;
  return fs
    .readdirSync(contentDir)
    .filter((n) => /\.(md|mdx|markdown)$/i.test(n))
    .map((name) => {
      const { data, body } = parseFrontmatter(fs.readFileSync(path.join(contentDir, name), "utf8"));
      const slug = data[f.slug] || name.replace(/\.(md|mdx|markdown)$/i, "");
      return {
        file: name,
        slug,
        title: data[f.title] || slug,
        description: data[f.description] || "",
        date: String(data[f.date] || ""),
        updated: String(data[f.updated] || data[f.date] || ""),
        tags: Array.isArray(data[f.tags]) ? data[f.tags] : [],
        keyword: data[f.keyword] || "",
        author: data[f.author] || config.author || config.siteName,
        coverImage: data[f.coverImage] || "",
        draft: data[f.draft] === true,
        body,
      };
    })
    .filter((p) => !p.draft)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------
let client;
async function callClaude({ system, prompt, maxTokens }) {
  if (!client) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    client = new Anthropic();
  }
  const params = {
    model: gen.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: prompt }],
  };
  if (gen.effort) params.output_config = { effort: gen.effort }; // only for models that support effort

  let response;
  try {
    response = await client.messages.create(params);
  } catch (err) {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    if (err instanceof Anthropic.AuthenticationError) fail("Invalid ANTHROPIC_API_KEY.");
    if (err instanceof Anthropic.RateLimitError) fail("Rate limited by the Anthropic API — try again later.");
    if (err instanceof Anthropic.APIError) fail(`Anthropic API error ${err.status}: ${err.message}`);
    throw err;
  }

  if (response.stop_reason === "refusal") fail("The model declined this request; try a different topic.");
  if (response.stop_reason === "max_tokens") fail(`Output hit max_tokens (${maxTokens}); raise generation.maxTokens.`);

  const price = PRICING[gen.model];
  if (price) {
    totalCost += (response.usage.input_tokens * price[0] + response.usage.output_tokens * price[1]) / 1e6;
  }
  console.log(`  · ${gen.model}: ${response.usage.input_tokens} in / ${response.usage.output_tokens} out tokens`);
  return response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

function extractTag(text, tag) {
  const m = text.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return m ? m[1].trim() : null;
}

function voiceBlock() {
  const v = config.brandVoice || {};
  return [
    `Site: ${config.siteName} (${siteUrl})`,
    `Niche: ${config.niche}`,
    `Audience: ${config.targetAudience}`,
    config.language ? `Language/locale: ${config.language}` : "",
    v.tone ? `Tone: ${v.tone}` : "",
    v.style?.length ? `Style rules:\n- ${v.style.join("\n- ")}` : "",
    v.avoid?.length ? `Never use these words/phrases: ${v.avoid.map((w) => `"${w}"`).join(", ")}` : "",
    v.productClaims ? `Product claims: ${v.productClaims}` : "",
    v.factualityRules ? `Accuracy: ${v.factualityRules}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// ---------------------------------------------------------------------------
// Topic selection
// ---------------------------------------------------------------------------
async function pickTopic(posts) {
  const existingSlugs = new Set(posts.map((p) => p.slug));
  const existingKeys = new Set(posts.flatMap((p) => [normalize(p.keyword), normalize(p.title)]).filter(Boolean));
  config.seedTopics = config.seedTopics || [];

  const cliTopic = option("topic");
  if (cliTopic) return { entry: { keyword: cliTopic, status: "pending" }, isNew: true };

  for (const entry of config.seedTopics) {
    if (entry.status !== "pending") continue;
    const slug = slugify(entry.slug || entry.keyword);
    if (existingSlugs.has(slug) || existingKeys.has(normalize(entry.keyword))) {
      console.log(`  · skipping "${entry.keyword}" — a post already covers it`);
      entry.status = "published";
      continue;
    }
    return { entry, isNew: false };
  }

  console.log("  · topic queue is empty — asking Claude for a fresh long-tail topic");
  const taken = [
    ...config.seedTopics.map((t) => t.keyword),
    ...posts.map((p) => p.title),
  ];
  if (!process.env.ANTHROPIC_API_KEY && DRY_RUN) {
    return { entry: { keyword: "sample long-tail topic for dry run", status: "pending" }, isNew: true };
  }
  const text = await callClaude({
    maxTokens: 600,
    system: `You are an SEO strategist for a niche website.\n${voiceBlock()}`,
    prompt: `Suggest ONE new long-tail, low-competition search query (4–9 words) that our audience actually types into Google, with clear informational or commercial intent, that we can rank for with one in-depth article.

It must NOT duplicate or closely overlap any of these existing topics:
${taken.map((t) => `- ${t}`).join("\n") || "- (none yet)"}

Reply with only:
<topic>{"keyword": "...", "angle": "one sentence on the specific angle and reader problem", "searchIntent": "informational|commercial|transactional"}</topic>`,
  });
  const json = extractTag(text, "topic");
  let entry;
  try {
    entry = JSON.parse(json);
  } catch {
    fail(`Could not parse generated topic: ${text.slice(0, 300)}`);
  }
  if (existingKeys.has(normalize(entry.keyword))) fail(`Generated topic duplicates an existing post: ${entry.keyword}`);
  return { entry: { ...entry, status: "pending" }, isNew: true };
}

// ---------------------------------------------------------------------------
// Article generation
// ---------------------------------------------------------------------------
function linkCandidates(posts) {
  const core = (config.internalLinks || []).map((l) => ({ ...l, url: absoluteUrl(l.url) }));
  const related = posts.slice(0, gen.relatedPostsToConsider).map((p) => ({
    title: p.title,
    url: postUrl(p.slug),
    description: p.description,
  }));
  const seen = new Set();
  return [...core, ...related].filter((l) => !seen.has(l.url) && seen.add(l.url));
}

async function writeArticle(entry, links) {
  const { min, max } = gen.wordCount;
  const linkRange = gen.internalLinksPerPost;
  const system = `You are a senior writer and subject-matter expert producing articles that rank in Google and get cited by AI search engines because they are the most genuinely useful page on the topic.

${voiceBlock()}

Writing rules:
- Match the search intent of the keyword exactly; answer the core question in the first paragraph.
- Sound like an experienced human: specific examples, numbers where safe, opinions with reasons. No filler intros, no restating the question, no robotic transitions, no summary-of-the-summary conclusion.
- Use Markdown only (no raw HTML). Never output an H1 — the page title is rendered separately. Use H2 (##) for main sections and H3 (###) for sub-points.
- Use the primary keyword naturally in the first 100 words, in at least one H2, and a few times in the body — never stuffed.`;

  const prompt = `Write an article targeting the search query: "${entry.keyword}"
${entry.title ? `Working title: ${entry.title}\n` : ""}${entry.angle ? `Angle: ${entry.angle}\n` : ""}${entry.searchIntent ? `Search intent: ${entry.searchIntent}\n` : ""}
Requirements:
1. Length: ${min}–${max} words of body content.
2. Structure: an opening paragraph (no heading), then 4–7 H2 sections with H3s where useful, including at least one numbered step list or checklist and, where it helps, one comparison table.
3. End with "## Frequently asked questions" containing 4–6 questions, each as an H3 (### Question?) followed by a 2–4 sentence answer. Pick questions people really search ("People also ask" style).
4. Internal links: embed ${linkRange.min}–${linkRange.max} of the links below, in-line within relevant sentences, using descriptive anchor text (never "click here"). Use the exact URLs given. Do not link to any other page on our site.
${links.map((l) => `   - ${l.url} — ${l.title}: ${l.description}`).join("\n")}
5. Do not invent statistics, survey results or quotes. Do not link to external sites.

Reply in exactly this format and nothing else:
<meta>
{"title": "SEO title, 50–60 characters, includes the keyword", "metaDescription": "140–155 characters, includes the keyword, compelling reason to click", "slug": "short-keyword-slug", "tags": ["3 to 5 short tags"], "quickAnswer": "40–60 word direct answer to the query, suitable for a featured snippet"}
</meta>
<article>
...the Markdown article...
</article>`;

  if (!process.env.ANTHROPIC_API_KEY) {
    if (!DRY_RUN) fail("ANTHROPIC_API_KEY is not set (use --dry-run to test offline).");
    console.log("  · no ANTHROPIC_API_KEY — using an offline sample article for the dry run");
    return sampleArticle(entry, links);
  }

  const text = await callClaude({ system, prompt, maxTokens: gen.maxTokens });
  const metaRaw = extractTag(text, "meta");
  const body = extractTag(text, "article");
  if (!metaRaw || !body) fail(`Model output was not in the expected format:\n${text.slice(0, 500)}`);
  let meta;
  try {
    meta = JSON.parse(metaRaw);
  } catch {
    fail(`Could not parse article metadata JSON:\n${metaRaw}`);
  }
  return { meta, body: body.replace(/^#\s+.*\n+/, "") }; // drop a stray H1 if present
}

function sampleArticle(entry, links) {
  const [a, b] = links;
  const para = "This is placeholder text generated offline so you can check file paths, frontmatter, HTML rendering and the sitemap without spending API credits. ".repeat(3);
  return {
    meta: {
      title: `Sample: ${entry.keyword}`.slice(0, 60),
      metaDescription: `A dry-run sample article about ${entry.keyword}, used to test the SEO content pipeline end to end.`,
      slug: slugify(entry.keyword),
      tags: ["sample", "dry run"],
      quickAnswer: `This is a sample quick answer for "${entry.keyword}". Real runs replace it with a 40–60 word direct answer.`,
    },
    body: `${para}\n\n## Why ${entry.keyword} matters\n\n${para} See [${a?.title}](${a?.url}).\n\n## Step by step\n\n1. First step\n2. Second step\n3. Third step\n\n### A detail\n\n${para} Also read [${b?.title}](${b?.url}).\n\n## Frequently asked questions\n\n### Is this a real article?\n\nNo. It is a dry-run sample.\n\n### Will this be published?\n\nNo. Dry runs never write files.\n`,
  };
}

function qualityReport(body, links) {
  const words = countWords(body);
  const used = links.filter((l) => body.includes(l.url)).length;
  const banned = (config.brandVoice?.avoid || []).filter((w) =>
    new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(body)
  );
  console.log(`  · ${words} words, ${used} internal links${banned.length ? `, banned phrases: ${banned.join(", ")}` : ""}`);
  if (words < gen.wordCount.min * 0.85) console.warn("  ⚠ article is shorter than the configured minimum");
  if (used < gen.internalLinksPerPost.min) console.warn("  ⚠ fewer internal links than configured");
}

// ---------------------------------------------------------------------------
// HTML rendering (static pages for sites without a blog renderer)
// ---------------------------------------------------------------------------
let markedInstance;
async function renderMarkdown(md) {
  if (!markedInstance) {
    const { Marked } = await import("marked");
    markedInstance = new Marked({
      renderer: {
        html: () => "", // never pass raw HTML from model output through
        heading({ tokens, depth }) {
          const text = this.parser.parseInline(tokens);
          const id = slugify(text.replace(/<[^>]+>/g, ""));
          return `<h${depth} id="${id}">${text}</h${depth}>\n`;
        },
      },
    });
  }
  return markedInstance.parse(md);
}

function extractFaq(md) {
  const section = md.split(/^##\s+(?:FAQs?|Frequently asked questions)\b.*$/im)[1];
  if (!section) return [];
  const faqBody = section.split(/^##\s/m)[0];
  return faqBody
    .split(/^###\s+/m)
    .slice(1)
    .map((chunk) => {
      const [q, ...rest] = chunk.split("\n");
      const a = rest.join(" ").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim();
      return { q: q.trim(), a };
    })
    .filter((x) => x.q && x.a);
}

function pageShell({ title, description, canonical, body, jsonLd, ogType = "website", image }) {
  const accent = html.accentColor;
  return `<!doctype html>
<html lang="${escapeHtml((config.language || "en").split("-")[0])}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${escapeHtml(canonical)}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${escapeHtml(canonical)}">
<meta property="og:site_name" content="${escapeHtml(config.siteName)}">
${image ? `<meta property="og:image" content="${escapeHtml(absoluteUrl(image))}">\n` : ""}<meta name="twitter:card" content="${image ? "summary_large_image" : "summary"}">
${(jsonLd || []).map((j) => `<script type="application/ld+json">${JSON.stringify(j).replace(/</g, "\\u003c")}</script>`).join("\n")}
<style>
:root{--bg:#f4f2ec;--card:#fff;--text:#232323;--muted:#5f5e5a;--accent:${accent};--line:#e3dfd4}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:17px/1.7 -apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}header.site{display:flex;justify-content:space-between;align-items:center;max-width:780px;margin:0 auto;padding:18px 16px}
header.site a{text-decoration:none;color:var(--text);font-weight:600}header.site nav a{margin-left:18px;font-weight:500;font-size:15px}
header.site nav a.cta{background:var(--accent);color:#fff;padding:8px 14px;border-radius:8px}
main{max-width:780px;margin:0 auto;padding:0 16px 48px}article,.card{background:var(--card);border-radius:14px;padding:32px;border:1px solid var(--line)}
h1{font-size:2rem;line-height:1.25;margin:0 0 8px}h2{font-size:1.4rem;margin:2em 0 .5em;line-height:1.3}h3{font-size:1.12rem;margin:1.5em 0 .4em}
.meta{color:var(--muted);font-size:14px;margin-bottom:24px}.meta+blockquote{border-left:4px solid var(--accent);background:#eef6f2;color:var(--text);padding:6px 18px;border-radius:8px;margin:0 0 24px}
table{border-collapse:collapse;width:100%;display:block;overflow-x:auto;font-size:15px}th,td{border:1px solid var(--line);padding:8px 10px;text-align:left}th{background:#f8f7f3}
blockquote{margin:1em 0;padding:4px 16px;border-left:3px solid var(--line);color:var(--muted)}img{max-width:100%;height:auto;border-radius:10px}
.cta-box{margin-top:32px;padding:24px;border-radius:12px;background:var(--accent);color:#fff}.cta-box a{color:#fff;font-weight:600}
.related{margin-top:28px}.related li{margin:6px 0}.post-list{list-style:none;padding:0;margin:0}.post-list li{padding:18px 0;border-bottom:1px solid var(--line)}
.post-list li:last-child{border-bottom:0}.post-list a{font-weight:600;font-size:1.1rem;text-decoration:none}.post-list p{margin:4px 0 0;color:var(--muted);font-size:15px}
footer{max-width:780px;margin:0 auto;padding:0 16px 40px;color:var(--muted);font-size:14px}
@media (max-width:600px){article,.card{padding:20px}h1{font-size:1.6rem}header.site nav a:not(.cta){display:none}}
</style>
</head>
<body>
<header class="site"><a href="${escapeHtml(siteUrl)}/">${escapeHtml(config.siteName)}</a><nav><a href="${siteUrl}${blogPath}/">Blog</a>${html.ctaUrl ? `<a class="cta" href="${escapeHtml(absoluteUrl(html.ctaUrl))}">Get started</a>` : ""}</nav></header>
<main>
${body}
</main>
<footer>© ${new Date().getUTCFullYear()} ${escapeHtml(config.siteName)}</footer>
</body>
</html>
`;
}

async function renderPostPage(post, allPosts) {
  const url = postUrl(post.slug);
  const faq = extractFaq(post.body);
  const related = allPosts.filter((p) => p.slug !== post.slug).slice(0, 3);
  const publisher = { "@type": "Organization", name: config.siteName, url: siteUrl + "/" };
  const jsonLd = [
    {
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: post.title,
      description: post.description,
      datePublished: post.date,
      dateModified: post.updated || post.date,
      author: { "@type": "Organization", name: post.author },
      publisher,
      mainEntityOfPage: url,
      keywords: post.tags.join(", "),
      ...(post.coverImage ? { image: absoluteUrl(post.coverImage) } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: config.siteName, item: siteUrl + "/" },
        { "@type": "ListItem", position: 2, name: "Blog", item: `${siteUrl}${blogPath}/` },
        { "@type": "ListItem", position: 3, name: post.title, item: url },
      ],
    },
  ];
  if (faq.length) {
    jsonLd.push({
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: faq.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
    });
  }
  const dateLabel = post.date
    ? new Date(post.date + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    : "";
  const body = `<article>
<h1>${escapeHtml(post.title)}</h1>
<div class="meta">${escapeHtml(post.author)}${dateLabel ? ` · <time datetime="${post.date}">${dateLabel}</time>` : ""}</div>
${post.coverImage ? `<img src="${escapeHtml(absoluteUrl(post.coverImage))}" alt="${escapeHtml(post.title)}">\n` : ""}${await renderMarkdown(post.body)}
${html.ctaUrl ? `<div class="cta-box"><a href="${escapeHtml(absoluteUrl(html.ctaUrl))}">${escapeHtml(html.ctaText || "Get started")} →</a></div>` : ""}
${related.length ? `<div class="related"><h2>Keep reading</h2><ul>${related.map((p) => `<li><a href="${postUrl(p.slug)}">${escapeHtml(p.title)}</a></li>`).join("")}</ul></div>` : ""}
</article>`;
  return pageShell({ title: post.title, description: post.description, canonical: url, body, jsonLd, ogType: "article", image: post.coverImage });
}

function renderIndexPage(posts) {
  const url = `${siteUrl}${blogPath}/`;
  const title = `${config.siteName} Blog`;
  const description = `Practical guides for ${config.targetAudience?.split(/[,.(]/)[0] || "our readers"}.`;
  const body = `<div class="card"><h1>${escapeHtml(title)}</h1><p class="meta">${escapeHtml(description)}</p>
<ul class="post-list">${posts
    .map((p) => `<li><a href="${postUrl(p.slug)}">${escapeHtml(p.title)}</a><p>${escapeHtml(p.description)}</p></li>`)
    .join("\n")}</ul></div>`;
  const jsonLd = [{ "@context": "https://schema.org", "@type": "Blog", name: title, url, description }];
  return pageShell({ title, description, canonical: url, body, jsonLd });
}

function renderSitemap(posts) {
  const sm = config.sitemap || {};
  const today = new Date().toISOString().slice(0, 10);
  const entries = [
    ...(sm.staticPages || []).map((p) => ({ loc: absoluteUrl(p.path), changefreq: p.changefreq, priority: p.priority })),
    { loc: `${siteUrl}${blogPath}/`, lastmod: posts[0]?.date || today, changefreq: "weekly", priority: 0.7 },
    ...posts.map((p) => ({ loc: postUrl(p.slug), lastmod: p.updated || p.date, changefreq: "monthly", priority: 0.6 })),
  ];
  const xml = entries
    .map(
      (e) =>
        `  <url>\n    <loc>${escapeHtml(e.loc)}</loc>\n` +
        (e.lastmod ? `    <lastmod>${e.lastmod}</lastmod>\n` : "") +
        (e.changefreq ? `    <changefreq>${e.changefreq}</changefreq>\n` : "") +
        (e.priority !== undefined ? `    <priority>${e.priority}</priority>\n` : "") +
        `  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${xml}\n</urlset>\n`;
}

async function buildSiteOutputs(posts) {
  if (html.enabled && html.outputDirectory) {
    const outDir = path.resolve(ROOT, html.outputDirectory);
    for (const post of posts) writeFile(path.join(outDir, post.slug, "index.html"), await renderPostPage(post, posts));
    writeFile(path.join(outDir, "index.html"), renderIndexPage(posts));
  }
  if (config.sitemap?.enabled && config.sitemap.path) {
    writeFile(path.resolve(ROOT, config.sitemap.path), renderSitemap(posts));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`SEO engine · ${config.siteName}${DRY_RUN ? " · DRY RUN" : ""}`);
  const posts = loadPosts();
  console.log(`  · ${posts.length} existing posts in ${path.relative(ROOT, contentDir) || "."}`);

  if (REBUILD_ONLY) {
    await buildSiteOutputs(posts);
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY && !DRY_RUN) fail("ANTHROPIC_API_KEY is not set (use --dry-run to test offline).");

  const { entry, isNew } = await pickTopic(posts);
  console.log(`  → topic: "${entry.keyword}"`);

  const links = linkCandidates(posts);
  const { meta, body } = await writeArticle(entry, links);
  qualityReport(body, links);

  const takenSlugs = new Set(posts.map((p) => p.slug));
  let slug = slugify(entry.slug || meta.slug || entry.keyword) || `post-${Date.now()}`;
  for (let n = 2; takenSlugs.has(slug); n++) slug = `${slugify(meta.slug || entry.keyword)}-${n}`;

  const today = new Date().toISOString().slice(0, 10);
  const f = fieldNames;
  const quick = String(meta.quickAnswer || "").trim();
  const fullBody = `${quick ? `> **Quick answer:** ${quick}\n\n` : ""}${body.trim()}\n`;
  const frontmatter = toFrontmatter({
    [f.title]: meta.title,
    [f.description]: meta.metaDescription,
    [f.date]: today,
    [f.updated]: today,
    [f.slug]: slug,
    [f.tags]: Array.isArray(meta.tags) ? meta.tags.slice(0, 6) : [],
    [f.author]: config.author || config.siteName,
    [f.coverImage]: fm.defaultCoverImage || undefined,
    [f.summary]: quick,
    [f.keyword]: entry.keyword,
    [f.draft]: false,
    ...(fm.extraFields || {}),
  });
  const markdown = frontmatter + "\n" + fullBody;

  if (DRY_RUN) {
    console.log("\n----- preview -----\n" + markdown.split("\n").slice(0, 40).join("\n") + "\n…\n-------------------\n");
  }

  writeFile(path.join(contentDir, slug + ext), markdown);

  // Update the topic backlog
  entry.status = "published";
  entry.slug = slug;
  entry.url = postUrl(slug);
  entry.publishedAt = today;
  if (isNew) config.seedTopics.push(entry);
  writeFile(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");

  const newPost = {
    slug, title: meta.title, description: meta.metaDescription, date: today, updated: today,
    tags: meta.tags || [], keyword: entry.keyword, author: config.author || config.siteName,
    coverImage: fm.defaultCoverImage || "", body: fullBody,
  };
  await buildSiteOutputs([newPost, ...posts]);

  console.log(`\n✔ ${DRY_RUN ? "Dry run complete" : "Published"}: ${postUrl(slug)}`);
  if (totalCost) console.log(`  · estimated API cost: $${totalCost.toFixed(4)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
