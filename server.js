/* Minimal local CORS proxy for the single-file app.
   - Serves ./index.html at http://127.0.0.1:8787/ (default; override with HOST/PORT env vars)
   - Proxies remote JSON via /raw?url=<encoded>
   This avoids browser CORS issues when BO3.gg blocks direct requests from file:// origin.
*/

const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");
let HLTV_API = null;
try {
  ({ HLTV: HLTV_API } = require("hltv"));
} catch {
  HLTV_API = null;
}

const ROOT_DIR = __dirname;
const ENV_FILE_CANDIDATES = [
  path.join(ROOT_DIR, ".env.local"),
  path.join(ROOT_DIR, ".env")
];
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;

function normalizeEnvValue(rawValue) {
  const value = String(rawValue || "");
  if (!value) {
    return "";
  }
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\");
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, "").trim();
}

function loadEnvFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return;
    }
    const raw = fs.readFileSync(filePath, "utf8");
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = String(line || "").trim();
      if (!trimmed || trimmed.startsWith("#")) {
        return;
      }
      const normalizedLine = trimmed.startsWith("export ")
        ? trimmed.slice("export ".length).trimStart()
        : trimmed;
      const match = normalizedLine.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) {
        return;
      }
      const [, key, rawValue = ""] = match;
      if (process.env[key] !== undefined) {
        return;
      }
      process.env[key] = normalizeEnvValue(rawValue);
    });
  } catch {
  }
}

ENV_FILE_CANDIDATES.forEach(loadEnvFile);

const HOST = process.env.HOST || DEFAULT_HOST;
const parsedPort = Number.parseInt(process.env.PORT || "", 10);
const PORT = Number.isFinite(parsedPort) ? parsedPort : DEFAULT_PORT;
const INDEX_PATH = path.join(__dirname, "index.html");
const DATA_DIR = path.join(__dirname, "data");
const LIQUIPEDIA_ROLE_CACHE_PATH = path.join(DATA_DIR, "liquipedia-roles.json");
const LIQUIPEDIA_RETRY_COOLDOWN_MS = 6 * 60 * 60 * 1000;

const SPORTMONKS_BASE = "https://api.sportmonks.com/v3/football";
const SPORTMONKS_CORE_BASE = "https://api.sportmonks.com/v3/core";
const BO3_BASE = "https://api.bo3.gg/api/v1";
const ODDSPAPI_BASE = "https://api.oddspapi.io/v4";
const PANDASCORE_BASE = "https://api.pandascore.co";
const SPORTMONKS_API_TOKEN = String(process.env.SPORTMONKS_API_TOKEN || "").trim();
const ODDSPAPI_API_KEY = String(process.env.ODDSPAPI_API_KEY || "").trim();
const PANDASCORE_API_TOKEN = String(process.env.PANDASCORE_API_TOKEN || process.env.PANDASCORE_TOKEN || "").trim();
const UPSTREAM_CACHE = new Map();
const UPSTREAM_INFLIGHT = new Map();
const ODDSPAPI_RATE_LIMIT_STATE = new Map();
const HLTV_FALLBACK_CACHE = new Map();
const HLTV_MATCHES_CACHE = { fetchedAt: 0, rows: [] };
const PANDASCORE_FALLBACK_CACHE = new Map();
const PANDASCORE_RUNNING_MATCHES_CACHE = { fetchedAt: 0, rows: [] };
const DEFAULT_FETCH_TIMEOUT_MS = 15000;
const LIVE_STREAM_TICK_MS = 25000;
const LIVE_STREAM_HEARTBEAT_MS = 12000;
const HLTV_MATCHES_CACHE_TTL_MS = 20 * 1000;
const HLTV_FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;
const HLTV_FALLBACK_LIVE_CACHE_TTL_MS = 20 * 1000;
const PANDASCORE_RUNNING_MATCHES_CACHE_TTL_MS = 20 * 1000;
const PANDASCORE_FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;
const PANDASCORE_FALLBACK_LIVE_CACHE_TTL_MS = 20 * 1000;

function send(res, statusCode, headers, body) {
  res.writeHead(statusCode, headers);
  res.end(body);
}

function sendJson(res, statusCode, payload) {
  send(
    res,
    statusCode,
    {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, OPTIONS"
    },
    JSON.stringify(payload)
  );
}

function ensureDirSync(dirPath) {
  try {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  } catch {
  }
}

function readJsonFileSafe(filePath, fallbackValue) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

function writeJsonFileSafe(filePath, value) {
  try {
    ensureDirSync(path.dirname(filePath));
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
  } catch {
  }
}

function normalizePlayerKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\wа-яё\s.-]/gi, "");
}

function normalizeCs2Role(rawValue) {
  const raw = String(rawValue || "").trim().toLowerCase();
  if (!raw) {
    return "";
  }
  if (raw.includes("igl") || raw.includes("in-game leader") || raw.includes("ingame leader")) {
    return "IGL";
  }
  if (raw.includes("awp") || raw.includes("sniper")) {
    return "AWP";
  }
  if (raw.includes("entry")) {
    return "Entry";
  }
  if (raw.includes("lurk")) {
    return "Lurker";
  }
  if (raw.includes("support")) {
    return "Support";
  }
  if (raw.includes("rifle") || raw.includes("rifler")) {
    return "Rifler";
  }
  return "";
}

function normalizeTeamNameKeyForMatch(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\b(?:esports?|gaming|team|clan|club)\b/gi, "")
    .replace(/[\s._-]+/g, "")
    .replace(/[^a-zа-яё0-9]/gi, "");
}

function teamNameLikelySame(left, right) {
  const a = normalizeTeamNameKeyForMatch(left);
  const b = normalizeTeamNameKeyForMatch(right);
  if (!a || !b) {
    return false;
  }
  return a === b || a.includes(b) || b.includes(a);
}

function prettifyHltvMapName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const cleaned = raw
    .replace(/^de[_\s-]*/i, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!cleaned) {
    return "";
  }
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function getHltvFallbackCacheKey(options = {}) {
  const includeLive = options.includeLive === true ? "live" : "base";
  const matchId = Number(options.matchId);
  const homeKey = normalizeTeamNameKeyForMatch(options.homeName);
  const awayKey = normalizeTeamNameKeyForMatch(options.awayName);
  const kickoff = Number(options.kickoffMs);
  return [
    includeLive,
    Number.isFinite(matchId) && matchId > 0 ? `id:${matchId}` : "id:none",
    `h:${homeKey || "-"}`,
    `a:${awayKey || "-"}`,
    Number.isFinite(kickoff) ? `k:${Math.floor(kickoff / 60000)}` : "k:none"
  ].join("|");
}

async function fetchHltvMatchesCached({ bypassCache = false } = {}) {
  if (!HLTV_API || typeof HLTV_API.getMatches !== "function") {
    return [];
  }

  const now = Date.now();
  const hasFreshCache =
    !bypassCache
    && Number.isFinite(Number(HLTV_MATCHES_CACHE.fetchedAt))
    && (now - Number(HLTV_MATCHES_CACHE.fetchedAt)) < HLTV_MATCHES_CACHE_TTL_MS
    && Array.isArray(HLTV_MATCHES_CACHE.rows);
  if (hasFreshCache) {
    return HLTV_MATCHES_CACHE.rows;
  }

  try {
    const rows = await HLTV_API.getMatches();
    const safeRows = Array.isArray(rows) ? rows : [];
    HLTV_MATCHES_CACHE.fetchedAt = now;
    HLTV_MATCHES_CACHE.rows = safeRows;
    return safeRows;
  } catch {
    return Array.isArray(HLTV_MATCHES_CACHE.rows) ? HLTV_MATCHES_CACHE.rows : [];
  }
}

