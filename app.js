const elements = {
  channels: document.getElementById("channels"),
  apiKey: document.getElementById("apiKey"),
  toggleApiKey: document.getElementById("toggleApiKey"),
  preset: document.getElementById("preset"),
  customDate: document.getElementById("customDate"),
  minViews: document.getElementById("minViews"),
  includeShorts: document.getElementById("includeShorts"),
  sortBy: document.getElementById("sortBy"),
  fetchBtn: document.getElementById("fetchBtn"),
  clearCacheBtn: document.getElementById("clearCacheBtn"),
  groupToggle: document.getElementById("groupToggle"),
  copyCsvBtn: document.getElementById("copyCsvBtn"),
  downloadJsonBtn: document.getElementById("downloadJsonBtn"),
  progressSection: document.getElementById("progress"),
  progressText: document.getElementById("progressText"),
  progressPercent: document.getElementById("progressPercent"),
  progressFill: document.getElementById("progressFill"),
  summaryChannels: document.getElementById("summaryChannels"),
  summaryScanned: document.getElementById("summaryScanned"),
  summaryMatches: document.getElementById("summaryMatches"),
  errorsSection: document.getElementById("errors"),
  errorList: document.getElementById("errorList"),
  grid: document.getElementById("grid"),
  videoCardTemplate: document.getElementById("videoCardTemplate"),
  groupTemplate: document.getElementById("groupTemplate"),
};

const CACHE_KEY = "yt-hot-cache";
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_IDS_PER_CHANNEL = 100;
const CHANNEL_FETCH_CONCURRENCY = 3;
const VIDEO_BATCH_SIZE = 50;
const SHORT_DURATION_THRESHOLD = 60;

let cachedResults = [];

function loadPersistedValues() {
  const storedKey = localStorage.getItem("yt-api-key");
  if (storedKey) {
    elements.apiKey.value = storedKey;
  }
  const storedChannels = localStorage.getItem("yt-channel-list");
  if (storedChannels) {
    elements.channels.value = storedChannels;
  }
}

function persistValues() {
  localStorage.setItem("yt-api-key", elements.apiKey.value.trim());
  localStorage.setItem("yt-channel-list", elements.channels.value.trim());
}

elements.apiKey.addEventListener("change", persistValues);
elements.channels.addEventListener("change", persistValues);

elements.toggleApiKey.addEventListener("click", () => {
  const isPassword = elements.apiKey.type === "password";
  elements.apiKey.type = isPassword ? "text" : "password";
  elements.toggleApiKey.textContent = isPassword ? "Hide" : "Show";
  elements.toggleApiKey.setAttribute(
    "aria-label",
    `${isPassword ? "Hide" : "Show"} API key`
  );
});

elements.clearCacheBtn.addEventListener("click", () => {
  localStorage.removeItem(CACHE_KEY);
  showToast("Cache cleared");
});

elements.groupToggle.addEventListener("change", () => {
  if (elements.groupToggle.checked) {
    renderGroupedByChannel(cachedResults);
  } else {
    renderGrid(cachedResults);
  }
});

elements.copyCsvBtn.addEventListener("click", async () => {
  if (!cachedResults.length) {
    showToast("No results to copy");
    return;
  }
  const csv = buildCsv(cachedResults);
  try {
    await navigator.clipboard.writeText(csv);
    showToast("Copied CSV to clipboard", "success");
  } catch (err) {
    showToast(`Clipboard error: ${err.message}`);
  }
});

elements.downloadJsonBtn.addEventListener("click", () => {
  if (!cachedResults.length) {
    showToast("No results to export");
    return;
  }
  const blob = new Blob([JSON.stringify(cachedResults, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `yt-hot-${Date.now()}.json`;
  document.body.appendChild(link);
  link.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    link.remove();
  }, 0);
});

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("visible"));
  setTimeout(() => {
    toast.classList.remove("visible");
    setTimeout(() => toast.remove(), 500);
  }, 2500);
}

function parseChannelList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function resolveChannelId(input, apiKey) {
  const parsed = parseChannelInput(input);
  if (!parsed) {
    throw new Error("Unsupported channel URL or handle");
  }

  if (parsed.type === "channelId") {
    return await fetchChannelSnippet(parsed.value, apiKey);
  }

  if (parsed.type === "handle") {
    return await resolveHandle(parsed.value, apiKey);
  }

  if (parsed.type === "username") {
    return (
      (await resolveUsername(parsed.value, apiKey)) ||
      (await searchByQuery(parsed.value, apiKey))
    );
  }

  if (parsed.type === "query") {
    return await searchByQuery(parsed.value, apiKey);
  }

  throw new Error("Unable to resolve channel");
}

