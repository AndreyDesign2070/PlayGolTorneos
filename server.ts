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
        return JSON.parse(raw);
      }
    } catch (e) {
      console.error("Error reading data file:", e);
    }
    return { teams: [], tournaments: [], matches: [] };
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

  // API Routes
  app.get("/api/state", (req, res) => {
    const state = readState();
    res.json(state);
  });

  app.post("/api/state", (req, res) => {
    const { teams, tournaments, matches } = req.body;
    if (!Array.isArray(teams) || !Array.isArray(tournaments) || !Array.isArray(matches)) {
      return res.status(400).json({ error: "Invalid state structure" });
    }
    const success = writeState({ teams, tournaments, matches });
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