function pickHltvCandidateMatch(matches, options = {}) {
  const homeName = String(options.homeName || "").trim();
  const awayName = String(options.awayName || "").trim();
  const homeKey = normalizeTeamNameKeyForMatch(homeName);
  const awayKey = normalizeTeamNameKeyForMatch(awayName);
  const kickoffMs = Number(options.kickoffMs);
  const includeLive = options.includeLive === true;

  let best = null;
  let bestScore = -Infinity;

  for (const match of Array.isArray(matches) ? matches : []) {
    const team1Name = String(match?.team1?.name || "").trim();
    const team2Name = String(match?.team2?.name || "").trim();
    const direct = teamNameLikelySame(homeKey, team1Name) && teamNameLikelySame(awayKey, team2Name);
    const swapped = teamNameLikelySame(homeKey, team2Name) && teamNameLikelySame(awayKey, team1Name);
    const partial =
      teamNameLikelySame(homeKey, team1Name)
      || teamNameLikelySame(homeKey, team2Name)
      || teamNameLikelySame(awayKey, team1Name)
      || teamNameLikelySame(awayKey, team2Name);
    if (!direct && !swapped && !partial) {
      continue;
    }

    if (includeLive && match?.live !== true && !direct && !swapped) {
      continue;
    }

    let score = 0;
    if (direct) {
      score += 120;
    } else if (swapped) {
      score += 110;
    } else if (partial) {
      score += 45;
    }

    if (match?.live === true) {
      score += includeLive ? 30 : 12;
    }

    const matchDate = Number(match?.date);
    if (Number.isFinite(kickoffMs) && Number.isFinite(matchDate) && matchDate > 0) {
      const diffMinutes = Math.abs(kickoffMs - matchDate) / 60000;
      score += Math.max(-24, 24 - (diffMinutes / 12));
    }

    if (score > bestScore) {
      bestScore = score;
      best = match;
    }
  }

  return best;
}

function resolveScoreboardSides(scoreboard, context = {}) {
  const homeName = String(context.homeName || "").trim();
  const awayName = String(context.awayName || "").trim();
  const homeId = Number(context.homeId);
  const awayId = Number(context.awayId);

  const ctName = String(scoreboard?.ctTeamName || "").trim();
  const tName = String(scoreboard?.terroristTeamName || "").trim();
  const ctTeamId = Number(scoreboard?.ctTeamId);
  const tTeamId = Number(scoreboard?.tTeamId);

  let ctSide = "";
  if (teamNameLikelySame(ctName, homeName)) {
    ctSide = "home";
  } else if (teamNameLikelySame(ctName, awayName)) {
    ctSide = "away";
  } else if (Number.isFinite(homeId) && homeId > 0 && Number.isFinite(ctTeamId) && ctTeamId === homeId) {
    ctSide = "home";
  } else if (Number.isFinite(awayId) && awayId > 0 && Number.isFinite(ctTeamId) && ctTeamId === awayId) {
    ctSide = "away";
  } else if (teamNameLikelySame(tName, homeName)) {
    ctSide = "away";
  } else if (teamNameLikelySame(tName, awayName)) {
    ctSide = "home";
  } else if (Number.isFinite(homeId) && homeId > 0 && Number.isFinite(tTeamId) && tTeamId === homeId) {
    ctSide = "away";
  } else if (Number.isFinite(awayId) && awayId > 0 && Number.isFinite(tTeamId) && tTeamId === awayId) {
    ctSide = "home";
  }
  if (!ctSide) {
    ctSide = "home";
  }

  const tSide = ctSide === "home" ? "away" : "home";
  const sideByTag = {
    CT: ctSide,
    TERRORIST: tSide
  };

  const teamBySide = {
    home: {
      id: Number.isFinite(homeId) && homeId > 0 ? homeId : null,
      name: homeName || (ctSide === "home" ? ctName : tName) || "Team 1"
    },
    away: {
      id: Number.isFinite(awayId) && awayId > 0 ? awayId : null,
      name: awayName || (ctSide === "away" ? ctName : tName) || "Team 2"
    }
  };

  return { sideByTag, teamBySide };
}

function buildHltvLivePlayersRows(scoreboard, context = {}) {
  if (!scoreboard || typeof scoreboard !== "object") {
    return null;
  }

  const mapping = resolveScoreboardSides(scoreboard, context);
  const toRows = (tag, players) => {
    const side = mapping.sideByTag[tag];
    const teamInfo = side === "away" ? mapping.teamBySide.away : mapping.teamBySide.home;
    return (Array.isArray(players) ? players : []).map((player) => {
      const nickname = String(player?.nick || player?.name || "Player").trim() || "Player";
      const kills = Number(player?.score);
      const deaths = Number(player?.deaths);
      const assists = Number(player?.assists);
      const adr = Number(player?.damagePrRound);
      return {
        team_id: teamInfo.id,
        team_name: teamInfo.name,
        player_nickname: nickname,
        nickname,
        kills: Number.isFinite(kills) ? kills : 0,
        death: Number.isFinite(deaths) ? deaths : 0,
        deaths: Number.isFinite(deaths) ? deaths : 0,
        assists: Number.isFinite(assists) ? assists : 0,
        adr: Number.isFinite(adr) ? adr : null,
        player_rating: null,
        steam_profile: {
          nickname,
          player: {
            nickname,
            team_id: teamInfo.id
          }
        }
      };
    });
  };

  const ctRows = toRows("CT", scoreboard?.CT);
  const tRows = toRows("TERRORIST", scoreboard?.TERRORIST);
  const livePlayers = [...ctRows, ...tRows];

  const ctScoreRaw = Number(scoreboard?.counterTerroristScore ?? scoreboard?.ctTeamScore);
  const tScoreRaw = Number(scoreboard?.terroristScore ?? scoreboard?.tTeamScore);
  const ctScore = Number.isFinite(ctScoreRaw) ? ctScoreRaw : null;
  const tScore = Number.isFinite(tScoreRaw) ? tScoreRaw : null;
  const ctSide = mapping.sideByTag.CT;
  const mapScoreHome = ctSide === "home" ? ctScore : tScore;
  const mapScoreAway = ctSide === "home" ? tScore : ctScore;

  const roundRaw = Number(scoreboard?.currentRound);
  const currentRound = Number.isFinite(roundRaw) && roundRaw > 0 ? roundRaw : null;
  const currentMapName = prettifyHltvMapName(scoreboard?.mapName);

  return {
    livePlayers,
    mapScoreHome: Number.isFinite(Number(mapScoreHome)) ? Number(mapScoreHome) : null,
    mapScoreAway: Number.isFinite(Number(mapScoreAway)) ? Number(mapScoreAway) : null,
    currentRound,
    currentMapName
  };
}

async function fetchHltvScoreboardSnapshot(matchId, timeoutMs = 6500) {
  const numericMatchId = Number(matchId);
  if (!HLTV_API || typeof HLTV_API.connectToScorebot !== "function" || !Number.isFinite(numericMatchId) || numericMatchId <= 0) {
    return null;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finalize = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(payload || null);
    };
    const timer = setTimeout(() => finalize(null), Math.max(2500, Number(timeoutMs) || 6500));

    try {
      HLTV_API.connectToScorebot({
        id: numericMatchId,
        onScoreboardUpdate: (data, done) => {
          try {
            if (typeof done === "function") {
              done();
            }
          } catch {
          }
          finalize(data || null);
        },
        onDisconnect: () => {
        }
      });
    } catch {
      finalize(null);
    }
  });
}

function collectHltvMapPool(matchPayload) {
  const unique = new Set();
  (Array.isArray(matchPayload?.vetoes) ? matchPayload.vetoes : []).forEach((entry) => {
    const mapName = prettifyHltvMapName(entry?.map);
    if (mapName) {
      unique.add(mapName);
    }
  });
  (Array.isArray(matchPayload?.maps) ? matchPayload.maps : []).forEach((entry) => {
    const mapName = prettifyHltvMapName(entry?.name);
    if (mapName) {
      unique.add(mapName);
    }
  });
  return Array.from(unique.values());
}