function parseChannelInput(value) {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("@")) {
    return { type: "handle", value: trimmed }; // e.g. @mychannel
  }

  try {
    const url = new URL(trimmed);
    if (!/youtube\.com$/i.test(url.hostname) && url.hostname !== "youtu.be") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    if (!segments.length) {
      return null;
    }

    if (segments[0].startsWith("@")) {
      return { type: "handle", value: `@${segments[0].replace(/^@/, "")}` };
    }

    if (segments[0] === "channel" && segments[1]) {
      return { type: "channelId", value: segments[1] };
    }

    if (segments[0] === "user" && segments[1]) {
      return { type: "username", value: segments[1] };
    }

    if (segments[0] === "c" && segments[1]) {
      return { type: "query", value: segments[1] };
    }

    return { type: "query", value: segments[segments.length - 1] };
  } catch (err) {
    return { type: "query", value: trimmed };
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) {
    const message = await res.text();
    throw new Error(`API error ${res.status}: ${message}`);
  }
  return res.json();
}

async function fetchChannelSnippet(channelId, apiKey) {
  const params = new URLSearchParams({
    part: "snippet",
    id: channelId,
    key: apiKey,
  });
  const data = await fetchJson(
    `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`
  );
  const item = data.items?.[0];
  if (!item) {
    throw new Error("Channel not found");
  }
  return {
    channelId,
    channelTitle: item.snippet?.title ?? "Unknown Channel",
    channelUrl: `https://www.youtube.com/channel/${channelId}`,
  };
}

async function resolveHandle(handle, apiKey) {
  const params = new URLSearchParams({
    part: "snippet",
    type: "channel",
    q: handle,
    maxResults: "1",
    key: apiKey,
  });
  const data = await fetchJson(
    `https://www.googleapis.com/youtube/v3/search?${params.toString()}`
  );
  const item = data.items?.[0];
  if (!item) {
    throw new Error(`Handle ${handle} not found`);
  }
  return {
    channelId: item.snippet?.channelId,
    channelTitle: item.snippet?.channelTitle ?? handle,
    channelUrl: `https://www.youtube.com/channel/${item.snippet?.channelId}`,
  };
}

async function resolveUsername(username, apiKey) {
  const params = new URLSearchParams({
    part: "snippet",
    forUsername: username,
    key: apiKey,
  });
  const data = await fetchJson(
    `https://www.googleapis.com/youtube/v3/channels?${params.toString()}`
  );
  const item = data.items?.[0];
  if (!item) {
    return null;
  }
  return {
    channelId: item.id,
    channelTitle: item.snippet?.title ?? username,
    channelUrl: `https://www.youtube.com/channel/${item.id}`,
  };
}

async function searchByQuery(query, apiKey) {
  const params = new URLSearchParams({
    part: "snippet",
    type: "channel",
    q: query,
    maxResults: "1",
    key: apiKey,
  });
  const data = await fetchJson(
    `https://www.googleapis.com/youtube/v3/search?${params.toString()}`
  );
  const item = data.items?.[0];
  if (!item) {
    throw new Error(`Channel ${query} not found`);
  }
  return {
    channelId: item.snippet?.channelId,
    channelTitle: item.snippet?.channelTitle ?? query,
    channelUrl: `https://www.youtube.com/channel/${item.snippet?.channelId}`,
  };
}

async function fetchRecentVideoIds(channelId, sinceISO, apiKey) {
  let pageToken = "";
  const videoIds = [];
  do {
    const params = new URLSearchParams({
      part: "id",
      channelId,
      type: "video",
      order: "date",
      publishedAfter: sinceISO,
      maxResults: "50",
      key: apiKey,
    });
    if (pageToken) params.append("pageToken", pageToken);
    const data = await fetchJson(
      `https://www.googleapis.com/youtube/v3/search?${params.toString()}`
    );
    const ids = (data.items || [])
      .map((item) => item.id?.videoId)
      .filter(Boolean);
    videoIds.push(...ids);
    pageToken = data.nextPageToken ?? "";
  } while (pageToken && videoIds.length < MAX_IDS_PER_CHANNEL);

  return videoIds.slice(0, MAX_IDS_PER_CHANNEL);
}

