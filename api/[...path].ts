import type { Request, Response } from "express";
import app from "../artifacts/api-server/src/app";

function handler(req: Request, res: Response): void {
  const url = typeof req.url === "string" ? req.url : "/";
  const [pathname, query = ""] = url.split("?", 2);
  if (!pathname.startsWith("/api")) {
    req.url = `/api${pathname === "/" ? "" : pathname}${query ? `?${query}` : ""}`;
  }
  app(req, res);
}

export = handler;
