import express from "express";
import path from "path";
import fs from "fs";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const PORT = 3000;
  const DATA_FILE = path.join(process.cwd(), "data.json");

  // Middlewares
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
  app.get("/api/state", (req, res) => {
    const state = readState();
    res.json(state);
  });

  app.post("/api/state", (req, res) => {
    const { teams, tournaments, matches, notifications } = req.body;
    if (!Array.isArray(teams) || !Array.isArray(tournaments) || !Array.isArray(matches)) {
      return res.status(400).json({ error: "Invalid state structure" });
    }
    const success = writeState({ 
      teams, 
      tournaments, 
      matches, 
      notifications: Array.isArray(notifications) ? notifications : [] 
    });
    if (success) {
      res.json({ success: true });
    } else {
      res.status(500).json({ error: "Failed to save state" });
    }
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