async function fetchVideoDetails(videoIds, apiKey, includeContentDetails) {
  if (!videoIds.length) return [];

  const results = [];
  const part = includeContentDetails
    ? "snippet,statistics,contentDetails"
    : "snippet,statistics";
  const needsDuration = includeContentDetails;
  const ids = [...videoIds];

  while (ids.length) {
    const chunk = ids.splice(0, VIDEO_BATCH_SIZE);
    const params = new URLSearchParams({
      part,
      id: chunk.join(","),
      key: apiKey,
      maxResults: String(VIDEO_BATCH_SIZE),
    });
    const data = await fetchJson(
      `https://www.googleapis.com/youtube/v3/videos?${params.toString()}`
    );
    for (const item of data.items || []) {
      const snippet = item.snippet || {};
      const statistics = item.statistics || {};
      const duration = item.contentDetails?.duration;
      results.push({
        id: item.id,
        title: snippet.title,
        publishedAt: snippet.publishedAt,
        thumbnailUrl:
          snippet.thumbnails?.high?.url || snippet.thumbnails?.medium?.url,
        channelTitle: snippet.channelTitle,
        channelId: snippet.channelId,
        viewCount: Number(statistics.viewCount ?? 0),
        durationSeconds:
          needsDuration && duration
            ? parseISODurationToSeconds(duration)
            : undefined,
      });
    }
  }

  return results;
}

function filterByWindowAndViews(videos, sinceISO, minViews, minDurationSec) {
  const since = new Date(sinceISO);
  return videos.filter((video) => {
    const published = new Date(video.publishedAt);
    if (published < since) return false;
    if (video.viewCount < minViews) return false;
    if (minDurationSec > 0 && (video.durationSeconds ?? Infinity) < minDurationSec) {
      return false;
    }
    return true;
  });
}

function sortVideos(videos, sortBy) {
  return [...videos].sort((a, b) => {
    if (sortBy === "views") {
      if (b.viewCount === a.viewCount) {
        return new Date(b.publishedAt) - new Date(a.publishedAt);
      }
      return b.viewCount - a.viewCount;
    }
    return new Date(b.publishedAt) - new Date(a.publishedAt);
  });
}

function renderSummary({ channels, scanned, matches }) {
  elements.summaryChannels.textContent = channels;
  elements.summaryScanned.textContent = scanned;
  elements.summaryMatches.textContent = matches;
}

function renderErrors(errors) {
  elements.errorList.innerHTML = "";
  if (!errors.length) {
    elements.errorsSection.classList.add("hidden");
    return;
  }
  elements.errorsSection.classList.remove("hidden");
  for (const err of errors) {
    const li = document.createElement("li");
    li.textContent = `${err.input}: ${err.error}`;
    elements.errorList.appendChild(li);
  }
}

function renderGrid(videos) {
  elements.grid.innerHTML = "";
  if (!videos.length) {
    elements.grid.innerHTML =
      '<p class="panel">No videos matched the filters.</p>';
    return;
  }
  for (const video of videos) {
    const card = createVideoCard(video);
    elements.grid.appendChild(card);
  }
}

function showLoadingState() {
  elements.grid.innerHTML =
    '<p class="panel">Fetching videos…</p>';
}

function createVideoCard(video) {
  const tpl = elements.videoCardTemplate.content.cloneNode(true);
  const article = tpl.querySelector(".video-card");
  const img = tpl.querySelector("img");
  const skeleton = tpl.querySelector(".skeleton");
  const badge = tpl.querySelector(".badge.short");
  const title = tpl.querySelector(".video-title");
  const channel = tpl.querySelector(".video-channel");
  const views = tpl.querySelector(".views");
  const date = tpl.querySelector(".date");

  img.alt = `Thumbnail: ${video.title}`;
  img.width = 480;
  img.height = 270;
  img.src = video.thumbnailUrl;
  img.addEventListener("load", () => {
    img.classList.add("loaded");
    skeleton.remove();
  });
  title.textContent = video.title;
  title.href = `https://www.youtube.com/watch?v=${video.id}`;
  channel.textContent = video.channelTitle;
  channel.href = `https://www.youtube.com/channel/${video.channelId}`;
  views.textContent = `${formatNumber(video.viewCount)} views`;
  date.textContent = new Date(video.publishedAt).toISOString().slice(0, 10);
  if ((video.durationSeconds ?? Infinity) < SHORT_DURATION_THRESHOLD) {
    badge.style.display = "inline-flex";
  }

  return article;
}