async function fetchHltvCs2FallbackPayload(options = {}) {
  if (!HLTV_API || typeof HLTV_API.getMatch !== "function") {
    return {
      ok: false,
      unavailable: true,
      reason: "HLTV package unavailable on server"
    };
  }

  const includeLive = options.includeLive === true;
  const bypassCache = options.bypassCache === true;
  const homeName = String(options.homeName || "").trim();
  const awayName = String(options.awayName || "").trim();
  const homeId = Number(options.homeId);
  const awayId = Number(options.awayId);
  const kickoffMs = Number(options.kickoffMs);
  const requestedMatchId = Number(options.matchId);

  const cacheKey = getHltvFallbackCacheKey({
    includeLive,
    matchId: requestedMatchId,
    homeName,
    awayName,
    kickoffMs
  });
  const cacheTtl = includeLive ? HLTV_FALLBACK_LIVE_CACHE_TTL_MS : HLTV_FALLBACK_CACHE_TTL_MS;
  const cached = HLTV_FALLBACK_CACHE.get(cacheKey) || null;
  if (
    !bypassCache
    && cached
    && Number.isFinite(Number(cached.fetchedAt))
    && (Date.now() - Number(cached.fetchedAt)) < cacheTtl
  ) {
    return cached.payload;
  }

  let resolvedMatchId = Number.isFinite(requestedMatchId) && requestedMatchId > 0 ? requestedMatchId : null;
  let candidateLive = false;
  if (!resolvedMatchId) {
    const matches = await fetchHltvMatchesCached({ bypassCache });
    const candidate = pickHltvCandidateMatch(matches, {
      homeName,
      awayName,
      kickoffMs,
      includeLive
    });
    if (!candidate?.id) {
      return {
        ok: false,
        unavailable: true,
        reason: "HLTV candidate match not found"
      };
    }
    resolvedMatchId = Number(candidate.id);
    candidateLive = candidate.live === true;
  }

  if (!Number.isFinite(resolvedMatchId) || resolvedMatchId <= 0) {
    return {
      ok: false,
      unavailable: true,
      reason: "Invalid HLTV match id"
    };
  }

  try {
    const matchPayload = await HLTV_API.getMatch({ id: resolvedMatchId });
    const mapPool = collectHltvMapPool(matchPayload);
    const response = {
      ok: true,
      source: "hltv",
      matchId: resolvedMatchId,
      live: Boolean(matchPayload?.status === "Live" || candidateLive),
      mapPool,
      fetchedAt: Date.now(),
      fetchedAtIso: new Date().toISOString()
    };

    if (includeLive) {
      const scoreboard = await fetchHltvScoreboardSnapshot(resolvedMatchId);
      const liveSection = buildHltvLivePlayersRows(scoreboard, {
        homeName,
        awayName,
        homeId,
        awayId
      });
      if (liveSection) {
        response.livePlayers = Array.isArray(liveSection.livePlayers) ? liveSection.livePlayers : [];
        response.mapScoreHome = liveSection.mapScoreHome;
        response.mapScoreAway = liveSection.mapScoreAway;
        response.currentRound = liveSection.currentRound;
        response.currentMapName = liveSection.currentMapName;
      }
    }

    HLTV_FALLBACK_CACHE.set(cacheKey, {
      fetchedAt: Date.now(),
      payload: response
    });
    return response;
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      reason: String(error?.message || "HLTV fallback request failed")
    };
  }
}

function getPandaScoreFallbackCacheKey(options = {}) {
  const includeLive = options.includeLive === true ? "live" : "base";
  const matchId = Number(options.matchId);
  const homeKey = normalizeTeamNameKeyForMatch(options.homeName);
  const awayKey = normalizeTeamNameKeyForMatch(options.awayName);
  const kickoff = Number(options.kickoffMs);
  return [
    includeLive,
    Number.isFinite(matchId) && matchId > 0 ? `id:${matchId}` : "id:none",
    `h:${homeKey || "-"}`,
    `a:${awayKey || "-"}`,
    Number.isFinite(kickoff) ? `k:${Math.floor(kickoff / 60000)}` : "k:none"
  ].join("|");
}

