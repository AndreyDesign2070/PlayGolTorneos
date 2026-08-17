import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";
import mqtt from "mqtt";

const MQTT_BROKER = "wss://broker.hivemq.com:8884/mqtt";
const APP_ID = "184d974d-929a-4d47-812c-35e4e28a3f4a";
const TOPIC_ACTION = `playgol/v2/action/${APP_ID}`;
const TOPIC_SYNC = `playgol/v2/sync/${APP_ID}`;
const TOPIC_NOTIF = `playgol/v2/notif/${APP_ID}`;
const TOPIC_REQ = `playgol/v2/req/${APP_ID}`;

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

  // Connect to Cloud Realtime MQTT broker for universal 1:1 cross-device synchronization
  let mqttClient: mqtt.MqttClient | null = null;
  try {
    mqttClient = mqtt.connect(MQTT_BROKER, {
      clientId: `server-${Date.now()}`,
      clean: true,
      reconnectPeriod: 2000,
      keepalive: 30
    });

    mqttClient.on("connect", () => {
      console.log("Server connected to MQTT Cloud Broker");
      mqttClient?.subscribe([TOPIC_ACTION, TOPIC_SYNC, TOPIC_NOTIF, TOPIC_REQ], { qos: 1 });

      // Publish initial state to retain topic if data.json exists
      const current = readState();
      if (current.tournaments.length > 0) {
        mqttClient?.publish(
          TOPIC_SYNC,
          JSON.stringify({
            teams: current.teams,
            tournaments: current.tournaments,
            matches: current.matches,
            notifications: current.notifications,
            timestamp: Date.now(),
            senderId: "server"
          }),
          { retain: true, qos: 1 }
        );
      }
    });

    mqttClient.on("message", (topic, msg) => {
      try {
        const payload = JSON.parse(msg.toString());
        if (topic === TOPIC_REQ && payload && payload.type === "REQUEST_SYNC") {
          const current = readState();
          if (current.tournaments.length > 0) {
            mqttClient?.publish(
              TOPIC_SYNC,
              JSON.stringify({
                teams: current.teams,
                tournaments: current.tournaments,
                matches: current.matches,
                notifications: current.notifications,
                timestamp: Date.now(),
                senderId: "server"
              }),
              { retain: false, qos: 1 }
            );
          }
        } else if (topic === TOPIC_ACTION && payload && payload.action) {
          const action = payload.action;
          const current = readState();
          let modified = false;
          let notifToSend = null;

          if (action.type === "MATCH_SCORE_UPDATE") {
            current.matches = current.matches.map((m: any) => {
              if (m.id === action.matchId) {
                return {
                  ...m,
                  scoreA: action.scoreA,
                  scoreB: action.scoreB,
                  penaltiesA: action.penaltiesA ?? m.penaltiesA,
                  penaltiesB: action.penaltiesB ?? m.penaltiesB,
                  played: action.played
                };
              }
              return m;
            });
            modified = true;
          } else if (action.type === "MATCHES_UPDATE" && Array.isArray(action.matches)) {
            const updateMap = new Map(action.matches.map((m: any) => [m.id, m]));
            current.matches = current.matches.map((m: any) => updateMap.get(m.id) || m);
            // Append any brand new matches
            action.matches.forEach((m: any) => {
              if (!current.matches.some((cm: any) => cm.id === m.id)) {
                current.matches.push(m);
              }
            });
            modified = true;
          } else if (action.type === "TOURNAMENT_CREATE" && action.tournament) {
            if (!current.tournaments.some((t: any) => t.id === action.tournament.id)) {
              current.tournaments = [action.tournament, ...current.tournaments];
              if (Array.isArray(action.matches)) {
                current.matches = [...current.matches, ...action.matches];
              }
              modified = true;
            }
          } else if (action.type === "TOURNAMENT_UPDATE" && action.tournament) {
            current.tournaments = current.tournaments.map((t: any) => t.id === action.tournament.id ? action.tournament : t);
            modified = true;
          } else if (action.type === "TOURNAMENT_DELETE" && action.tournamentId) {
            current.tournaments = current.tournaments.filter((t: any) => t.id !== action.tournamentId);
            current.matches = current.matches.filter((m: any) => m.tournamentId !== action.tournamentId);
            modified = true;
          } else if (action.type === "TEAM_CREATE" && action.team) {
            if (!current.teams.some((t: any) => t.id === action.team.id)) {
              current.teams = [...current.teams, action.team];
              modified = true;
            }
          } else if (action.type === "TEAM_UPDATE" && action.team) {
            current.teams = current.teams.map((t: any) => t.id === action.team.id ? action.team : t);
            modified = true;
          } else if (action.type === "TEAM_DELETE" && action.teamId) {
            current.teams = current.teams.filter((t: any) => t.id !== action.teamId);
            modified = true;
          }

          if (action.notifText) {
            notifToSend = {
              id: `notif-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              text: action.notifText,
              timestamp: Date.now(),
              tournamentId: action.tournamentId
            };
            current.notifications = [notifToSend, ...(current.notifications || [])].slice(0, 50);
            modified = true;
          }

          if (modified) {
            writeState(current);
            broadcastState(current, notifToSend);
          }
        } else if (topic === TOPIC_SYNC && payload && payload.tournaments) {
          if (payload.senderId !== "server") {
            const newState = {
              teams: payload.teams || [],
              tournaments: payload.tournaments || [],
              matches: payload.matches || [],
              notifications: payload.notifications || []
            };
            writeState(newState);
            broadcastState(newState, payload.notification);
          }
        }
      } catch (err) {}
    });
  } catch (err) {
    console.warn("MQTT server init:", err);
  }

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

      if (mqttClient && mqttClient.connected) {
        mqttClient.publish(
          TOPIC_SYNC,
          JSON.stringify({
            ...fullState,
            notification,
            timestamp: Date.now(),
            senderId: "server"
          }),
          { retain: true, qos: 1 }
        );
      }

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

    if (mqttClient && mqttClient.connected) {
      mqttClient.publish(
        TOPIC_SYNC,
        JSON.stringify({
          ...state,
          notification,
          timestamp: Date.now(),
          senderId: "server"
        }),
        { retain: true, qos: 1 }
      );
      mqttClient.publish(TOPIC_NOTIF, JSON.stringify(notification), { qos: 1 });
    }

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