function renderGroupedByChannel(videos) {
  const grouped = new Map();
  for (const video of videos) {
    if (!grouped.has(video.channelId)) {
      grouped.set(video.channelId, {
        title: video.channelTitle,
        url: `https://www.youtube.com/channel/${video.channelId}`,
        videos: [],
      });
    }
    grouped.get(video.channelId).videos.push(video);
  }

  elements.grid.innerHTML = "";
  if (!grouped.size) {
    elements.grid.innerHTML =
      '<p class="panel">No videos matched the filters.</p>';
    return;
  }

  for (const [, info] of grouped) {
    const tpl = elements.groupTemplate.content.cloneNode(true);
    const section = tpl.querySelector(".channel-group");
    const header = tpl.querySelector(".group-header");
    const title = tpl.querySelector(".group-title");
    const count = tpl.querySelector(".group-count");
    const content = tpl.querySelector(".group-content");

    title.textContent = info.title;
    title.dataset.url = info.url;
    title.classList.add("group-title-link");
    count.textContent = `${info.videos.length} videos`;

    header.addEventListener("click", () => {
      const isHidden = content.classList.toggle("hidden");
      header.setAttribute("aria-expanded", String(!isHidden));
    });
    header.setAttribute("aria-expanded", "true");

    header.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        header.click();
      }
    });

    content.classList.remove("hidden");
    for (const video of info.videos) {
      content.appendChild(createVideoCard(video));
    }

    elements.grid.appendChild(section);
  }
}

function isoForDaysAgo(days) {
  const date = new Date();
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - Number(days));
  return date.toISOString();
}

function parseISODurationToSeconds(duration) {
  const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
  const match = regex.exec(duration);
  if (!match) return 0;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours * 3600 + minutes * 60 + seconds;
}

function formatNumber(num) {
  return new Intl.NumberFormat().format(num ?? 0);
}

function buildCsv(videos) {
  const header = [
    "Video ID",
    "Title",
    "Channel",
    "Channel ID",
    "Views",
    "Published At",
    "Duration (s)",
    "Video URL",
    "Channel URL",
  ];
  const rows = videos.map((video) => [
    video.id,
    escapeCsvField(video.title),
    escapeCsvField(video.channelTitle),
    video.channelId,
    video.viewCount,
    video.publishedAt,
    video.durationSeconds ?? "",
    `https://www.youtube.com/watch?v=${video.id}`,
    `https://www.youtube.com/channel/${video.channelId}`,
  ]);
  return [header, ...rows].map((r) => r.join(",")).join("\n");
}