async function fetchPandaScoreJson(pathname, query = null, timeoutMs = 12000) {
  if (!PANDASCORE_API_TOKEN) {
    throw new Error("Missing PANDASCORE_API_TOKEN");
  }

  const url = new URL(`${PANDASCORE_BASE}${pathname}`);
  if (query && typeof query === "object") {
    Object.entries(query).forEach(([key, value]) => {
      if (value === null || value === undefined || value === "") {
        return;
      }
      url.searchParams.set(key, String(value));
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, Number(timeoutMs) || 12000));
  try {
    const response = await fetch(url.toString(), {
      method: "GET",
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${PANDASCORE_API_TOKEN}`,
        accept: "application/json",
        "user-agent": "LivePulseBetCenter/0.0 (local-proxy)"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

function prettifyPandaScoreMapName(value) {
  return prettifyHltvMapName(value);
}

function extractPandaScoreOpponents(matchPayload) {
  const opponents = Array.isArray(matchPayload?.opponents) ? matchPayload.opponents : [];
  const normalized = opponents
    .map((entry) => {
      const opponent = entry?.opponent && typeof entry.opponent === "object" ? entry.opponent : entry;
      return {
        id: Number(opponent?.id),
        name: String(opponent?.name || opponent?.acronym || "").trim()
      };
    })
    .filter((entry) => Number.isFinite(entry.id) && entry.id > 0 && entry.name);
  return normalized.slice(0, 2);
}

function pickPandaScoreCandidateMatch(matches, options = {}) {
  const homeName = String(options.homeName || "").trim();
  const awayName = String(options.awayName || "").trim();
  const kickoffMs = Number(options.kickoffMs);
  const includeLive = options.includeLive === true;
  const homeId = Number(options.homeId);
  const awayId = Number(options.awayId);

  let best = null;
  let bestScore = -Infinity;

  for (const match of Array.isArray(matches) ? matches : []) {
    const opponents = extractPandaScoreOpponents(match);
    if (opponents.length < 2) {
      continue;
    }
    const [team1, team2] = opponents;
    const directName = teamNameLikelySame(homeName, team1.name) && teamNameLikelySame(awayName, team2.name);
    const swappedName = teamNameLikelySame(homeName, team2.name) && teamNameLikelySame(awayName, team1.name);
    const directId = Number.isFinite(homeId) && Number.isFinite(awayId) && homeId > 0 && awayId > 0 && team1.id === homeId && team2.id === awayId;
    const swappedId = Number.isFinite(homeId) && Number.isFinite(awayId) && homeId > 0 && awayId > 0 && team1.id === awayId && team2.id === homeId;
    const partial =
      teamNameLikelySame(homeName, team1.name)
      || teamNameLikelySame(homeName, team2.name)
      || teamNameLikelySame(awayName, team1.name)
      || teamNameLikelySame(awayName, team2.name);

    if (!directName && !swappedName && !directId && !swappedId && !partial) {
      continue;
    }

    let score = 0;
    if (directName || directId) {
      score += 120;
    } else if (swappedName || swappedId) {
      score += 110;
    } else if (partial) {
      score += 45;
    }

    const status = String(match?.status || "").toLowerCase();
    const isLive = status === "running" || status === "live";
    if (includeLive && isLive) {
      score += 35;
    } else if (includeLive && !isLive && !(directName || directId || swappedName || swappedId)) {
      continue;
    }

    const beginAtMs = Date.parse(match?.begin_at || "");
    if (Number.isFinite(kickoffMs) && Number.isFinite(beginAtMs) && beginAtMs > 0) {
      const diffMinutes = Math.abs(kickoffMs - beginAtMs) / 60000;
      score += Math.max(-24, 24 - (diffMinutes / 12));
    }

    if (score > bestScore) {
      bestScore = score;
      best = match;
    }
  }

  return best;
}

function resolvePandaScoreTeams(matchPayload, options = {}) {
  const opponents = extractPandaScoreOpponents(matchPayload);
  const fallbackHomeName = String(options.homeName || "").trim();
  const fallbackAwayName = String(options.awayName || "").trim();
  const fallbackHomeId = Number(options.homeId);
  const fallbackAwayId = Number(options.awayId);

  if (opponents.length < 2) {
    return {
      home: {
        id: Number.isFinite(fallbackHomeId) && fallbackHomeId > 0 ? fallbackHomeId : null,
        name: fallbackHomeName || "Team 1"
      },
      away: {
        id: Number.isFinite(fallbackAwayId) && fallbackAwayId > 0 ? fallbackAwayId : null,
        name: fallbackAwayName || "Team 2"
      }
    };
  }

  const [first, second] = opponents;
  const homeById = Number.isFinite(fallbackHomeId) && fallbackHomeId > 0
    ? (first.id === fallbackHomeId ? first : second.id === fallbackHomeId ? second : null)
    : null;
  const awayById = Number.isFinite(fallbackAwayId) && fallbackAwayId > 0
    ? (first.id === fallbackAwayId ? first : second.id === fallbackAwayId ? second : null)
    : null;
  const homeByName = !homeById && fallbackHomeName
    ? (teamNameLikelySame(first.name, fallbackHomeName) ? first : teamNameLikelySame(second.name, fallbackHomeName) ? second : null)
    : null;
  const awayByName = !awayById && fallbackAwayName
    ? (teamNameLikelySame(first.name, fallbackAwayName) ? first : teamNameLikelySame(second.name, fallbackAwayName) ? second : null)
    : null;

  const resolvedHome = homeById || homeByName || first;
  const resolvedAway = awayById || awayByName || (resolvedHome?.id === first.id ? second : first);

  return {
    home: {
      id: Number.isFinite(Number(resolvedHome?.id)) ? Number(resolvedHome.id) : (Number.isFinite(fallbackHomeId) && fallbackHomeId > 0 ? fallbackHomeId : null),
      name: String(resolvedHome?.name || fallbackHomeName || "Team 1")
    },
    away: {
      id: Number.isFinite(Number(resolvedAway?.id)) ? Number(resolvedAway.id) : (Number.isFinite(fallbackAwayId) && fallbackAwayId > 0 ? fallbackAwayId : null),
      name: String(resolvedAway?.name || fallbackAwayName || "Team 2")
    }
  };
}

function extractPandaScoreSeries(matchPayload, teams) {
  const rows = Array.isArray(matchPayload?.results) ? matchPayload.results : [];
  const homeId = Number(teams?.home?.id);
  const awayId = Number(teams?.away?.id);
  let homeScore = null;
  let awayScore = null;
  rows.forEach((row) => {
    const teamId = Number(row?.team_id || row?.opponent_id || row?.id);
    const score = Number(row?.score);
    if (!Number.isFinite(score)) {
      return;
    }
    if (Number.isFinite(homeId) && homeId > 0 && teamId === homeId) {
      homeScore = score;
    } else if (Number.isFinite(awayId) && awayId > 0 && teamId === awayId) {
      awayScore = score;
    }
  });
  return {
    home: Number.isFinite(homeScore) ? homeScore : null,
    away: Number.isFinite(awayScore) ? awayScore : null
  };
}

function parsePandaScoreMapName(value) {
  return prettifyPandaScoreMapName(value);
}

function extractPandaScoreGamesPayload(matchPayload, fallbackGamesPayload) {
  if (Array.isArray(matchPayload?.games) && matchPayload.games.length) {
    return matchPayload.games;
  }
  if (Array.isArray(fallbackGamesPayload)) {
    return fallbackGamesPayload;
  }
  if (Array.isArray(fallbackGamesPayload?.results)) {
    return fallbackGamesPayload.results;
  }
  return [];
}

function collectPandaScoreMapPool(matchPayload, gamesPayload) {
  const unique = new Set();
  const pushMap = (value) => {
    const name = parsePandaScoreMapName(value);
    if (name) {
      unique.add(name);
    }
  };
  (Array.isArray(matchPayload?.maps) ? matchPayload.maps : []).forEach((entry) => {
    pushMap(entry?.name || entry?.slug || entry);
  });
  (Array.isArray(gamesPayload) ? gamesPayload : []).forEach((game) => {
    pushMap(game?.map?.name || game?.map?.slug || game?.map_name || game?.name || game?.slug);
  });
  return Array.from(unique.values());
}

function resolvePandaScoreCurrentGame(gamesPayload) {
  const games = (Array.isArray(gamesPayload) ? gamesPayload : [])
    .slice()
    .sort((left, right) => {
      const leftNumber = Number(left?.number ?? left?.position);
      const rightNumber = Number(right?.number ?? right?.position);
      if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      return Number(left?.id) - Number(right?.id);
    });
  if (!games.length) {
    return null;
  }
  const live = games.find((game) => {
    const status = String(game?.status || game?.state || "").toLowerCase();
    return status === "running" || status === "live" || status === "started" || status === "in_progress";
  });
  if (live) {
    return live;
  }
  const pending = games.find((game) => {
    const status = String(game?.status || game?.state || "").toLowerCase();
    return status === "not_started" || status === "upcoming" || status === "scheduled";
  });
  if (pending) {
    return pending;
  }
  return games[games.length - 1] || null;
}

function resolvePandaScoreGameScore(gamePayload, teams) {
  if (!gamePayload || typeof gamePayload !== "object") {
    return null;
  }
  const directHome = Number(
    gamePayload?.team1_score
    ?? gamePayload?.home_score
    ?? gamePayload?.score1
    ?? gamePayload?.score?.home
    ?? gamePayload?.scores?.home
  );
  const directAway = Number(
    gamePayload?.team2_score
    ?? gamePayload?.away_score
    ?? gamePayload?.score2
    ?? gamePayload?.score?.away
    ?? gamePayload?.scores?.away
  );
  if (Number.isFinite(directHome) && Number.isFinite(directAway)) {
    return { home: directHome, away: directAway };
  }

  const homeId = Number(teams?.home?.id);
  const awayId = Number(teams?.away?.id);
  const results = Array.isArray(gamePayload?.results) ? gamePayload.results : [];
  let home = null;
  let away = null;
  results.forEach((row) => {
    const teamId = Number(row?.team_id || row?.opponent_id || row?.id);
    const score = Number(row?.score);
    if (!Number.isFinite(score)) {
      return;
    }
    if (Number.isFinite(homeId) && homeId > 0 && teamId === homeId) {
      home = score;
    } else if (Number.isFinite(awayId) && awayId > 0 && teamId === awayId) {
      away = score;
    }
  });
  if (Number.isFinite(home) && Number.isFinite(away)) {
    return { home, away };
  }
  return null;
}

function mapPandaScorePlayersStatsRows(rows, teams) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (!safeRows.length) {
    return [];
  }
  const homeId = Number(teams?.home?.id);
  const awayId = Number(teams?.away?.id);
  const homeName = String(teams?.home?.name || "Team 1");
  const awayName = String(teams?.away?.name || "Team 2");
  return safeRows.map((row) => {
    const teamId = Number(row?.team_id || row?.opponent_id || row?.team?.id);
    const playerName = String(row?.player?.name || row?.nickname || row?.name || "Player").trim() || "Player";
    const kills = Number(row?.kills ?? row?.kill ?? row?.nb_kills ?? row?.total_kills);
    const deaths = Number(row?.deaths ?? row?.death ?? row?.nb_deaths ?? row?.total_deaths);
    const assists = Number(row?.assists ?? row?.assist ?? row?.nb_assists ?? row?.total_assists);
    const adr = Number(row?.adr ?? row?.average_damage_round ?? row?.damage_per_round);
    const rating = Number(row?.rating ?? row?.player_rating);
    const teamName =
      Number.isFinite(homeId) && homeId > 0 && teamId === homeId
        ? homeName
        : Number.isFinite(awayId) && awayId > 0 && teamId === awayId
          ? awayName
          : String(row?.team?.name || "");
    return {
      team_id: Number.isFinite(teamId) && teamId > 0 ? teamId : null,
      team_name: teamName || null,
      player_nickname: playerName,
      nickname: playerName,
      kills: Number.isFinite(kills) ? kills : 0,
      death: Number.isFinite(deaths) ? deaths : 0,
      deaths: Number.isFinite(deaths) ? deaths : 0,
      assists: Number.isFinite(assists) ? assists : 0,
      adr: Number.isFinite(adr) ? adr : null,
      player_rating: Number.isFinite(rating) ? rating : null,
      steam_profile: {
        nickname: playerName,
        player: {
          nickname: playerName,
          team_id: Number.isFinite(teamId) && teamId > 0 ? teamId : null
        }
      }
    };
  });
}

async function fetchPandaScoreRunningMatchesCached({ bypassCache = false } = {}) {
  if (!PANDASCORE_API_TOKEN) {
    return [];
  }
  const now = Date.now();
  const hasFreshCache =
    !bypassCache
    && Number.isFinite(Number(PANDASCORE_RUNNING_MATCHES_CACHE.fetchedAt))
    && (now - Number(PANDASCORE_RUNNING_MATCHES_CACHE.fetchedAt)) < PANDASCORE_RUNNING_MATCHES_CACHE_TTL_MS
    && Array.isArray(PANDASCORE_RUNNING_MATCHES_CACHE.rows);
  if (hasFreshCache) {
    return PANDASCORE_RUNNING_MATCHES_CACHE.rows;
  }
  try {
    let rows = await fetchPandaScoreJson("/csgo/matches/running", { per_page: 50 }, 12000);
    if (!Array.isArray(rows)) {
      rows = await fetchPandaScoreJson("/csgo/matches/running", null, 12000);
    }
    const safeRows = Array.isArray(rows) ? rows : [];
    PANDASCORE_RUNNING_MATCHES_CACHE.fetchedAt = now;
    PANDASCORE_RUNNING_MATCHES_CACHE.rows = safeRows;
    return safeRows;
  } catch {
    return Array.isArray(PANDASCORE_RUNNING_MATCHES_CACHE.rows) ? PANDASCORE_RUNNING_MATCHES_CACHE.rows : [];
  }
}

async function fetchPandaScoreCs2FallbackPayload(options = {}) {
  if (!PANDASCORE_API_TOKEN) {
    return {
      ok: false,
      unavailable: true,
      reason: "Missing PANDASCORE_API_TOKEN"
    };
  }

  const includeLive = options.includeLive === true;
  const bypassCache = options.bypassCache === true;
  const homeName = String(options.homeName || "").trim();
  const awayName = String(options.awayName || "").trim();
  const homeId = Number(options.homeId);
  const awayId = Number(options.awayId);
  const kickoffMs = Number(options.kickoffMs);
  const requestedMatchId = Number(options.matchId);
  const cacheKey = getPandaScoreFallbackCacheKey({
    includeLive,
    matchId: requestedMatchId,
    homeName,
    awayName,
    kickoffMs
  });
  const cacheTtl = includeLive ? PANDASCORE_FALLBACK_LIVE_CACHE_TTL_MS : PANDASCORE_FALLBACK_CACHE_TTL_MS;
  const cached = PANDASCORE_FALLBACK_CACHE.get(cacheKey) || null;
  if (
    !bypassCache
    && cached
    && Number.isFinite(Number(cached.fetchedAt))
    && (Date.now() - Number(cached.fetchedAt)) < cacheTtl
  ) {
    return cached.payload;
  }

  let candidateMatch = null;
  let resolvedMatchId = Number.isFinite(requestedMatchId) && requestedMatchId > 0 ? requestedMatchId : null;
  if (!resolvedMatchId) {
    const runningMatches = await fetchPandaScoreRunningMatchesCached({ bypassCache });
    candidateMatch = pickPandaScoreCandidateMatch(runningMatches, {
      homeName,
      awayName,
      homeId,
      awayId,
      kickoffMs,
      includeLive
    });
    if (!candidateMatch?.id) {
      return {
        ok: false,
        unavailable: true,
        reason: "PandaScore candidate match not found"
      };
    }
    resolvedMatchId = Number(candidateMatch.id);
  }

  if (!Number.isFinite(resolvedMatchId) || resolvedMatchId <= 0) {
    return {
      ok: false,
      unavailable: true,
      reason: "Invalid PandaScore match id"
    };
  }

  try {
    let matchPayload = null;
    try {
      matchPayload = await fetchPandaScoreJson(`/csgo/matches/${resolvedMatchId}`, null, 12000);
    } catch {
      matchPayload = candidateMatch || null;
    }
    if (!matchPayload || typeof matchPayload !== "object") {
      return {
        ok: false,
        unavailable: true,
        reason: "PandaScore match payload unavailable"
      };
    }

    const teams = resolvePandaScoreTeams(matchPayload, {
      homeName,
      awayName,
      homeId,
      awayId
    });
    let gamesPayload = [];
    try {
      const rawGames = await fetchPandaScoreJson(`/csgo/matches/${resolvedMatchId}/games`, { per_page: 10 }, 12000);
      gamesPayload = Array.isArray(rawGames) ? rawGames : [];
    } catch {
      gamesPayload = [];
    }
    const games = extractPandaScoreGamesPayload(matchPayload, gamesPayload);
    const currentGame = resolvePandaScoreCurrentGame(games);
    const currentScore = resolvePandaScoreGameScore(currentGame, teams);
    const currentRoundRaw = Number(currentGame?.current_round ?? currentGame?.round ?? currentGame?.round_number);
    const currentRound = Number.isFinite(currentRoundRaw) && currentRoundRaw > 0 ? currentRoundRaw : null;
    const currentMapName = parsePandaScoreMapName(
      currentGame?.map?.name
      || currentGame?.map?.slug
      || currentGame?.map_name
      || currentGame?.name
      || currentGame?.slug
    );
    const mapPool = collectPandaScoreMapPool(matchPayload, games);
    const response = {
      ok: true,
      source: "pandascore",
      matchId: resolvedMatchId,
      mapPool,
      currentMapName: currentMapName || "",
      currentRound,
      fetchedAt: Date.now(),
      fetchedAtIso: new Date().toISOString()
    };
    if (currentScore) {
      response.mapScoreHome = Number(currentScore.home);
      response.mapScoreAway = Number(currentScore.away);
    }
    const seriesScore = extractPandaScoreSeries(matchPayload, teams);
    if (Number.isFinite(seriesScore.home) && Number.isFinite(seriesScore.away)) {
      response.seriesScoreHome = seriesScore.home;
      response.seriesScoreAway = seriesScore.away;
    }

    if (includeLive) {
      try {
        const rawStats = await fetchPandaScoreJson(`/csgo/matches/${resolvedMatchId}/players/stats`, { per_page: 30 }, 12000);
        const statsRows = Array.isArray(rawStats) ? rawStats : [];
        response.livePlayers = mapPandaScorePlayersStatsRows(statsRows, teams);
      } catch {
        response.livePlayers = [];
      }
    }

    PANDASCORE_FALLBACK_CACHE.set(cacheKey, {
      fetchedAt: Date.now(),
      payload: response
    });
    return response;
  } catch (error) {
    return {
      ok: false,
      unavailable: true,
      reason: String(error?.message || "PandaScore fallback request failed")
    };
  }
}

function extractLiquipediaRolesFromWikitext(wikitext) {
  const text = String(wikitext || "");
  const match = text.match(/^\|roles\s*=\s*([^\r\n]*)/im) || text.match(/^\|role\s*=\s*([^\r\n]*)/im);
  return match ? String(match[1] || "").trim() : "";
}

async function fetchJsonWithTimeout(url, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "LivePulseBetCenter/0.0 (local-proxy)",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "accept-encoding": "gzip, deflate, br"
      }
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithTimeout(url, headers = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "user-agent": "LivePulseBetCenter/0.0 (local-proxy)",
        accept: "application/json, text/plain;q=0.9, */*;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        ...headers
      }
    });
    const text = await response.text();
    return {
      status: response.status,
      text,
      contentType: response.headers.get("content-type") || "application/json; charset=utf-8"
    };
  } finally {
    clearTimeout(timer);
  }
}

function hasTruthySearchFlag(searchParams, ...names) {
  return names.some((name) => {
    const value = String(searchParams.get(name) || "").trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes";
  });
}

function extractOddsPapiRetryDelayMs(rawText) {
  const text = String(rawText || "");
  const retryMsMatch = text.match(/"retryMs"\s*:\s*(\d+)/i);
  if (retryMsMatch) {
    const value = Number.parseInt(retryMsMatch[1], 10);
    if (Number.isFinite(value) && value > 0) {
      return Math.max(15 * 1000, Math.min(value, 30 * 60 * 1000));
    }
  }
  const retryAfterMatch = text.match(/"retryAfter"\s*:\s*"([\d.]+)\s*seconds"/i);
  if (retryAfterMatch) {
    const seconds = Number.parseFloat(retryAfterMatch[1]);
    if (Number.isFinite(seconds) && seconds > 0) {
      const ms = Math.ceil(seconds * 1000);
      return Math.max(15 * 1000, Math.min(ms, 30 * 60 * 1000));
    }
  }
  return 10 * 60 * 1000;
}

function getProxyCacheTtlMs(kind, pathname) {
  const value = String(pathname || "").toLowerCase();
  if (kind === "sportmonks-core") {
    return 6 * 60 * 60 * 1000;
  }
  if (kind === "sportmonks") {
    if (value.includes("/fixtures/date/") || value.includes("/fixtures/between/") || value.includes("/fixtures/")) {
      return 20 * 1000;
    }
    return 2 * 60 * 1000;
  }
  if (kind === "bo3") {
    if (value.includes("/matches") || value.includes("/games")) {
      return 20 * 1000;
    }
    if (value.includes("/players") || value.includes("/teams")) {
      return 10 * 60 * 1000;
    }
    return 5 * 60 * 1000;
  }
  if (kind === "oddspapi") {
    if (value.includes("/odds")) {
      return 20 * 1000;
    }
    if (value.includes("/fixtures")) {
      return 2 * 60 * 1000;
    }
    if (value.includes("/sports")) {
      return 6 * 60 * 60 * 1000;
    }
    return 60 * 1000;
  }
  if (kind === "raw") {
    return 60 * 1000;
  }
  return 0;
}

async function fetchCachedUpstreamText(url, {
  cacheKey = url,
  ttlMs = 0,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  bypassCache = false,
  headers = {}
} = {}) {
  const now = Date.now();
  const cached = UPSTREAM_CACHE.get(cacheKey) || null;
  const isFresh = Boolean(cached && Number.isFinite(Number(cached.fetchedAt)) && now - Number(cached.fetchedAt) < ttlMs);

  if (!bypassCache && ttlMs > 0 && isFresh) {
    return { ...cached, cacheStatus: "hit" };
  }

  if (!bypassCache && ttlMs > 0 && UPSTREAM_INFLIGHT.has(cacheKey)) {
    return UPSTREAM_INFLIGHT.get(cacheKey);
  }

  const requestPromise = (async () => {
    try {
      const response = await fetchTextWithTimeout(url, headers, timeoutMs);
      const shouldUseStale = cached && (response.status === 429 || response.status >= 500);
      if (shouldUseStale) {
        return {
          ...cached,
          stale: true,
          cacheStatus: "stale-upstream",
          upstreamStatus: response.status
        };
      }
      const payload = {
        status: response.status,
        text: response.text,
        contentType: response.contentType,
        fetchedAt: Date.now()
      };
      if (ttlMs > 0 && response.status >= 200 && response.status < 400) {
        UPSTREAM_CACHE.set(cacheKey, payload);
      }
      return {
        ...payload,
        cacheStatus: bypassCache ? "bypass" : "miss"
      };
    } catch (error) {
      if (cached) {
        return {
          ...cached,
          stale: true,
          cacheStatus: "stale-error",
          error: String(error?.message || "Upstream unavailable")
        };
      }
      throw error;
    } finally {
      UPSTREAM_INFLIGHT.delete(cacheKey);
    }
  })();

  if (!bypassCache && ttlMs > 0) {
    UPSTREAM_INFLIGHT.set(cacheKey, requestPromise);
  }

  return requestPromise;
}

async function proxyUpstreamJson(res, upstreamUrl, {
  cacheNamespace,
  cachePathname,
  cacheTtlMs,
  bypassCache = false
} = {}) {
  const ttlMs = Number.isFinite(Number(cacheTtlMs)) ? Number(cacheTtlMs) : 0;
  const response = await fetchCachedUpstreamText(upstreamUrl.toString(), {
    cacheKey: `${cacheNamespace || "upstream"}:${upstreamUrl.toString()}`,
    ttlMs,
    bypassCache
  });
  send(
    res,
    response.status,
    {
      "content-type": response.contentType || "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "cache-control": "no-store",
      "x-proxy-cache": String(response.cacheStatus || "miss"),
      "x-proxy-cache-ttl-ms": String(ttlMs || 0),
      ...(response.stale ? { "x-proxy-stale": "1" } : {}),
      ...(response.upstreamStatus ? { "x-upstream-status": String(response.upstreamStatus) } : {})
    },
    response.text
  );
}

function sendSseMessage(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function buildLiquipediaApiUrl(params) {
  const query = new URLSearchParams();
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") {
      return;
    }
    query.set(key, String(value));
  });
  return `https://liquipedia.net/counterstrike/api.php?${query.toString()}`;
}

async function parseLiquipediaRoleByTitle(title) {
  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) {
    return "";
  }
  const url = buildLiquipediaApiUrl({
    action: "parse",
    page: normalizedTitle,
    prop: "wikitext",
    format: "json",
    redirects: "1"
  });
  const payload = await fetchJsonWithTimeout(url, 12000);
  const wikitext = payload?.parse?.wikitext?.["*"] || "";
  const rawRole = extractLiquipediaRolesFromWikitext(wikitext);
  return normalizeCs2Role(rawRole);
}

async function resolveLiquipediaRole(playerName, slugName) {
  const candidates = [...new Set([String(playerName || "").trim(), String(slugName || "").trim()].filter(Boolean))];
  if (!candidates.length) {
    return { role: "", source: "empty", title: "" };
  }

  for (const title of candidates) {
    const role = await parseLiquipediaRoleByTitle(title);
    if (role) {
      return { role, source: "parse", title };
    }
  }

  const searchedTitles = new Set(candidates.map((value) => value.toLowerCase()));
  for (const term of candidates) {
    const searchUrl = buildLiquipediaApiUrl({
      action: "query",
      list: "search",
      srsearch: term,
      srlimit: "5",
      format: "json"
    });
    const searchPayload = await fetchJsonWithTimeout(searchUrl, 12000);
    const rows = Array.isArray(searchPayload?.query?.search) ? searchPayload.query.search : [];
    for (const row of rows) {
      const title = String(row?.title || "").trim();
      const key = title.toLowerCase();
      if (!title || searchedTitles.has(key)) {
        continue;
      }
      searchedTitles.add(key);
      const role = await parseLiquipediaRoleByTitle(title);
      if (role) {
        return { role, source: "search", title };
      }
    }
  }

  return { role: "", source: "none", title: "" };
}

function getContentType(filePath) {
  const extension = String(path.extname(filePath) || "").toLowerCase();
  const map = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf"
  };
  return map[extension] || "application/octet-stream";
}

function tryServeStatic(pathname, res) {
  const relativePath = String(pathname || "").replace(/^\/+/, "");
  if (!relativePath) {
    return false;
  }

  const filePath = path.resolve(ROOT_DIR, relativePath);
  const relativeFromRoot = path.relative(ROOT_DIR, filePath);
  if (relativeFromRoot.startsWith("..") || path.isAbsolute(relativeFromRoot)) {
    send(res, 403, { "content-type": "text/plain; charset=utf-8" }, "Forbidden");
    return true;
  }

  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      return false;
    }
    const body = fs.readFileSync(filePath);
    send(res, 200, { "content-type": getContentType(filePath) }, body);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || HOST}`);
    const pathname = requestUrl.pathname || "/";

    if (pathname === "/live/stream") {
      if (req.method === "OPTIONS") {
        send(res, 204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const dateKey = String(requestUrl.searchParams.get("date") || "").trim() || new Date().toISOString().slice(0, 10);
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "*",
        "access-control-allow-methods": "GET, OPTIONS"
      });
      if (typeof res.flushHeaders === "function") {
        res.flushHeaders();
      }

      res.write("retry: 5000\n\n");
      sendSseMessage(res, {
        type: "tick",
        dateKey,
        sentAt: new Date().toISOString()
      });

      const tickTimer = setInterval(() => {
        sendSseMessage(res, {
          type: "tick",
          dateKey,
          sentAt: new Date().toISOString()
        });
      }, LIVE_STREAM_TICK_MS);

      const heartbeatTimer = setInterval(() => {
        res.write(`: keepalive ${Date.now()}\n\n`);
      }, LIVE_STREAM_HEARTBEAT_MS);

      req.on("close", () => {
        clearInterval(tickTimer);
        clearInterval(heartbeatTimer);
      });
      return;
    }

    if (pathname === "/liquipedia/role") {
      if (req.method === "OPTIONS") {
        send(res, 204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const playerName = String(requestUrl.searchParams.get("player") || "").trim();
      const slugName = String(requestUrl.searchParams.get("slug") || "").trim();
      const forceRefresh = requestUrl.searchParams.get("refresh") === "1";
      const keys = [...new Set([normalizePlayerKey(playerName), normalizePlayerKey(slugName)].filter(Boolean))];
      if (!keys.length) {
        sendJson(res, 400, { error: "Missing player query param" });
        return;
      }

      const now = Date.now();
      const cache = readJsonFileSafe(LIQUIPEDIA_ROLE_CACHE_PATH, {});
      const safeCache = cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
      const cachedEntry = keys.map((key) => safeCache[key]).find((entry) => entry && typeof entry === "object") || null;
      const cachedRole = normalizeCs2Role(cachedEntry?.role || "");
      const nextRetryAt = Number(cachedEntry?.nextRetryAt) || 0;

      if (!forceRefresh && cachedRole) {
        sendJson(res, 200, {
          player: playerName || slugName,
          role: cachedRole,
          source: "cache",
          cached: true,
          updatedAt: cachedEntry?.updatedAt || null
        });
        return;
      }

      if (!forceRefresh && nextRetryAt > now) {
        sendJson(res, 200, {
          player: playerName || slugName,
          role: cachedRole,
          source: cachedRole ? "cache-cooldown" : "cooldown",
          cached: Boolean(cachedRole),
          retryAt: new Date(nextRetryAt).toISOString()
        });
        return;
      }

      try {
        const resolved = await resolveLiquipediaRole(playerName, slugName);
        const role = normalizeCs2Role(resolved?.role || "");
        const entry = {
          role,
          title: String(resolved?.title || "").trim(),
          source: String(resolved?.source || "liquipedia"),
          updatedAt: new Date().toISOString(),
          nextRetryAt: role ? 0 : now + LIQUIPEDIA_RETRY_COOLDOWN_MS
        };

        keys.forEach((key) => {
          safeCache[key] = entry;
        });
        writeJsonFileSafe(LIQUIPEDIA_ROLE_CACHE_PATH, safeCache);

        sendJson(res, 200, {
          player: playerName || slugName,
          role,
          title: entry.title || null,
          source: role ? "liquipedia" : "liquipedia-empty",
          cached: false,
          updatedAt: entry.updatedAt
        });
      } catch (error) {
        const fallbackEntry = {
          role: cachedRole,
          title: String(cachedEntry?.title || "").trim(),
          source: String(cachedEntry?.source || "cache"),
          updatedAt: cachedEntry?.updatedAt || new Date().toISOString(),
          nextRetryAt: now + LIQUIPEDIA_RETRY_COOLDOWN_MS,
          lastError: String(error?.message || "Liquipedia unavailable")
        };

        keys.forEach((key) => {
          safeCache[key] = fallbackEntry;
        });
        writeJsonFileSafe(LIQUIPEDIA_ROLE_CACHE_PATH, safeCache);

        sendJson(res, 200, {
          player: playerName || slugName,
          role: cachedRole,
          source: cachedRole ? "cache-fallback" : "unavailable",
          cached: Boolean(cachedRole),
          updatedAt: fallbackEntry.updatedAt,
          error: fallbackEntry.lastError
        });
      }
      return;
    }

    if (pathname.startsWith("/hltv/")) {
      if (req.method === "OPTIONS") {
        send(res, 204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const hltvPath = pathname.slice("/hltv".length) || "";
      if (hltvPath === "/cs2-fallback") {
        const includeLive = hasTruthySearchFlag(requestUrl.searchParams, "live", "includeLive");
        const bypassCache = hasTruthySearchFlag(requestUrl.searchParams, "refresh", "_refresh", "bypassCache");
        const payload = await fetchHltvCs2FallbackPayload({
          includeLive,
          bypassCache,
          matchId: requestUrl.searchParams.get("matchId"),
          homeName: requestUrl.searchParams.get("homeName"),
          awayName: requestUrl.searchParams.get("awayName"),
          homeId: requestUrl.searchParams.get("homeId"),
          awayId: requestUrl.searchParams.get("awayId"),
          kickoffMs: requestUrl.searchParams.get("kickoffMs")
        });
        sendJson(res, 200, payload);
        return;
      }

      sendJson(res, 400, { error: "Missing HLTV path. Try /hltv/cs2-fallback" });
      return;
    }

    if (pathname.startsWith("/pandascore/")) {
      if (req.method === "OPTIONS") {
        send(res, 204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const pandaPath = pathname.slice("/pandascore".length) || "";
      if (pandaPath === "/cs2-fallback") {
        const includeLive = hasTruthySearchFlag(requestUrl.searchParams, "live", "includeLive");
        const bypassCache = hasTruthySearchFlag(requestUrl.searchParams, "refresh", "_refresh", "bypassCache");
        const payload = await fetchPandaScoreCs2FallbackPayload({
          includeLive,
          bypassCache,
          matchId: requestUrl.searchParams.get("matchId"),
          homeName: requestUrl.searchParams.get("homeName"),
          awayName: requestUrl.searchParams.get("awayName"),
          homeId: requestUrl.searchParams.get("homeId"),
          awayId: requestUrl.searchParams.get("awayId"),
          kickoffMs: requestUrl.searchParams.get("kickoffMs")
        });
        sendJson(res, 200, payload);
        return;
      }

      sendJson(res, 400, { error: "Missing PandaScore path. Try /pandascore/cs2-fallback" });
      return;
    }

    if (pathname.startsWith("/bo3/")) {
      if (req.method === "OPTIONS") {
        send(res, 204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const bo3Path = pathname.slice("/bo3".length) || "";
      if (!bo3Path || bo3Path === "/") {
        sendJson(res, 400, { error: "Missing BO3 path. Try /bo3/matches" });
        return;
      }

      const bypassCache = hasTruthySearchFlag(requestUrl.searchParams, "refresh", "_refresh", "bypassCache");
      const upstreamUrl = new URL(`${BO3_BASE}${bo3Path}`);
      for (const [key, value] of requestUrl.searchParams.entries()) {
        if (key === "refresh" || key === "_refresh" || key === "bypassCache") {
          continue;
        }
        upstreamUrl.searchParams.append(key, value);
      }
      await proxyUpstreamJson(res, upstreamUrl, {
        cacheNamespace: "bo3",
        cacheTtlMs: getProxyCacheTtlMs("bo3", bo3Path),
        bypassCache
      });
      return;
    }

    if (pathname.startsWith("/oddspapi/")) {
      if (req.method === "OPTIONS") {
        send(res, 204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const oddsPath = pathname.slice("/oddspapi".length) || "";
      if (!oddsPath || oddsPath === "/") {
        sendJson(res, 400, { error: "Missing OddsPapi path. Try /oddspapi/fixtures" });
        return;
      }
      const normalizedOddsPath = String(oddsPath || "").toLowerCase();
      const rateLimitUntil = Number(ODDSPAPI_RATE_LIMIT_STATE.get(normalizedOddsPath) || 0);
      if (rateLimitUntil > Date.now()) {
        sendJson(res, 200, {
          data: [],
          unavailable: true,
          reason: "OddsPapi rate-limit cooldown",
          retryAt: new Date(rateLimitUntil).toISOString()
        });
        return;
      }

      const apiKey = String(ODDSPAPI_API_KEY || "").trim();
      if (!apiKey) {
        sendJson(res, 200, {
          data: [],
          unavailable: true,
          reason: "Missing ODDSPAPI_API_KEY"
        });
        return;
      }

      const bypassCache = hasTruthySearchFlag(requestUrl.searchParams, "refresh", "_refresh", "bypassCache");
      const upstreamUrl = new URL(`${ODDSPAPI_BASE}${oddsPath}`);
      for (const [key, value] of requestUrl.searchParams.entries()) {
        if (key.toLowerCase() === "apikey" || key === "refresh" || key === "_refresh" || key === "bypassCache") {
          continue;
        }
        upstreamUrl.searchParams.append(key, value);
      }
      upstreamUrl.searchParams.set("apiKey", apiKey);
      const cacheTtlMs = getProxyCacheTtlMs("oddspapi", oddsPath);
      const upstreamResponse = await fetchCachedUpstreamText(upstreamUrl.toString(), {
        cacheKey: `oddspapi:${upstreamUrl.toString()}`,
        ttlMs: cacheTtlMs,
        bypassCache
      });
      if (upstreamResponse.status >= 400) {
        if (upstreamResponse.status === 429) {
          const retryDelayMs = extractOddsPapiRetryDelayMs(upstreamResponse.text);
          ODDSPAPI_RATE_LIMIT_STATE.set(normalizedOddsPath, Date.now() + retryDelayMs);
        }
        sendJson(res, 200, {
          data: [],
          unavailable: true,
          reason: `OddsPapi upstream HTTP ${upstreamResponse.status}`,
          upstreamStatus: upstreamResponse.status,
          cacheStatus: upstreamResponse.cacheStatus || "miss"
        });
        return;
      }
      send(
        res,
        upstreamResponse.status,
        {
          "content-type": upstreamResponse.contentType || "application/json; charset=utf-8",
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "cache-control": "no-store",
          "x-proxy-cache": String(upstreamResponse.cacheStatus || "miss"),
          "x-proxy-cache-ttl-ms": String(cacheTtlMs || 0),
          ...(upstreamResponse.stale ? { "x-proxy-stale": "1" } : {}),
          ...(upstreamResponse.upstreamStatus ? { "x-upstream-status": String(upstreamResponse.upstreamStatus) } : {})
        },
        upstreamResponse.text
      );
      if (ODDSPAPI_RATE_LIMIT_STATE.has(normalizedOddsPath)) {
        ODDSPAPI_RATE_LIMIT_STATE.delete(normalizedOddsPath);
      }
      return;
    }

    if (pathname.startsWith("/sportmonks-core/")) {
      if (req.method === "OPTIONS") {
        send(res, 204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const token = String(SPORTMONKS_API_TOKEN || "").trim();
      if (!token) {
        sendJson(res, 500, { error: "Missing SPORTMONKS_API_TOKEN" });
        return;
      }

      const bypassCache = hasTruthySearchFlag(requestUrl.searchParams, "refresh", "_refresh", "bypassCache");
      const sportMonksPath = pathname.slice("/sportmonks-core".length) || "";
      if (!sportMonksPath || sportMonksPath === "/") {
        sendJson(res, 400, { error: "Missing SportMonks core path. Try /sportmonks-core/types" });
        return;
      }

      const upstreamUrl = new URL(`${SPORTMONKS_CORE_BASE}${sportMonksPath}`);
      for (const [key, value] of requestUrl.searchParams.entries()) {
        if (key.toLowerCase() === "api_token" || key === "refresh" || key === "_refresh" || key === "bypassCache") {
          continue;
        }
        upstreamUrl.searchParams.append(key, value);
      }
      upstreamUrl.searchParams.set("api_token", token);
      await proxyUpstreamJson(res, upstreamUrl, {
        cacheNamespace: "sportmonks-core",
        cacheTtlMs: getProxyCacheTtlMs("sportmonks-core", sportMonksPath),
        bypassCache
      });
      return;
    }

    if (pathname.startsWith("/sportmonks/")) {
      if (req.method === "OPTIONS") {
        send(res, 204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const token = String(SPORTMONKS_API_TOKEN || "").trim();
      if (!token) {
        sendJson(res, 500, { error: "Missing SPORTMONKS_API_TOKEN" });
        return;
      }

      const bypassCache = hasTruthySearchFlag(requestUrl.searchParams, "refresh", "_refresh", "bypassCache");
      const sportMonksPath = pathname.slice("/sportmonks".length) || "";
      if (!sportMonksPath || sportMonksPath === "/") {
        sendJson(res, 400, { error: "Missing SportMonks path. Try /sportmonks/fixtures" });
        return;
      }

      const upstreamUrl = new URL(`${SPORTMONKS_BASE}${sportMonksPath}`);
      for (const [key, value] of requestUrl.searchParams.entries()) {
        if (key.toLowerCase() === "api_token" || key === "refresh" || key === "_refresh" || key === "bypassCache") {
          continue;
        }
        upstreamUrl.searchParams.append(key, value);
      }
      upstreamUrl.searchParams.set("api_token", token);
      await proxyUpstreamJson(res, upstreamUrl, {
        cacheNamespace: "sportmonks",
        cacheTtlMs: getProxyCacheTtlMs("sportmonks", sportMonksPath),
        bypassCache
      });
      return;
    }

    if (pathname === "/raw") {
      if (req.method === "OPTIONS") {
        send(res, 204, {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET, OPTIONS",
          "access-control-max-age": "86400"
        });
        return;
      }

      if (req.method !== "GET") {
        sendJson(res, 405, { error: "Method not allowed" });
        return;
      }

      const rawUrl = requestUrl.searchParams.get("url") || "";
      if (!rawUrl) {
        sendJson(res, 400, { error: "Missing url param" });
        return;
      }

      let target;
      try {
        target = new URL(rawUrl);
      } catch {
        sendJson(res, 400, { error: "Invalid url param" });
        return;
      }

      if (target.protocol !== "http:" && target.protocol !== "https:") {
        sendJson(res, 400, { error: "Unsupported protocol" });
        return;
      }
      const bypassCache = hasTruthySearchFlag(requestUrl.searchParams, "refresh", "_refresh", "bypassCache");
      await proxyUpstreamJson(res, target, {
        cacheNamespace: "raw",
        cacheTtlMs: getProxyCacheTtlMs("raw", target.pathname),
        bypassCache
      });
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      const html = fs.readFileSync(INDEX_PATH, "utf8");
      send(res, 200, { "content-type": "text/html; charset=utf-8" }, html);
      return;
    }

    if (pathname === "/favicon.ico") {
      send(res, 204, { "cache-control": "public, max-age=86400" }, "");
      return;
    }

    if (tryServeStatic(pathname, res)) {
      return;
    }

    send(res, 404, { "content-type": "text/plain; charset=utf-8" }, "Not found");
  } catch (error) {
    sendJson(res, 500, { error: error?.message || "Internal error" });
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    // eslint-disable-next-line no-console
    console.error(`Port already in use: ${HOST}:${PORT}`);
    // eslint-disable-next-line no-console
    console.error(`If the proxy is already running, open: http://${HOST}:${PORT}/`);
    // eslint-disable-next-line no-console
    console.error("To stop it, find the PID and kill it:");
    // eslint-disable-next-line no-console
    console.error(`  netstat -ano | findstr :${PORT}`);
    // eslint-disable-next-line no-console
    console.error("  taskkill /PID <pid> /F");
    // eslint-disable-next-line no-console
    console.error("Or run this server on another port:");
    // eslint-disable-next-line no-console
    console.error(`  $env:PORT=${DEFAULT_PORT + 1}; node server.js`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.error(error);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : PORT;
  // eslint-disable-next-line no-console
  console.log(`Local proxy running: http://${HOST}:${actualPort}/`);
});

