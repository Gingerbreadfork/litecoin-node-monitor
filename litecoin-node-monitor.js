#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const https = require("https");
const readline = require("readline");

// Auto-config Setup
const SCRIPT_DIR = path.dirname(process.argv[1]);

const CONFIG = {
  DATA_DIR: detectDataDir(SCRIPT_DIR),
  RPC: detectRpcConfig(SCRIPT_DIR),
  REFRESH_INTERVAL: 1000,
};

// Color handling
const isTTY = process.stdout.isTTY;
const noColor = !!process.env.NO_COLOR || !isTTY;
const C = (code) => (noColor ? "" : code);
const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
};

function detectDataDir(baseDir) {
  const candidates = [
    path.join(os.homedir(), ".litecoin"),
    path.join(baseDir, "data"),
    path.join(baseDir, "..", "data"),
    path.join(baseDir, "..", "..", "data"),
  ];
  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, "litecoin.conf")) ||
      fs.existsSync(path.join(dir, ".cookie"))
    ) {
      return dir;
    }
  }
  console.error(
    `${C(colors.red)}❌ No valid datadir found (expected a ".litecoin" folder in home or a "data/" folder with litecoin.conf or .cookie)${C(colors.reset)}`,
  );
  process.exit(1);
}

function parseConf(confPath) {
  const out = {};
  if (!fs.existsSync(confPath)) return out;
  const lines = fs.readFileSync(confPath, "utf8").split("\n");
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    out[k] = v;
  }
  return out;
}

function detectRpcConfig(baseDir) {
  const datadir = detectDataDir(baseDir);
  const confPath = path.join(datadir, "litecoin.conf");
  const conf = parseConf(confPath);

  const chain =
    (conf.testnet === "1" && "testnet4") ||
    (conf.regtest === "1" && "regtest") ||
    "mainnet";

  const chainCookieDir =
    chain === "mainnet" ? datadir : path.join(datadir, chain);

  let auth = null;
  const cookieCandidates = [
    path.join(chainCookieDir, ".cookie"),
    path.join(datadir, ".cookie"), // fallback for older setups
  ];
  let cookiePath = null;
  for (const p of cookieCandidates) {
    if (fs.existsSync(p)) {
      cookiePath = p;
      break;
    }
  }
  if (cookiePath) {
    const [user, pass] = fs.readFileSync(cookiePath, "utf8").trim().split(":");
    auth = { user, pass, source: "cookie" };
  } else if (conf.rpcuser && conf.rpcpassword) {
    auth = { user: conf.rpcuser, pass: conf.rpcpassword, source: "conf" };
  } else {
    auth = { user: null, pass: null, source: "none" };
  }

  const defaults = {
    mainnet: 9332,
    testnet4: 19332,
    regtest: 19443,
  };

  const host = conf.rpcconnect || "127.0.0.1";
  const port = Number(conf.rpcport || defaults[chain] || 9332);
  const useHttps = String(conf.rpcssl).toLowerCase() === "true";

  return { host, port, useHttps, auth, chain, confPath, cookiePath };
}

// JSON-RPC client with keep-alive, backoff, and last-good caching
const httpAgent = new http.Agent({ keepAlive: true });
const httpsAgent = new https.Agent({ keepAlive: true });

const rpcState = {
  backoff: new Map(), // method -> { delayMs, nextAt, lastError }
  lastGood: new Map(), // method -> result
};