function escapeCsvField(text) {
  if (text == null) return "";
  const str = String(text);
  if (/[,"\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function getSinceIso() {
  const custom = elements.customDate.value;
  if (custom) {
    const date = new Date(custom);
    date.setUTCHours(0, 0, 0, 0);
    return date.toISOString();
  }
  return isoForDaysAgo(elements.preset.value || 7);
}

function buildCacheKey(params) {
  const keyString = JSON.stringify(params);
  let hash = 0;
  for (let i = 0; i < keyString.length; i++) {
    hash = (hash << 5) - hash + keyString.charCodeAt(i);
    hash |= 0;
  }
  return `yt-hot-${hash}`;
}

function readCache(key) {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;
  try {
    const cache = JSON.parse(raw);
    const entry = cache[key];
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
      return null;
    }
    return entry.value;
  } catch (err) {
    console.error("Cache parse error", err);
    return null;
  }
}

function writeCache(key, value) {
  let cache = {};
  const raw = localStorage.getItem(CACHE_KEY);
  if (raw) {
    try {
      cache = JSON.parse(raw);
    } catch (err) {
      cache = {};
    }
  }
  cache[key] = { value, timestamp: Date.now() };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch (err) {
    console.warn("Unable to write cache", err);
  }
}

function clearProgress() {
  elements.progressSection.classList.add("hidden");
  updateProgress(0, "");
}

function updateProgress(percent, label) {
  elements.progressSection.classList.remove("hidden");
  elements.progressFill.style.width = `${percent}%`;
  elements.progressPercent.textContent = `${Math.round(percent)}%`;
  elements.progressText.textContent = label;
}

function disableControls(disabled) {
  elements.fetchBtn.disabled = disabled;
  elements.copyCsvBtn.disabled = disabled;
  elements.downloadJsonBtn.disabled = disabled;
}

function filterByWindowAndViewsAndShorts(videos, sinceISO, minViews, includeShorts) {
  const minDuration = includeShorts ? 0 : SHORT_DURATION_THRESHOLD;
  return filterByWindowAndViews(videos, sinceISO, minViews, minDuration);
}

function applyResults(videos, context) {
  cachedResults = videos;
  renderSummary(context);
  if (elements.groupToggle.checked) {
    renderGroupedByChannel(videos);
  } else {
    renderGrid(videos);
  }
}

elements.fetchBtn.addEventListener("click", async () => {
  const apiKey = elements.apiKey.value.trim();
  if (!apiKey) {
    showToast("Enter an API key first");
    return;
  }

  const channelInputs = parseChannelList(elements.channels.value);
  if (!channelInputs.length) {
    showToast("Provide at least one channel URL or handle");
    return;
  }

  persistValues();

  const sinceISO = getSinceIso();
  const minViews = Number(elements.minViews.value || 0);
  const includeShorts = elements.includeShorts.checked;
  const sortBy = elements.sortBy.value;

  const cacheKey = buildCacheKey({
    channels: channelInputs,
    sinceISO,
    minViews,
    includeShorts,
    sortBy,
  });

  const cached = readCache(cacheKey);
  if (cached) {
    renderErrors([]);
    applyResults(cached.videos, cached.summary);
    showToast("Loaded from cache", "success");
    return;
  }

  disableControls(true);
  renderSummary({ channels: 0, scanned: 0, matches: 0 });
  showLoadingState();
  renderErrors([]);
  updateProgress(5, "Resolving channels…");

  const errors = [];
  const resolvedChannels = [];

  for (const input of channelInputs) {
    try {
      const resolved = await resolveChannelId(input, apiKey);
      if (resolved) {
        resolvedChannels.push({ ...resolved, input });
      }
    } catch (err) {
      errors.push({ input, error: err.message });
    }
  }

  if (!resolvedChannels.length) {
    disableControls(false);
    renderErrors(errors);
    clearProgress();
    showToast("No channels resolved", "danger");
    return;
  }

  renderErrors(errors);

  const sinceLabel = new Date(sinceISO).toISOString().slice(0, 10);
  updateProgress(10, `Fetching videos since ${sinceLabel}`);

  let scannedCount = 0;
  let allVideoIds = [];

  const pool = new AsyncPool(CHANNEL_FETCH_CONCURRENCY);
  await Promise.all(
    resolvedChannels.map((channel, index) =>
      pool.run(async () => {
        try {
          const ids = await fetchRecentVideoIds(channel.channelId, sinceISO, apiKey);
          scannedCount += ids.length;
          allVideoIds.push(...ids);
          updateProgress(
            10 + (80 * (index + 1)) / resolvedChannels.length,
            `Fetched ${index + 1}/${resolvedChannels.length} channels`
          );
        } catch (err) {
          errors.push({ input: channel.input, error: err.message });
        }
      })
    )
  );

  renderErrors(errors);

  if (!allVideoIds.length) {
    disableControls(false);
    clearProgress();
    applyResults([], {
      channels: resolvedChannels.length,
      scanned: scannedCount,
      matches: 0,
    });
    showToast("No videos found for the selected window");
    return;
  }

  updateProgress(92, "Loading video details…");
  const includeContentDetails = !includeShorts;
  const details = await fetchVideoDetails(
    allVideoIds,
    apiKey,
    includeContentDetails
  );

  updateProgress(96, "Applying filters…");
  const filtered = filterByWindowAndViewsAndShorts(
    details,
    sinceISO,
    minViews,
    includeShorts
  );
  const sorted = sortVideos(filtered, sortBy);
  const summary = {
    channels: resolvedChannels.length,
    scanned: scannedCount,
    matches: sorted.length,
  };
  applyResults(sorted, summary);

  updateProgress(100, "Done");
  setTimeout(clearProgress, 1200);
  disableControls(false);
  cachedResults = sorted;
  writeCache(cacheKey, { videos: sorted, summary });
});

class AsyncPool {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  run(task) {
    return new Promise((resolve, reject) => {
      const runTask = () => {
        this.active++;
        task()
          .then(resolve)
          .catch(reject)
          .finally(() => {
            this.active--;
            if (this.queue.length) {
              const next = this.queue.shift();
              next();
            }
          });
      };
      if (this.active < this.limit) {
        runTask();
      } else {
        this.queue.push(runTask);
      }
    });
  }
}

loadPersistedValues();
applyResults([], { channels: 0, scanned: 0, matches: 0 });

