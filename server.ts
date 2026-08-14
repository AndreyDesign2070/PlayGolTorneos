import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;
  const DATA_FILE = path.join(process.cwd(), "data.json");

  // Middlewares
  app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
    next();
  });
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  // Helper to read state
  const readState = () => {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const raw = fs.readFileSync(DATA_FILE, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          teams: parsed.teams || [],
          tournaments: parsed.tournaments || [],
          matches: parsed.matches || [],
          notifications: parsed.notifications || []
        };
      }
    } catch (e) {
      console.error("Error reading data file:", e);
    }
    return { teams: [], tournaments: [], matches: [], notifications: [] };
  };

  // Helper to write state
  const writeState = (state: any) => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf-8");
      return true;
    } catch (e) {
      console.error("Error writing data file:", e);
      return false;
    }
  };

  // Active SSE Clients for 1:1 real-time sync across computers, mobile, admins and visitors
  const sseClients = new Set<express.Response>();

  const broadcastState = (state: any, specificNotification?: any) => {
    const payload = JSON.stringify({ state, notification: specificNotification, timestamp: Date.now() });
    for (const client of sseClients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch (err) {
        sseClients.delete(client);
      }
    }
  };

  // Heartbeat every 15 seconds to keep SSE streams alive on mobile networks
  setInterval(() => {
    for (const client of sseClients) {
      try {
        client.write(`: heartbeat\n\n`);
      } catch (err) {
        sseClients.delete(client);
      }
    }
  }, 15000);

  // Static Assets for PWA and Standalone App shortcut icon
  app.get("/logo-pg.svg", (req, res) => {
    res.setHeader("Content-Type", "image/svg+xml");
    res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="100" fill="#020617" stroke="#1e293b" stroke-width="12"/>
  <text x="50%" y="63%" font-family="system-ui, -apple-system, sans-serif" font-weight="900" font-size="250" text-anchor="middle" letter-spacing="-15">
    <tspan fill="#ffffff">P</tspan><tspan fill="#10b981">G</tspan>
  </text>
</svg>`);
  });

  app.get("/manifest.json", (req, res) => {
    res.json({
      "name": "PlayGol",
      "short_name": "PlayGol",
      "description": "Administración Profesional de Torneos de Fútbol",
      "start_url": "/",
      "display": "standalone",
      "background_color": "#020617",
      "theme_color": "#020617",
      "orientation": "portrait-primary",
      "icons": [
        {
          "src": "/logo-pg.svg",
          "sizes": "512x512",
          "type": "image/svg+xml"
        }
      ]
    });
  });

  // API Routes
  // 1. Real-time Server-Sent Events (SSE) stream for instant 1:1 sync across devices
  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    // Send initial state immediately upon connection
    const initialState = readState();
    res.write(`data: ${JSON.stringify({ state: initialState, timestamp: Date.now() })}\n\n`);

    sseClients.add(res);

    req.on("close", () => {
      sseClients.delete(res);
    });
  });

  // 2. Read full state
  app.get("/api/state", (req, res) => {
    const state = readState();
    res.json(state);
  });

  // 3. Write and broadcast full state
  app.post("/api/state", (req, res) => {
    const { teams, tournaments, matches, notifications, notification } = req.body;
    if (!Array.isArray(teams) || !Array.isArray(tournaments) || !Array.isArray(matches)) {
      return res.status(400).json({ error: "Invalid state structure" });
    }
    const fullState = { 
      teams, 
      tournaments, 
      matches, 
      notifications: Array.isArray(notifications) ? notifications : [] 
    };
    const success = writeState(fullState);
    if (success) {
      // Broadcast real-time 1:1 update to all active devices/visitors immediately
      broadcastState(fullState, notification);
      res.json({ success: true, timestamp: Date.now() });
    } else {
      res.status(500).json({ error: "Failed to save state" });
    }
  });

  // 4. Send specific notification
  app.post("/api/notify", (req, res) => {
    const { notification } = req.body;
    if (!notification || !notification.text) {
      return res.status(400).json({ error: "Invalid notification payload" });
    }
    const state = readState();
    const existingNotifs = Array.isArray(state.notifications) ? state.notifications : [];
    const updatedNotifs = [notification, ...existingNotifs.filter((n: any) => n.id !== notification.id)].slice(0, 50);
    state.notifications = updatedNotifs;
    writeState(state);
    broadcastState(state, notification);
    res.json({ success: true, notifications: updatedNotifs });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