async function rpcCallRaw(method, params = [], { timeoutMs = 6000 } = {}) {
  const payload = JSON.stringify({
    jsonrpc: "1.0",
    id: "ltc-monitor",
    method,
    params,
  });

  const { host, port, useHttps, auth } = CONFIG.RPC;
  if (!auth.user || !auth.pass) {
    throw new Error(
      "RPC auth missing. Provide litecoin.conf rpcuser/rpcpassword or .cookie.",
    );
  }
  const mod = useHttps ? https : http;
  const agent = useHttps ? httpsAgent : httpAgent;
  const headers = {
    "Content-Type": "application/json",
    Authorization:
      "Basic " + Buffer.from(`${auth.user}:${auth.pass}`).toString("base64"),
    "Content-Length": Buffer.byteLength(payload),
  };

  return new Promise((resolve, reject) => {
    const req = mod.request(
      { host, port, method: "POST", path: "/", headers, agent },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const j = JSON.parse(data || "{}");
            if (j.error) return reject(new Error(j.error.message));
            resolve(j.result);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("RPC timeout"));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

async function executeRPC(method, params = [], opts = {}) {
  const now = Date.now();
  const b = rpcState.backoff.get(method) || {
    delayMs: 0,
    nextAt: 0,
    lastError: null,
  };

  if (now < b.nextAt) {
    if (rpcState.lastGood.has(method)) {
      return rpcState.lastGood.get(method);
    }
    throw b.lastError || new Error("Backoff in effect");
  }

  try {
    const res = await rpcCallRaw(method, params, opts);
    rpcState.lastGood.set(method, res);
    if (b.delayMs !== 0) rpcState.backoff.delete(method);
    return res;
  } catch (err) {
    const nextDelay = b.delayMs === 0 ? 1000 : Math.min(b.delayMs * 2, 30000);
    const nextAt = now + nextDelay;
    rpcState.backoff.set(method, {
      delayMs: nextDelay,
      nextAt,
      lastError: err,
    });
    if (rpcState.lastGood.has(method)) {
      return rpcState.lastGood.get(method);
    }
    throw err;
  }
}

function ltcPerKvBToLitoshiPerVb(rate) {
  if (rate == null || isNaN(rate)) return "N/A";
  return Math.round(rate * 1e5);
}


// Monitor

class LitecoinNodeMonitor {
  constructor() {
    this.metrics = {
      connections: 0,
      inbound: 0,
      outbound: 0,
      blocks: 0,
      headers: 0,
      syncProgress: 0,
      difficulty: 0,
      mempool: 0,
      mempoolSize: 0,
      mempoolFees: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      totalDownloaded: 0n,
      totalUploaded: 0n,
      verificationProgress: 0,
      estimatedTimeLeft: 0,
      chainWork: "",
      bestBlockHash: "",
      medianTime: 0,
      warnings: "",
      avgBlockTime: 0,
      nodeUptime: 0,
      chainSize: 0,
      prunedHeight: 0,
      networkhashps: 0,
      feeEstimate: { fast: 0, medium: 0, slow: 0 },
      peers: [],
      bannedCount: 0,
      version: "",
      protocolVersion: 0,
      chain: CONFIG.RPC.chain || "",
      circulatingSupply: 0,
      blockReward: 0,
      nextHalvingBlock: 0,
      estimatedHalvingDate: "",
      blockIntervals: { min: 0, max: 0, median: 0 },
      chainTips: { totalTips: 0, orphanCount: 0, hasForks: false },
      timeSinceLastBlock: 0,
      lastBlockTime: 0,
    };

    this.history = {
      maxDownloadSpeed: 0,
      maxUploadSpeed: 0,
      maxConnections: 0,
      startTime: Date.now(),
      lastBlockCount: 0,
      lastUpdate: Date.now(),
      blockTimes: [],
      syncStartBlock: 0,
      lastBlockIntervalUpdate: 0,
      lastBlockSeenAt: 0,
    };

    this._hdrCache = new Map();

    this.displayInterval = null;
    this.frames = 0;
    this.spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    this._cursorHidden = false;
    this._lastMempoolFeeAt = 0;

    // Chikun animation state
    this.chikun = { active: false, start: 0 };

    this.cleanup = this.cleanup.bind(this);
  }

  async init() {
    this.printHeader();

    process.on("SIGINT", this.cleanup);
    process.on("SIGTERM", this.cleanup);

    const startTime = Date.now();

    await this.testConnection();

    // Enforce at least 2 seconds from header print to monitoring start
    const elapsed = Date.now() - startTime;
    if (elapsed < 2000) {
      await this.sleep(2000 - elapsed);
    }

    this.startMonitoring();
  }

  printHeader() {
    // Clear the screen for a clean start
    process.stdout.write("\x1b[2J\x1b[0;0H");

    const blue = C(colors.blue);
    const cyan = C(colors.cyan);
    const yellow = C(colors.yellow);
    const reset = C(colors.reset);
    const logo = `${cyan}

    ${blue}██╗     ██╗████████╗███████╗ ██████╗ ██████╗ ██╗███╗   ██╗${cyan}
    ${blue}██║     ██║╚══██╔══╝██╔════╝██╔════╝██╔═══██╗██║████╗  ██║${cyan}
    ${blue}██║     ██║   ██║   █████╗  ██║     ██║   ██║██║██╔██╗ ██║${cyan}
    ${blue}██║     ██║   ██║   ██╔══╝  ██║     ██║   ██║██║██║╚██╗██║${cyan}
    ${blue}███████╗██║   ██║   ███████╗╚██████╗╚██████╔╝██║██║ ╚████║${cyan}
    ${blue}╚══════╝╚═╝   ╚═╝   ╚══════╝ ╚═════╝ ╚═════╝ ╚═╝╚═╝  ╚═══╝${cyan}

             ${yellow}⚡ ADVANCED NODE MONITOR v1.0 ⚡${cyan}
  ${reset}

  `;

    // Print the main header
    process.stdout.write(logo);
    process.stdout.write("\n"); // just to reset spacing

    const configInfo = [
      `📁 Datadir: ${CONFIG.DATA_DIR}`,
      `🔌 RPC: ${CONFIG.RPC.host}:${CONFIG.RPC.port} (${CONFIG.RPC.useHttps ? "https" : "http"})`,
      `🔐 Auth: ${CONFIG.RPC.auth.source === "cookie"
        ? "Cookie authentication"
        : CONFIG.RPC.auth.source === "conf"
          ? "RPC credentials"
          : "Not configured"
      }`,
    ];

    configInfo.forEach((line) => process.stdout.write(line + "\n"));
    process.stdout.write("\n");
  }

  async testConnection() {
    process.stdout.write("🔄 Establishing connection to Litecoin node...\n");
    try {
      const info = await executeRPC("getblockchaininfo");
      if (info && info.blocks !== undefined) {
        process.stdout.write(
          `${C(colors.green)}✅ Connected! Chain: ${info.chain} | Height: ${Number(
            info.blocks,
          ).toLocaleString()}${C(colors.reset)}\n`,
        );
        this.metrics.chain = info.chain;
        this.history.syncStartBlock = info.blocks;
        await this.sleep(500);
        return;
      }
      throw new Error("Unexpected RPC response");
    } catch (error) {
      process.stdout.write(
        `${C(colors.red)}❌ Connection failed: ${error.message}${C(colors.reset)}\n`,
      );
      process.exit(1);
    }
  }

  startMonitoring() {
    if (isTTY && !this._cursorHidden) {
      process.stdout.write("\x1b[?25l");
      this._cursorHidden = true;
    }

    this.displayInterval = setInterval(async () => {
      try {
        const calls = [
          executeRPC("getblockchaininfo"),
          executeRPC("getnettotals"),
          executeRPC("getpeerinfo"),
          executeRPC("getmempoolinfo"),
          executeRPC("getnetworkinfo"),
          executeRPC("getmininginfo"),
          executeRPC("uptime"),
          executeRPC("estimatesmartfee", [2, "ECONOMICAL"]),
          executeRPC("estimatesmartfee", [6, "ECONOMICAL"]),
          executeRPC("estimatesmartfee", [12, "ECONOMICAL"]),
        ];

        const settled = await Promise.allSettled(calls);
        const pick = (i) =>
          settled[i] && settled[i].status === "fulfilled"
            ? settled[i].value
            : null;

        const blockchain = pick(0);
        const netTotals = pick(1);
        const peerInfo = pick(2);
        const mempool = pick(3);
        const netInfo = pick(4);
        const mining = pick(5);
        const uptime = pick(6);
        const fee2 = pick(7);
        const fee6 = pick(8);
        const fee12 = pick(9);

        if (blockchain) {
          this.metrics.blocks = blockchain.blocks || 0;
          this.metrics.headers =
            typeof blockchain.headers === "number" ? blockchain.headers : 0;
          const headers = Math.max(1, this.metrics.headers || 1);
          this.metrics.verificationProgress =
            blockchain.verificationprogress || 0;
          this.metrics.difficulty = blockchain.difficulty || 0;
          this.metrics.medianTime = blockchain.mediantime || 0;
          this.metrics.chainWork = blockchain.chainwork || "";
          this.metrics.bestBlockHash = blockchain.bestblockhash || "";
          this.metrics.warnings = blockchain.warnings || "";
          this.metrics.chainSize = blockchain.size_on_disk || 0;
          this.metrics.prunedHeight = blockchain.pruneheight || 0;

          this.metrics.syncProgress = Math.min(
            100,
            Math.max(0, (this.metrics.blocks / headers) * 100),
          );

          if (
            this.history.lastBlockCount &&
            this.metrics.blocks > this.history.lastBlockCount
          ) {
            // record local arrival (seconds)
            this.history.lastBlockSeenAt = Math.floor(Date.now() / 1000);

            // update moving average of block times
            const blockTime =
              (Date.now() - this.history.lastUpdate) /
              1000 /
              (this.metrics.blocks - this.history.lastBlockCount);
            this.history.blockTimes.push(blockTime);
            if (this.history.blockTimes.length > 10)
              this.history.blockTimes.shift();
            this.metrics.avgBlockTime =
              this.history.blockTimes.reduce((a, b) => a + b, 0) /
              this.history.blockTimes.length;

            this.triggerChikun();
          }

          this.history.lastBlockCount = this.metrics.blocks;
          this.history.lastUpdate = Date.now();

          const now = Date.now();
          if (now - this.history.lastBlockIntervalUpdate > 30000) {
            try {
              this.metrics.blockIntervals =
                await this.getRecentBlockIntervals(20);
            } catch { }
            this.history.lastBlockIntervalUpdate = now;
          }

          this.calculateHalvingStats();

          try {
            this.metrics.chainTips = await this.getChainTipsStats();
          } catch { }
        }

        if (netTotals) {
          const prevDownload = this.metrics.totalDownloaded;
          const prevUpload = this.metrics.totalUploaded;

          this.metrics.totalDownloaded = BigInt(netTotals.totalbytesrecv || 0);
          this.metrics.totalUploaded = BigInt(netTotals.totalbytessent || 0);

          if (prevDownload > 0n || prevUpload > 0n) {
            const dlDelta =
              Number(this.metrics.totalDownloaded - prevDownload) /
              (CONFIG.REFRESH_INTERVAL / 1000);
            const upDelta =
              Number(this.metrics.totalUploaded - prevUpload) /
              (CONFIG.REFRESH_INTERVAL / 1000);

            this.metrics.downloadSpeed = Math.max(0, dlDelta);
            this.metrics.uploadSpeed = Math.max(0, upDelta);

            this.history.maxDownloadSpeed = Math.max(
              this.history.maxDownloadSpeed,
              this.metrics.downloadSpeed,
            );
            this.history.maxUploadSpeed = Math.max(
              this.history.maxUploadSpeed,
              this.metrics.uploadSpeed,
            );
          }
        }

        if (Array.isArray(peerInfo)) {
          this.metrics.peers = peerInfo.map((p) => ({
            addr: p.addr || "",
            inbound: !!p.inbound,
            pingtime:
              typeof p.pingtime === "number" ? p.pingtime : (p.minping ?? 0),
            synced_blocks:
              typeof p.synced_blocks === "number" ? p.synced_blocks : 0,
            subver: p.subver || "",
          }));
          this.metrics.connections = peerInfo.length;
          this.metrics.inbound = peerInfo.filter((p) => p.inbound).length;
          this.metrics.outbound = peerInfo.filter((p) => !p.inbound).length;
          this.history.maxConnections = Math.max(
            this.history.maxConnections,
            this.metrics.connections,
          );
        }

        if (mempool) {
          this.metrics.mempool = mempool.size || 0;
          this.metrics.mempoolSize = mempool.bytes || 0;

          if (typeof mempool.total_fee === "number") {
            this.metrics.mempoolFees = mempool.total_fee;
          } else {
            if (
              !this._lastMempoolFeeAt ||
              Date.now() - this._lastMempoolFeeAt > 30000
            ) {
              try {
                this.metrics.mempoolFees = await this.getMempoolTotalFeesSafe({
                  limit: 5000,
                  timeoutMs: 4000,
                });
              } catch { }
              this._lastMempoolFeeAt = Date.now();
            }
          }
        }

        if (netInfo) {
          this.metrics.version = netInfo.subversion || "";
          this.metrics.protocolVersion = netInfo.protocolversion || 0;
        }
        if (mining) {
          this.metrics.networkhashps = mining.networkhashps || 0;
        }

        if (typeof uptime === "number") {
          this.metrics.nodeUptime = uptime;
        }

        const fast = fee2 && fee2.feerate !== undefined ? fee2.feerate : null;
        const medium = fee6 && fee6.feerate !== undefined ? fee6.feerate : fast;
        const slow =
          fee12 && fee12.feerate !== undefined ? fee12.feerate : medium;
        if (fast != null) this.metrics.feeEstimate = { fast, medium, slow };

        if (this.metrics.bestBlockHash) {
          try {
            const header = await this.getHeader(this.metrics.bestBlockHash);
            this.updateTimeSinceLastBlock(header); // seed-once from miner, then prefer local
          } catch {
            this.updateTimeSinceLastBlock(null); // fallback to local timer if available
          }
        } else {
          this.updateTimeSinceLastBlock(null);
        }

        if (this.metrics.syncProgress < 100 && this.metrics.avgBlockTime > 0) {
          const blocksLeft = Math.max(
            0,
            (this.metrics.headers || 0) - (this.metrics.blocks || 0),
          );
          this.metrics.estimatedTimeLeft =
            blocksLeft * this.metrics.avgBlockTime;
        } else {
          this.metrics.estimatedTimeLeft = 0;
        }

        this.updateDisplay();
      } catch {
        this.updateDisplay();
      }
    }, CONFIG.REFRESH_INTERVAL);
  }

  async getHeader(hash) {
    if (this._hdrCache.has(hash)) return this._hdrCache.get(hash);
    const h = await executeRPC("getblockheader", [hash]);
    this._hdrCache.set(hash, h);
    if (this._hdrCache.size > 100) {
      const first = this._hdrCache.keys().next().value;
      this._hdrCache.delete(first);
    }
    return h;
  }

  async getMempoolTotalFeesSafe({ limit = 5000, timeoutMs = 4000 } = {}) {
    try {
      const start = Date.now();
      const verbose = await executeRPC("getrawmempool", [true], { timeoutMs });

      let total = 0,
        count = 0;
      for (const txid in verbose) {
        const e = verbose[txid];

        total +=
          e && e.fees && typeof e.fees.base === "number"
            ? e.fees.base
            : typeof e.fee === "number"
              ? e.fee
              : 0;

        if (++count >= limit) break;
        if (Date.now() - start > timeoutMs) break;
      }
      return total; // in LTC
    } catch {
      return this.metrics.mempoolFees || 0;
    }
  }

  async getRecentBlockIntervals(count = 20) {
    const intervals = [];
    try {
      const latestHeight = this.metrics.blocks;
      const timestamps = [];
      for (let i = 0; i < count + 1; i++) {
        if (latestHeight - i < 0) break;
        const hash = await executeRPC("getblockhash", [latestHeight - i]);
        const block = await executeRPC("getblock", [hash]);
        timestamps.push(block.time);
      }
      for (let i = 0; i < timestamps.length - 1; i++) {
        intervals.push(timestamps[i] - timestamps[i + 1]);
      }
      if (intervals.length === 0) return { min: 0, max: 0, median: 0 };
      const sorted = [...intervals].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      return {
        min: Math.min(...intervals),
        max: Math.max(...intervals),
        median,
      };
    } catch {
      return { min: 0, max: 0, median: 0 };
    }
  }

  // Prefer local-arrival timer; seed once from miner time at launch
  updateTimeSinceLastBlock(header) {
    // keep chain timestamp for display/reference
    if (header && typeof header.time === "number") {
      this.metrics.lastBlockTime = header.time; // seconds
      // seed once on first loop from miner time
      if (!this.history.lastBlockSeenAt) {
        this.history.lastBlockSeenAt = this.metrics.lastBlockTime; // seconds
      }
    }

    const nowSec = Math.floor(Date.now() / 1000);

    if (this.history.lastBlockSeenAt) {
      // normal path after startup: local-arrival clock
      this.metrics.timeSinceLastBlock = Math.max(
        0,
        nowSec - this.history.lastBlockSeenAt,
      );
    } else if (this.metrics.lastBlockTime) {
      // fallback only before we’ve seen a new block locally
      this.metrics.timeSinceLastBlock = Math.max(
        0,
        nowSec - this.metrics.lastBlockTime,
      );
    } else {
      this.metrics.timeSinceLastBlock = 0;
    }
  }

  async calculateHalvingStats() {
    const blocksPerHalving = 840000;
    const targetSPB = 150; // seconds per block (Litecoin target)
    const currentBlock = this.metrics.blocks || 0;

    // Reward & next halving height
    let reward = 50;
    let tmp = currentBlock;
    let eras = 0;
    while (tmp >= blocksPerHalving && reward > 0) {
      tmp -= blocksPerHalving;
      reward /= 2;
      eras++;
    }
    this.metrics.blockReward = reward;
    this.metrics.nextHalvingBlock = (eras + 1) * blocksPerHalving;

    // Circulating supply (era sum)
    let supply = 0;
    for (let i = 0; i <= eras; i++) {
      const eraReward = 50 / Math.pow(2, i);
      const eraBlocks = (i === eras) ? (currentBlock % blocksPerHalving) : blocksPerHalving;
      supply += eraBlocks * eraReward;
    }
    this.metrics.circulatingSupply = Math.min(84_000_000, supply);

    // ETA using target schedule only
    if (this._lastHalvingEtaHeight === currentBlock) return; // no change since last tick
    this._lastHalvingEtaHeight = currentBlock;

    const blocksLeft = this.metrics.nextHalvingBlock - currentBlock;
    if (blocksLeft <= 0) {
      this.metrics.estimatedHalvingDate = "Past";
      return;
    }

    const secondsLeft = blocksLeft * targetSPB; // purely target-based
    const eta = new Date(Date.now() + secondsLeft * 1000);
    this.metrics.estimatedHalvingDate = eta.toLocaleDateString("en-US", {
      year: "numeric", month: "long", day: "numeric",
    });
  }

  async getChainTipsStats() {
    const ORPHAN_STATUSES = new Set(["valid-fork", "valid-headers"]);

    const compute = (tips) => {
      // Normalize status strings
      const norm = Array.isArray(tips)
        ? tips.map((t) => ({
          ...t,
          status: String(t.status || "").toLowerCase(),
        }))
        : [];

      // Count only valid forks/headers as "orphans"
      const orphanTips = norm.filter((t) => ORPHAN_STATUSES.has(t.status));

      // Flag if there's any valid fork
      const hasForks = norm.some((t) => t.status === "valid-fork");

      const breakdown = norm.reduce((acc, t) => {
        acc[t.status] = (acc[t.status] || 0) + 1;
        return acc;
      }, {});

      return {
        totalTips: norm.length,
        orphanCount: orphanTips.length,
        hasForks,
        breakdown,
      };
    };

    try {
      const tips = await executeRPC("getchaintips");
      return compute(tips);
    } catch {
      const last = rpcState.lastGood.get("getchaintips");
      if (last) return compute(last);
      return { totalTips: 0, orphanCount: 0, hasForks: false, breakdown: {} };
    }
  }

  updateDisplay() {
    this.frames++;
    const spinner = this.spinners[this.frames % this.spinners.length];

    let out = "";
    out += this.getSyncHeader(spinner);
    out += this.getMetricsDashboard();
    out += this.getPeersTable();
    out += this.getFooter();

    if (isTTY) {
      readline.cursorTo(process.stdout, 0, 0);
      readline.clearScreenDown(process.stdout);
      process.stdout.write(out);
    } else {
      process.stdout.write("\n" + out + "\n");
    }
  }

  getSyncHeader(spinner) {
    let header = "";
    const syncPercent = this.metrics.syncProgress.toFixed(2);
    const isSynced = this.metrics.syncProgress >= 99.99;

    if (isSynced) {
      header += `${C(colors.green)}${C(
        colors.bright,
      )}✅ FULLY SYNCED${C(colors.reset)} `;
      header += `${C(colors.dim)}Block ${Number(
        this.metrics.blocks || 0,
      ).toLocaleString()}${C(colors.reset)}\n`;
    } else {
      header += `${C(colors.yellow)}${spinner} SYNCING${C(colors.reset)} `;
      header +=
        this.getProgressBar(this.metrics.syncProgress) + ` ${syncPercent}%\n`;

      if (this.metrics.estimatedTimeLeft > 0) {
        header += `${C(colors.dim)}ETA: ${this.formatTime(
          this.metrics.estimatedTimeLeft,
        )}${C(colors.reset)}\n`;
      }
    }

    header += `${C(colors.dim)}${"─".repeat(70)}${C(colors.reset)}\n`;
    return header;
  }

  getMetricsDashboard() {
    let dashboard = "";

    dashboard += `${C(colors.cyan)}📦 BLOCKCHAIN${C(colors.reset)}\n`;

    dashboard += `  Blocks: ${C(colors.bright)}${Number(
      this.metrics.blocks || 0,
    ).toLocaleString()}${C(colors.reset)}`;

    dashboard += ` / ${Number(this.metrics.headers || 0).toLocaleString()}`;

    if ((this.metrics.blocks || 0) < (this.metrics.headers || 0)) {
      const behind = (this.metrics.headers || 0) - (this.metrics.blocks || 0);
      dashboard += ` ${C(colors.yellow)}(${Number(behind).toLocaleString()} behind)${C(colors.reset)}`;
    }
    dashboard += "\n";

    const chikun = this.getChikunFrame();

    dashboard += `  Time Since Last Block: ${C(colors.bright)}${this.formatTime(
      this.metrics.timeSinceLastBlock || 0,
    )}${C(colors.reset)}${chikun ? `  ${chikun}` : ""}`;

    dashboard += `\n  Difficulty: ${C(colors.bright)}${this.formatNumber(
      this.metrics.difficulty || 0,
    )}${C(colors.reset)}\n`;

    dashboard += `  Chain Size: ${C(colors.bright)}${this.formatBytes(
      this.metrics.chainSize || 0,
    )}${C(colors.reset)}\n`;

    dashboard += `  Current Supply: ${C(colors.bright)}${Number(
      this.metrics.circulatingSupply || 0,
    ).toLocaleString()}${C(colors.reset)} LTC\n`;

    dashboard += `  Block Reward: ${C(colors.bright)}${(this.metrics.blockReward || 0).toFixed(2)}${C(colors.reset)} LTC\n`;

    dashboard += `  Next Halving: ${C(colors.bright)}${Number(
      this.metrics.nextHalvingBlock || 0,
    ).toLocaleString()}${C(colors.reset)} (${this.metrics.estimatedHalvingDate || "N/A"})\n`;

    const currentCycleProgress =
      (((this.metrics.blocks || 0) % 840000) / 840000) * 100;
    dashboard += `  Halving Cycle Progress: ${C(colors.bright)}${currentCycleProgress.toFixed(
      2,
    )}%${C(colors.reset)}\n`;

    dashboard += `  Block Times (20): ⏱️  Min ${this.metrics.blockIntervals.min}s`;

    dashboard += ` | Max ${this.metrics.blockIntervals.max}s`;

    dashboard += ` | Med ${this.metrics.blockIntervals.median}s\n`;

    dashboard += `  Chain Tips: ${C(colors.bright)}${this.metrics.chainTips.totalTips}${C(colors.reset)}`;

    dashboard += ` | Orphans: ${C(colors.bright)}${this.metrics.chainTips.orphanCount}${C(colors.reset)}`;
    if (this.metrics.chainTips.hasForks) {
      dashboard += ` ${C(colors.red)}[⚠ Fork detected]${C(colors.reset)}`;
    }
    const bd = this.metrics.chainTips.breakdown || {};

    dashboard += ` ${C(colors.dim)}(active:${bd["active"] || 0}, vf:${bd["valid-fork"] || 0}, vh:${bd["valid-headers"] || 0})${C(colors.reset)}\n`;

    dashboard += `\n${C(colors.cyan)}🌐 NETWORK${C(colors.reset)}\n`;

    dashboard += `  Connections: ${this.getConnectionColor(
      this.metrics.connections || 0,
    )}${this.metrics.connections || 0}${C(colors.reset)}`;

    dashboard += ` (↓${this.metrics.inbound || 0} ↑${this.metrics.outbound || 0})\n`;

    dashboard += `  Hashrate: ${C(colors.bright)}${this.formatHashrate(
      this.metrics.networkhashps || 0,
    )}${C(colors.reset)}\n`;

    dashboard += `  Version: ${C(colors.dim)}${this.metrics.version || ""
      }${C(colors.reset)}\n`;

    dashboard += `  Avg. Peer Ping: ${C(colors.bright)}${this.getAveragePing()}${C(colors.reset)}\n`;

    dashboard += `\n${C(colors.cyan)}💾 MEMPOOL${C(colors.reset)}\n`;

    dashboard += `  Transactions: ${C(colors.bright)}${Number(
      this.metrics.mempool || 0,
    ).toLocaleString()}${C(colors.reset)}\n`;

    dashboard += `  Size: ${C(colors.bright)}${this.formatBytes(
      this.metrics.mempoolSize || 0,
    )}${C(colors.reset)}\n`;

    dashboard += `  Fees: ${C(colors.bright)}${(
      this.metrics.mempoolFees || 0
    ).toFixed(8)} LTC${C(colors.reset)}\n`;
    if ((this.metrics.mempool || 0) > 0) {
      const avgFee =
        (this.metrics.mempoolFees || 0) / (this.metrics.mempool || 1);
      dashboard += `  Avg. Fee: ${C(colors.bright)}${avgFee.toFixed(8)} LTC${C(
        colors.reset,
      )}\n`;
    }

    dashboard += `\n${C(colors.cyan)}📊 BANDWIDTH${C(colors.reset)}\n`;

    dashboard += `  Upload: ${C(colors.blue)}↑ ${this.formatBytes(
      this.metrics.uploadSpeed || 0,
    )}/s${C(colors.reset)} (Peak: ${this.formatBytes(
      this.history.maxUploadSpeed || 0,
    )}/s | Total: ${this.formatBytes(this.metrics.totalUploaded)})\n`;

    dashboard += `  Download: ${C(colors.green)}↓ ${this.formatBytes(
      this.metrics.downloadSpeed || 0,
    )}/s${C(colors.reset)} (Peak: ${this.formatBytes(
      this.history.maxDownloadSpeed || 0,
    )}/s | Total: ${this.formatBytes(this.metrics.totalDownloaded)})\n`;

    if (this.metrics.feeEstimate.fast != null) {
      const f = ltcPerKvBToLitoshiPerVb(this.metrics.feeEstimate.fast);
      const m = ltcPerKvBToLitoshiPerVb(this.metrics.feeEstimate.medium);
      const s = ltcPerKvBToLitoshiPerVb(this.metrics.feeEstimate.slow);

      dashboard += `\n${C(colors.cyan)}💰 FEE ESTIMATES${C(colors.reset)} (litoshi/vB)\n`;

      dashboard += `  Fast (2 blocks): ${C(colors.bright)}${f}${C(colors.reset)}\n`;

      dashboard += `  Medium (6 blocks): ${C(colors.bright)}${m}${C(colors.reset)}\n`;

      dashboard += `  Slow (12 blocks): ${C(colors.bright)}${s}${C(colors.reset)}\n`;
    }

    if ((this.metrics.nodeUptime || 0) > 0) {
      dashboard += `\n${C(colors.cyan)}⏰ UPTIME${C(colors.reset)}\n`;

      dashboard += `  Node: ${C(colors.bright)}${this.formatTime(
        this.metrics.nodeUptime || 0,
      )}${C(colors.reset)}\n`;

      dashboard += `  Monitor: ${C(colors.bright)}${this.formatTime(
        (Date.now() - this.history.startTime) / 1000,
      )}${C(colors.reset)}\n`;
    }

    return dashboard;
  }

  getPeersTable() {
    if (!this.metrics.peers || this.metrics.peers.length === 0) return "";

    let table = `\n${C(colors.cyan)}👥 TOP 5 PEERS ${C(colors.reset)}(by ping)\n`;
    table += `${C(colors.dim)}${"─".repeat(70)}${C(colors.reset)}\n`;

    const topPeers = this.metrics.peers
      .slice()
      .sort((a, b) => {
        if (a.inbound !== b.inbound) {
          return a.inbound ? 1 : -1;
        }

        // Sort by pingtime (lower is better)
        const pingA = typeof a.pingtime === "number" ? a.pingtime : Infinity;
        const pingB = typeof b.pingtime === "number" ? b.pingtime : Infinity;
        return pingA - pingB;
      })
      .slice(0, 5);

    topPeers.forEach((peer) => {
      const direction = peer.inbound ? "↓" : "↑";
      const ping = peer.pingtime
        ? `${(peer.pingtime * 1000).toFixed(0)}ms`
        : "N/A";
      const addr = this.truncateAddr(peer.addr || "", 22).padEnd(22);
      const ver = (peer.subver || "").split(":")[0];

      table += `  ${direction} ${addr} Block: ${String(
        peer.synced_blocks || 0,
      ).padEnd(7)} Ping: ${String(ping).padEnd(6)} ${ver}\n`;
    });

    return table;
  }

  truncateAddr(a, width) {
    if (!a) return "";
    if (a.length <= width) return a;
    const head = Math.max(0, Math.floor(width * 0.6) - 1);
    const tail = Math.max(0, width - head - 1);
    return a.slice(0, head) + "…" + a.slice(-tail);
  }

  getFooter() {
    const tips = [
      "TIP: Buy gift cards with Litecoin on SpendCrypto: https://spendcrypto.com",
      "TIP: Litecoin block time is 2.5 minutes vs Bitcoin's 10 minutes",
      "TIP: Maximum supply is 84 million LTC",
      "TIP: Litecoin uses Scrypt algorithm for mining",
      "TIP: Litecoin activated SegWit before Bitcoin",
      "TIP: MWEB provides optional privacy for Litecoin",
      'TIP: Litecoin is often called "Digital Silver"',
      "TIP: Litecoin was created in 2011 by Charlie Lee",
      "TIP: One of the longest-running cryptocurrencies",
      "TIP: Litecoin's code is based on the Bitcoin protocol but has key differences, such as a faster block time and a different hashing algorithm.",
      "TIP: A Litecoin address typically begins with the letter 'L', 'M', or '3'.",
      'TIP: As a "fork" of Bitcoin, Litecoin shares technical similarities but operates on its own independent blockchain.',
      "TIP: The Litecoin network has been operating with a high level of security and uptime for over a decade.",
      "TIP: The total number of Litecoins in circulation will never exceed 84 million.",
      "TIP: Litecoin can be divided into units as small as 0.00000001 LTC.",
      "TIP: The block reward started at 50 LTC and is halved approximately every four years.",
      "TIP: Litecoin is often used as a testing ground for potential Bitcoin upgrades, as its faster block time allows for quicker testing.",
      "TIP: An example of this was the SegWit security test, where Charlie Lee put $1 million in LTC into a SegWit wallet and publicly challenged anyone to steal it.",
      "TIP: Litecoin's halving event, which cuts the block reward in half, occurs approximately every four years, or every 840,000 blocks.",
      "TIP: The Litecoin Foundation is a non-profit organization that supports the development and promotion of Litecoin.",
      "TIP: The Lightning Network allows for fast, low-cost off-chain Litecoin payments.",
      'TIP: The name "Litecoin" comes from its goal to be a "lite" or faster version of Bitcoin.',
      "TIP: In 2017, Litecoin was the first major cryptocurrency to successfully implement SegWit (Segregated Witness).",
      "TIP: MWEB (Mimblewimble Extension Blocks), which provides optional confidentiality for transactions, was activated on the network in May 2022.",
      "TIP: The official ticker symbol for Litecoin is LTC.",
      "TIP: Trade Litecoin non-custodially with P2P trading on LocalCoinSwap: https://localcoinswap.com",
    ];

    const tip = tips[Math.floor((this.frames / 10) % tips.length)];
    let footer = `\n${C(colors.dim)}${"─".repeat(70)}${C(colors.reset)}\n`;
    footer += `${C(colors.yellow)}💡 ${tip}${C(colors.reset)} ${C(
      colors.dim,
    )}Ctrl+C to quit${C(colors.reset)}`;
    return footer;
  }

  getProgressBar(percent, width) {
    const termCols = process.stdout.columns || 80;
    const w = width || Math.max(10, Math.min(40, termCols - 50));
    const p = Math.max(0, Math.min(100, percent || 0));
    const filled = Math.floor((p / 100) * w);
    const empty = w - filled;
    let bar = C(colors.green);
    bar += "█".repeat(filled);
    bar += C(colors.dim) + "░".repeat(empty) + C(colors.reset);
    return `[${bar}]`;
  }

  getConnectionColor(connections) {
    if (connections === 0) return C(colors.red);
    if (connections < 5) return C(colors.yellow);
    return C(colors.green);
  }

  formatNumber(num) {
    const n = Number(num || 0);
    if (n >= 1e12) return (n / 1e12).toFixed(2) + "T";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + "K";
    return n.toFixed(2);
  }

  formatHashrate(hashrate) {
    const n = Number(hashrate || 0);
    if (n >= 1e18) return (n / 1e18).toFixed(2) + " EH/s";
    if (n >= 1e15) return (n / 1e15).toFixed(2) + " PH/s";
    if (n >= 1e12) return (n / 1e12).toFixed(2) + " TH/s";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + " GH/s";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + " MH/s";
    if (n >= 1e3) return (n / 1e3).toFixed(2) + " KH/s";
    return n.toFixed(2) + " H/s";
  }

  formatBytes(bytes) {
    const isBig = typeof bytes === "bigint";
    const n = isBig ? bytes : BigInt(Math.max(0, Number(bytes || 0)));
    if (n === 0n) return "0 B";
    const k = 1024n, units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
    let u = 0; let val = n;
    while (val >= k && u < units.length - 1) { val /= k; u++; }
    return `${Number(val).toFixed(2)} ${units[u]}`; // safe: val already scaled
  }

  formatTime(seconds) {
    const s = Math.max(0, Math.floor(Number(seconds || 0)));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
    if (s < 86400) {
      const hours = Math.floor(s / 3600);
      const mins = Math.floor((s % 3600) / 60);
      return hours + "h " + mins + "m";
    }
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    return days + "d " + hours + "h";
  }

  triggerChikun() {
    this.chikun.active = true;
    this.chikun.start = Date.now();
  }

  getChikunFrame() {
    if (!this.chikun.active) return "";
    const elapsed = Date.now() - this.chikun.start;
    const frames =
      this.chikun.frames && this.chikun.frames.length
        ? this.chikun.frames
        : this.buildChikunFrames();
    const frameLen = this.chikun.frameLen || 250; // ms per frame
    const idx = Math.floor(elapsed / frameLen);
    if (idx >= frames.length) {
      this.chikun.active = false;
      return "";
    }
    return frames[idx];
  }

  buildChikunFrames() {
    const frames = [];
    const pad = (n) => " ".repeat(Math.max(0, n));
    const termCols = Math.max(50, Math.min(180, process.stdout.columns || 80));

    // Keep headroom so long emoji lines don't wrap in narrower terminals
    const walkWidth = Math.max(
      14,
      Math.min(28, Math.floor((termCols - 42) / 2)),
    );
    const origin = 2; // slight left margin so sparkles can appear before the egg

    // Helpers
    const pushN = (s, n) => {
      for (let i = 0; i < n; i++) frames.push(s);
    };
    const easeInOut = (t) =>
      t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    // Stage 1: Ambient twinkle
    const eggPos = origin + Math.floor(walkWidth * 0.2);
    const prelude = [
      `${pad(eggPos - 2)}✨ ${pad(1)}🥚 ${pad(1)}✨`,
      `${pad(eggPos - 1)}✨ 🥚 ✨`,
      `${pad(eggPos)}🥚 ✨`,
      `${pad(eggPos - 1)}✨ 🥚 ✨`,
    ];
    prelude.forEach((f) => pushN(f, 1));

    // Stage 2: Rock + Crack buildup
    pushN(`${pad(eggPos)}🥚`, 1);
    pushN(`${pad(eggPos - 1)}✨🥚✨`, 1);
    pushN(`${pad(eggPos)}🥚💥`, 1);
    pushN(`${pad(eggPos - 1)}💥🥚💥`, 1);
    pushN(`${pad(eggPos)}🥚💥✨`, 1);
    pushN(`${pad(eggPos - 1)}✨💥🥚💥✨`, 1);

    // Stage 3: Hatch reveal with confetti
    pushN(`${pad(eggPos)}🐣✨`, 2);
    pushN(`${pad(eggPos)}🐥✨`, 2);
    pushN(`${pad(eggPos)}🐥`, 2);

    // Stage 4: Hero walk (eased) with wing/step cycle and spark trail
    const walkFrames = 20;
    let fp1 = eggPos,
      fp2 = eggPos;
    for (let k = 0; k < walkFrames; k++) {
      const t = k / (walkFrames - 1);
      const pos = origin + Math.round(walkWidth * easeInOut(t));

      // Gait: flap → step → plain loop
      const base = k % 7 === 3 ? "🐤" : "🐥";
      const gait = k % 3 === 0 ? `${base}🪽` : k % 2 === 0 ? `${base}🐾` : base;

      // Decorative trail: sparkles tapering behind
      const trail = k % 4 === 0 ? "✨" : "";

      const marks = [];
      if (trail) marks.push({ pos: Math.max(origin, pos - 4), glyph: trail });
      if (fp2 < pos - 1) marks.push({ pos: fp2, glyph: "🐾" });
      if (fp1 < pos - 1) marks.push({ pos: fp1, glyph: "🐾" });
      marks.push({ pos, glyph: gait });

      marks.sort((a, b) => a.pos - b.pos);
      let line = "";
      let cursor = 0;
      for (const m of marks) {
        line += pad(m.pos - cursor) + m.glyph;
        cursor = m.pos + 2;
      }
      frames.push(line);

      fp2 = fp1;
      fp1 = pos - 1;
    }

    // Stage 5: Victory dash & finale burst
    const end = origin + walkWidth + 1;
    pushN(`${pad(end)}🐥💨`, 1);
    pushN(`${pad(end + 1)}💨✨`, 1);
    pushN(`${pad(end + 2)}✨🎉✨`, 1);
    pushN(`${pad(end + 3)}`, 1);

    // Normalize to ~40 frames (~10s at 250ms each)
    const target = 40;
    if (frames.length > target) return frames.slice(0, target);
    while (frames.length < target) frames.push(`${pad(end + 3)}`);
    return frames;
  }

  getAveragePing() {
    if (!this.metrics.peers || this.metrics.peers.length === 0) return "N/A";
    const totalPing = this.metrics.peers.reduce(
      (sum, p) => sum + (p.pingtime || 0),
      0,
    );
    const avgPing = totalPing / this.metrics.peers.length;
    return `${(avgPing * 1000).toFixed(0)}ms`;
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  cleanup() {
    // stop chikun
    this.chikun.active = false;
    if (isTTY && this._cursorHidden) {
      process.stdout.write("\x1b[?25h");
      this._cursorHidden = false;
    }

    process.stdout.write("\n\n🛑 Stopping monitor...\n");
    if (this.displayInterval) clearInterval(this.displayInterval);

    process.stdout.write(
      `\n${C(colors.cyan)}📊 SESSION STATS${C(colors.reset)}\n`,
    );
    process.stdout.write(
      `${C(colors.dim)}${"─".repeat(70)}${C(colors.reset)}\n`,
    );

    const runtime = (Date.now() - this.history.startTime) / 1000;
    const blocksProcessed =
      (this.metrics.blocks || 0) - (this.history.syncStartBlock || 0);

    process.stdout.write(
      `  Runtime: ${C(colors.bright)}${this.formatTime(runtime)}${C(colors.reset)}\n`,
    );
    process.stdout.write(
      `  Blocks Processed: ${C(colors.bright)}${Number(blocksProcessed).toLocaleString()}${C(colors.reset)}\n`,
    );
    process.stdout.write(
      `  Total Downloaded: ${C(colors.bright)}${this.formatBytes(
        this.metrics.totalDownloaded,
      )}${C(colors.reset)}\n`,
    );
    process.stdout.write(
      `  Total Uploaded: ${C(colors.bright)}${this.formatBytes(
        this.metrics.totalUploaded,
      )}${C(colors.reset)}\n`,
    );
    process.stdout.write(
      `  Peak Connections: ${C(colors.bright)}${this.history.maxConnections}${C(
        colors.reset,
      )}\n`,
    );
    process.stdout.write(
      `  Peak Download Speed: ${C(colors.bright)}${this.formatBytes(
        this.history.maxDownloadSpeed,
      )}/s${C(colors.reset)}\n`,
    );
    process.stdout.write(
      `  Peak Upload Speed: ${C(colors.bright)}${this.formatBytes(
        this.history.maxUploadSpeed,
      )}/s${C(colors.reset)}\n`,
    );

    if (blocksProcessed > 0 && runtime > 0) {
      const blocksPerSecond = blocksProcessed / runtime;
      process.stdout.write(
        `  Avg Sync Speed: ${C(colors.bright)}${blocksPerSecond.toFixed(
          2,
        )} blocks/s${C(colors.reset)}\n`,
      );
    }

    process.stdout.write(
      `\n${C(colors.green)}✅ Monitor stopped successfully${C(colors.reset)}\n`,
    );
    process.stdout.write(
      `${C(colors.yellow)}Thanks for using Litecoin Node Monitor! 🚀${C(
        colors.reset,
      )}\n`,
    );

    process.exit(0);
  }
}

async function main() {
  try {
    const monitor = new LitecoinNodeMonitor();
    await monitor.init();
  } catch (error) {
    if (isTTY) process.stdout.write("\x1b[?25h");
    console.error(
      `${C(colors.red)}❌ Fatal Error: ${error.message}${C(colors.reset)}`,
    );
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
